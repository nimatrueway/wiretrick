import { describe, it, expect } from "vitest";
import { directEvaluate, makePageEvaluate, servePageEvaluate } from "../src/shared/pageEval";

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

    it("rejects when nothing in the page world answers", async () => {
        const win = fakeWindow();
        await expect(makePageEvaluate(win, 20)(() => 1)).rejects.toThrow(/page world didn't answer/);
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
