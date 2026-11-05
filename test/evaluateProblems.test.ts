import { describe, expect, it } from "vitest";
import { evaluateProblems } from "../src/shared/compile";

describe("evaluateProblems", () => {
    it("flags the script's variables a ctx.evaluate function uses (also in a template's ${…})", () => {
        const code = `import { GUI, params as p } from "./lib";
const cfg = wt.params({});
const pageStore = wt.pageStore("s", { a: 1 });
wt.onPage("*://a/*", () => {});
wt.onPage({ url: "*://a/*" }, (ctx) => {
    const callback = { set: (c: boolean) => {} };
    ctx.evaluate((args) => {
        const re = new URLPattern(\`wss://x\${cfg.env}:1/ws\`);
        args.set(true);
        pageStore.a = 2;
        return { cfg: 1, x: (window as any).cfg };
    }, callback);
});`;
        const out = evaluateProblems(code);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/^onPage #2: ctx\.evaluate's function uses `cfg`, `pageStore` from your script/);
        expect(out[0]).toContain("ctx.evaluate((cfg) => …, cfg)");
    });

    it("parameters, own locals, globals, properties, keys and type annotations are fine", () => {
        const code = `type Cfg = { port: number };
const port = 1, name = "x";
const { env } = wt.params({});
function helper() {}
wt.onPage("*://a/*", async (ctx) => {
    await ctx.evaluate((port: number, cfg: Cfg) => {
        const name = document.title;
        function helper() {}
        helper();
        return { port, env: 1, n: name, w: window.location.port, k: cfg.port };
    }, port, { port });
    await ctx.evaluate(function (env) { return env; }, env);
});`;
        expect(evaluateProblems(code)).toEqual([]);
    });

    it("destructured and imported names count", () => {
        const code = `import * as lib from "./lib";
const { env, port: p } = wt.params({});
wt.onPage("*://a/*", (ctx) => ctx.evaluate(() => [env, p, lib.x]));`;
        expect(evaluateProblems(code)[0]).toMatch(/uses `env`, `p`, `lib`/);
    });
});

describe("evaluateProblems in .tsx", () => {
    it("JSX's `/>` after `}` isn't a regex", () => {
        const code = `const cfg = wt.params({});
wt.onPage("*://a/*", () => {
    mount(() => <Label port={cfg.port} />, { position: "x" });
});
wt.onPage("*://a/*", (ctx) => ctx.evaluate(() => 1));`;
        expect(evaluateProblems(code)).toEqual([]);
    });
});
