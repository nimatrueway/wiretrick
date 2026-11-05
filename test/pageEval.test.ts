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
        await expect(evaluate(() => secret)).rejects.toThrow(/secret is not defined/);
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
        await expect(evaluate((f: unknown) => f, () => 1)).rejects.toThrow(/arguments must be plain data/);
        await expect(evaluate(() => () => 1)).rejects.toThrow(/result must be plain data/);
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
