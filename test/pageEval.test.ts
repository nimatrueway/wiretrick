import { describe, it, expect } from "vitest";
import { directEvaluate, evalModule, makePageEvaluate, servePageEvaluate, type EvalModule } from "../src/shared/pageEval";
import { evalCaptures } from "../src/shared/evalCapture";
import { makeLibRequire, type ShippedLib } from "../src/shared/scriptImports";
import { scriptFunction } from "../src/shared/scriptFn";
import { toRunnableJs } from "../src/shared/compile";
import "../src/shared/transpile";

/** a window whose postMessage delivers a structured clone to its listeners (both worlds share it) */
function fakeWindow(): Window {
    const w = new EventTarget() as any;
    w.postMessage = (data: unknown) => {
        const copy = structuredClone(data);
        setTimeout(() => w.dispatchEvent(Object.assign(new Event("message"), { data: copy, source: w })));
    };
    return w;
}

describe("ctx.evaluate", () => {
    const setup = (ackMs?: number) => {
        const win = fakeWindow();
        servePageEvaluate(win);
        return { win, evaluate: makePageEvaluate(win, ackMs) };
    };

    it("runs the function in the page world with copied arguments, awaiting a promise", async () => {
        const { evaluate } = setup();
        (globalThis as any).__pageApp = { user: { name: "ada" } };
        try {
            expect(await evaluate(() => (globalThis as any).__pageApp.user.name)).toBe("ada");
        } finally {
            delete (globalThis as any).__pageApp;
        }
        expect(await evaluate((a: number, b: { n: number }) => a + b.n, 2, { n: 3 })).toBe(5);
        expect(await evaluate(async (s: string) => s.toUpperCase(), "x")).toBe("X");
    });

    it("runs the function's source, not a closure: outer variables aren't there", async () => {
        const { evaluate } = setup();
        const secret = 42;
        await expect(evaluate(() => secret)).rejects.toThrow(/`secret` isn.t defined in the page world/);
    });

    it("a script's ?. and ?? survive transpiling: no module helpers the page lacks", async () => {
        const { evaluate } = setup();
        const js = toRunnableJs(`export const f = (o: any) => o?.a?.[0] ?? "none";\nclass A { x = 1 }`);
        expect(js).not.toMatch(/_optionalChain|_nullishCoalesce/);
        const f = new Function("exports", js + "\nreturn exports.f;")({});
        expect(await evaluate(f, { a: ["x"] })).toBe("x");
        expect(await evaluate(f, {})).toBe("none");
    });

    it("rejects with what the function threw", async () => {
        const { evaluate } = setup();
        const e: Error = await evaluate(() => {
            throw new TypeError("nope");
        }).then(() => new Error("resolved"), (x: Error) => x);
        expect(e.name).toBe("TypeError");
        expect(e.message).toBe("nope");
    });

    it("says when the page's CSP forbids eval", async () => {
        const { evaluate } = setup();
        await expect(
            evaluate(() => {
                throw new EvalError("Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source");
            })
        ).rejects.toThrow(/Content-Security-Policy forbids running code in the page world/);
    });

    it("wants a function, plain-data arguments and a plain-data result", async () => {
        const { evaluate } = setup();
        await expect(evaluate("document.title")).rejects.toThrow(/pass a function/);
        await expect(evaluate((f: unknown) => f, new WeakMap())).rejects.toThrow(/arguments must be plain data/);
        await expect(evaluate(() => () => 1)).rejects.toThrow(/result must be plain data/);
    });

    it("function arguments are callbacks: the page calls them, they run here — also after fn returned", async () => {
        const { evaluate } = setup();
        const page = new EventTarget();
        (globalThis as any).__pageApp = page;
        const got: unknown[] = [];
        try {
            const r = await evaluate(
                (set: (name: string, n: number) => void, done: () => void) => {
                    const app = (globalThis as any).__pageApp as EventTarget;
                    set("first", 1);
                    app.addEventListener("user", (e: any) => set(e.detail, 2));
                    app.addEventListener("bye", () => done());
                    return "subscribed";
                },
                (name: string, n: number) => got.push([name, n]),
                () => got.push("done")
            );
            expect(r).toBe("subscribed");
            expect(got).toEqual([["first", 1]]);
            page.dispatchEvent(Object.assign(new Event("user"), { detail: "ada" }));
            page.dispatchEvent(new Event("bye"));
            await new Promise((r) => setTimeout(r, 10));
            expect(got).toEqual([["first", 1], ["ada", 2], "done"]);
        } finally {
            delete (globalThis as any).__pageApp;
        }
    });

    it("callbacks inside plain objects and arrays work too; the caller's objects are left alone", async () => {
        const { evaluate } = setup();
        const got: unknown[] = [];
        const cb = { set: (c: boolean) => got.push(c), log: () => got.push("log"), n: 1 };
        const list = [(x: number) => got.push(x)];
        expect(await evaluate((o: typeof cb, l: typeof list) => (o.set(true), o.log(), l[0](o.n), typeof o.set), cb, list)).toBe("function");
        await new Promise((r) => setTimeout(r, 10));
        expect(got).toEqual([true, "log", 1]);
        expect(typeof cb.set).toBe("function");
    });

    it("an undefined name says to pass it as an argument", async () => {
        const { evaluate } = setup();
        await expect(evaluate(() => (globalThis as any).eval("cfgMissing.env"))).rejects.toThrow(/`cfgMissing` isn't defined in the page world .* ctx\.evaluate\(\(cfgMissing\) => …, cfgMissing\)/);
    });

    it("a callback whose arguments aren't plain data is the script's problem, not thrown into the page", async () => {
        const win = fakeWindow();
        servePageEvaluate(win);
        const reported: Error[] = [];
        const evaluate = makePageEvaluate(win, undefined, (e) => reported.push(e));
        expect(await evaluate((cb: (x: unknown) => void) => (cb(() => 1), "ok"), () => {})).toBe("ok");
        await new Promise((r) => setTimeout(r, 20));
        expect(reported.map((e) => e.message)).toEqual([expect.stringMatching(/callback's arguments must be plain data/)]);
    });

    it("reports a callback that throws or rejects", async () => {
        const win = fakeWindow();
        servePageEvaluate(win);
        const reported: string[] = [];
        const evaluate = makePageEvaluate(win, undefined, (e) => reported.push(e.message));
        await evaluate(
            (a: () => void, b: () => void) => {
                a();
                b();
            },
            () => {
                throw new Error("sync boom");
            },
            async () => {
                throw new Error("async boom");
            }
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(reported.sort()).toEqual(["async boom", "sync boom"]);
    });

    it("reports its rejections the script leaves unhandled, only its own", async () => {
        const win = fakeWindow();
        servePageEvaluate(win);
        const reported: string[] = [];
        const evaluate = makePageEvaluate(win, undefined, (e) => reported.push(e.message));
        const err = await evaluate(() => {
            throw new Error("left alone");
        }).then(() => null, (e: Error) => e);
        const unhandled = (reason: unknown) => {
            const ev = Object.assign(new Event("unhandledrejection", { cancelable: true }), { reason });
            win.dispatchEvent(ev);
            return ev.defaultPrevented;
        };
        expect(unhandled(err)).toBe(true);
        expect(unhandled(new Error("someone else's"))).toBe(false);
        expect(reported).toEqual(["left alone"]);
    });

    it("rejects when nothing in the page world answers, pointing at the script's call", async () => {
        const win = fakeWindow();
        const e: Error = await makePageEvaluate(win, 20)(() => 1).then(() => new Error("resolved"), (x: Error) => x);
        expect(e.message).toMatch(/nothing in the page world answered, so the function didn't run/);
        expect(String(e.stack).split("\n")[0]).toBe(`Error: ${e.message}`);
        expect(e.stack).toContain("pageEval.test.ts");
    });

    it("a page too busy to answer in time isn't taken for a missing hook (the timer may run before the queued ack)", async () => {
        const { evaluate } = setup(0);
        for (let i = 0; i < 5; i++) expect(await evaluate((n: number) => n * 2, i)).toBe(i * 2);
    });

    it("what the function threw points at the script's call too", async () => {
        const { evaluate } = setup();
        const e: Error = await evaluate(() => {
            throw new RangeError("far");
        }).then(() => new Error("resolved"), (x: Error) => x);
        expect(String(e.stack).split("\n")[0]).toBe("RangeError: far");
        expect(e.stack).toContain("pageEval.test.ts");
    });

    it("a slow function isn't cut off once the page world acknowledged it", async () => {
        const { evaluate } = setup(20);
        expect(await evaluate(() => new Promise((r) => setTimeout(() => r("late"), 60)))).toBe("late");
    });

    it("ignores answers to other calls", async () => {
        const { win, evaluate } = setup();
        const got = evaluate(() => "mine");
        win.postMessage({ source: "wt-page-eval", kind: "done", id: "other", ok: true, value: "forged" }, "*");
        expect(await got).toBe("mine");
    });

    it("page-world code just calls the function", async () => {
        let ran = 0;
        expect(await directEvaluate((n: number) => (ran++, n * 2), 4)).toBe(8);
        expect(ran).toBe(1);
        await expect(directEvaluate(1)).rejects.toThrow(/pass a function/);
    });
});

describe("ctx.evaluate takes the script's top level along", () => {
    const LIB = `export const NAME = "lib";
(globalThis as any).__libRuns = ((globalThis as any).__libRuns || 0) + 1;
export function installHooks() { (globalThis as any).__hooked = ((globalThis as any).__hooked || 0) + 1; }
const tag = (s: string) => "[" + s + "]";
export const viaLib = (evaluate: any) => evaluate(() => tag(NAME) + wt.params({}).who);`;
    const MAIN = `import { installHooks, NAME, viaLib } from "./redux";
let calls = 0;
export const PREFIX = "p:";
const label = (s: string) => PREFIX + s + ":" + NAME;
export const run = (ctx: any, n: number) =>
    ctx.evaluate((n: number) => {
        installHooks();
        console.log("hi", ++calls);
        return label(String(n)) + ":" + wt.params({}).who;
    }, n);
export const lib = (ctx: any) => viaLib(ctx.evaluate);
export const local = (ctx: any) => { const x = 1; return ctx.evaluate(() => x); };`;
    const setup = () => {
        const win = fakeWindow();
        const logs: unknown[][] = [];
        servePageEvaluate(win, {
            wt: (who) => ({ params: () => ({ who: `${who.scriptId}/${who.name}` }) }),
            console: (who) => ({ log: (...a: unknown[]) => logs.push([who.name, ...a]) }),
            libRequire: (libs) => makeLibRequire(libs, (l, require, m) => scriptFunction(l.src!)({}, console, require, m, m.exports)),
        });
        const libJs = toRunnableJs(LIB);
        const libs: ShippedLib[] = [{ name: "redux", src: libJs, params: {}, evals: evalCaptures(libJs) }];
        const js = toRunnableJs(MAIN);
        // the isolated side runs the script (a lib copy of its own)
        const req = makeLibRequire(libs, (l, require, m) => scriptFunction(l.src!)({}, console, require, m, m.exports));
        const m = { exports: {} as any };
        scriptFunction(js)({ params: () => ({}) }, console, req("main"), m, m.exports);
        let mod: EvalModule = evalModule("s1", "main", {}, evalCaptures(js), libs);
        const evaluate = makePageEvaluate(win, undefined, undefined, () => mod);
        return { exports: m.exports, evaluate, logs, reload: () => (mod = evalModule("s1", "main", {}, evalCaptures(js), libs)) };
    };
    const g = globalThis as any;
    const reset = () => {
        delete g.__libRuns;
        delete g.__hooked;
    };

    it("imports, helpers and constants come along; the libraries run once, the declarations per call", async () => {
        reset();
        const { exports, evaluate, logs, reload } = setup();
        const isoRuns = g.__libRuns;
        expect(await exports.run({ evaluate }, 1)).toBe("p:1:lib:s1/main");
        expect(await exports.run({ evaluate }, 2)).toBe("p:2:lib:s1/main");
        expect(g.__libRuns - isoRuns).toBe(1);
        expect(g.__hooked).toBe(2);
        // `calls` is re-declared each time: the page gets its initial value
        expect(logs).toEqual([
            ["main", "hi", 1],
            ["main", "hi", 1],
        ]);
        // a new version of the script: its libraries come again
        reload();
        expect(await exports.run({ evaluate }, 3)).toBe("p:3:lib:s1/main");
        expect(g.__libRuns - isoRuns).toBe(2);
        reset();
    });

    it("a library's function runs with the library's top level and wt", async () => {
        reset();
        const { exports, evaluate } = setup();
        expect(await exports.lib({ evaluate })).toBe("[lib]null/redux");
        reset();
    });

    it("the handler's own variables still don't come along", async () => {
        const { exports, evaluate } = setup();
        await expect(exports.local({ evaluate })).rejects.toThrow(/`x` isn.t defined in the page world .* its handler's variables don't: pass it as an argument/);
    });
});
