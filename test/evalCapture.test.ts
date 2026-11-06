import { describe, expect, it } from "vitest";
import "../src/shared/transpile";
import { toRunnableJs } from "../src/shared/compile";
import { evalCaptures, evaluateProblems } from "../src/shared/evalCapture";

describe("evalCaptures", () => {
    it("ships imports, helpers and consts the function uses, transitively, in source order", () => {
        const js = toRunnableJs(`import { installReduxHooks } from "./redux";
const PREFIX = "wt";
const unrelated = 1;
function key(k: string) { return PREFIX + ":" + k; }
const KEY = key("x");
wt.onPage("*://a/*", (ctx) => {
    ctx.evaluate((opts) => {
        installReduxHooks();
        return KEY + opts.n;
    }, { n: 1 });
});`);
        const [c, ...rest] = evalCaptures(js);
        expect(rest).toEqual([]);
        expect(c.fn).toMatch(/^\(opts\) => \{/);
        expect(c.libs).toBe(true);
        const p = c.prelude;
        expect(p).toContain("require(");
        expect(p).toContain('const PREFIX = "wt"');
        expect(p).not.toContain("unrelated");
        expect(p.indexOf("PREFIX =")).toBeLessThan(p.indexOf("function key"));
        expect(p.indexOf("function key")).toBeLessThan(p.indexOf("KEY = key"));
    });

    it("the function's own parameters and locals, globals and handler locals aren't captured", () => {
        const js = toRunnableJs(`const port = 1;
wt.onPage("*://a/*", (ctx) => {
    const local = 2;
    ctx.evaluate((port: number) => {
        const x = 1;
        return [port, x, window.location.href, local];
    }, port);
});`);
        expect(evalCaptures(js)).toEqual([]);
    });

    it("a named function argument", () => {
        const js = toRunnableJs(`const N = 3;
function run() { return N; }
wt.onPage("*://a/*", (ctx) => ctx.evaluate(run));`);
        const [c] = evalCaptures(js);
        expect(c.fn).toBe("function run() { return N; }");
        expect(c.prelude).toBe("const N = 3;");
        expect(c.libs).toBeUndefined();
    });

    it("a handler local shadowing a top-level name isn't the top-level one", () => {
        const js = toRunnableJs(`const cfg = 1;
wt.onPage("*://a/*", (ctx) => { const cfg = 2; ctx.evaluate(() => cfg); });`);
        expect(evalCaptures(js)).toEqual([]);
    });

    it("exported names (read as exports.x once transpiled) and a destructured evaluate", () => {
        const js = toRunnableJs(`export const A = 1;
export const B = A + 1;
export const run = ({ evaluate }: any) => evaluate(() => B);`);
        const [c] = evalCaptures(js);
        expect(c.prelude).toBe("const A = 1; exports.A = A;\nconst B = exports.A + 1; exports.B = B;");
    });

    it("no ctx.evaluate, or unparsable code: nothing", () => {
        expect(evalCaptures("const a = 1;")).toEqual([]);
        expect(evalCaptures("x.evaluate(() => a; ((")).toEqual([]);
    });
});

describe("evaluateProblems", () => {
    it("flags the handler's variables a ctx.evaluate function uses (also in a template's ${…})", () => {
        const code = `import { GUI } from "./lib";
const cfg = wt.params({});
wt.onPage("*://a/*", () => {});
wt.onPage({ url: "*://a/*" }, (ctx) => {
    const env = "x";
    const callback = { set: (c: boolean) => {} };
    ctx.evaluate((args) => {
        const re = new URLPattern(\`wss://x\${env}:1/ws\${cfg.port}\`);
        args.set(true);
        GUI();
        return ctx.url;
    }, callback);
});`;
        const out = evaluateProblems(code);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/^onPage #2: ctx\.evaluate's function uses `env`, `ctx` from the handler/);
        expect(out[0]).toContain("ctx.evaluate((env) => …, env)");
    });

    it("top-level declarations, imports, parameters, own locals, globals, properties, keys and type annotations are fine", () => {
        const code = `import * as lib from "./lib";
type Cfg = { port: number };
const port = 1, name = "x";
const { env } = wt.params({});
function helper() {}
wt.onPage("*://a/*", async (ctx) => {
    await ctx.evaluate((port: number, cfg: Cfg) => {
        const name = document.title;
        helper();
        return { port, env, n: name, w: window.location.port, k: cfg.port, l: lib.x };
    }, port, { port });
});`;
        expect(evaluateProblems(code)).toEqual([]);
    });

    it("stores and overlay handles don't work in the page", () => {
        const code = `const store = wt.pageStore("s", { a: 1 });
wt.onPage("*://a/*", (ctx) => ctx.evaluate(() => store.a));`;
        const out = evaluateProblems(code);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/^onPage #1: ctx\.evaluate's function uses `store`, but stores and overlay handles/);
    });

    it("JSX's `/>` after `}` isn't a regex", () => {
        const code = `const cfg = wt.params({});
wt.onPage("*://a/*", () => {
    mount(() => <Label port={cfg.port} />, { position: "x" });
});
wt.onPage("*://a/*", (ctx) => ctx.evaluate(() => 1));`;
        expect(evaluateProblems(code)).toEqual([]);
    });
});
