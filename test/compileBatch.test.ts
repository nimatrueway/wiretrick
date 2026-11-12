/**
 * Compiling faster: transpiles are cached by source, the importers of a
 * library compile in one pass, and each importer's deps name the libraries
 * it imports even when another script loaded them first.
 */
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileManyWithLibs, compileScript, compileWithLibs, makeModuleResolver, setTranspiler, toRunnableJs } from "../src/shared/compile";
import { transform } from "sucrase";

const lib = { id: "l", name: "lib", code: `import { base } from "./base";\nexport const hosts: string[] = [base + ".com"];\nglobalThis.__libRuns = (globalThis.__libRuns || 0) + 1;` };
const base = { id: "b", name: "base", code: `export const base = "api";` };
const a = { id: "a", name: "a", code: `import { hosts } from "./lib";\ntt.onRequest({ url: "*://" + hosts[0] + "/*", strategy: "helper" }, () => {});` };
const b = { id: "c", name: "b", code: `import { hosts } from "./lib";\ntt.params({ host: { type: "string", default: hosts[0] } });` };
const scripts = [base, lib, a, b];

describe("compileManyWithLibs", () => {
    it("gives each importer what compileWithLibs gives it", () => {
        const many = compileManyWithLibs(["a", "c"], scripts, {});
        for (const s of [a, b]) {
            const one = compileWithLibs(s, scripts, {});
            const got = many.get(s.id)!;
            expect(got.error).toBeNull();
            expect(got.meta).toEqual(one.meta);
            expect(got.paramDefs).toEqual(one.paramDefs);
            expect(got.deps.sort()).toEqual(one.deps.sort());
        }
        expect(JSON.stringify(many.get("a")!.meta)).toContain("*://api.com/*");
        expect(many.get("c")!.deps.sort()).toEqual(["base", "lib"]);
    });

    it("runs a shared library once", () => {
        (globalThis as any).__libRuns = 0;
        compileManyWithLibs(["a", "c"], scripts, {});
        expect((globalThis as any).__libRuns).toBe(1);
    });

    it("skips ids it doesn't have", () => {
        expect([...compileManyWithLibs(["a", "gone"], scripts, {}).keys()]).toEqual(["a"]);
    });
});

describe("module resolver deps", () => {
    it("a second importer of a loaded library gets it and its imports", () => {
        const r = makeModuleResolver(scripts, () => ({}));
        r.resolveFrom("a")("./lib");
        r.deps.clear();
        r.resolveFrom("b")("./lib");
        expect([...r.deps].sort()).toEqual(["base", "lib"]);
    });
});

describe("transpile cache", () => {
    it("the same source transpiles once", () => {
        let calls = 0;
        setTranspiler((code) => {
            calls++;
            return transform(code, { transforms: ["typescript", "imports"], disableESTransforms: true }).code;
        });
        try {
            const src = `const n: number = 1;\ntt.onPage("*://x/*", () => {});`;
            const first = toRunnableJs(src);
            expect(toRunnableJs(src)).toBe(first);
            expect(compileScript(src).error).toBeNull();
            expect(calls).toBe(1);
            expect(first).not.toContain(": number");
            expect(first).toContain(`tt.onPage`);
        } finally {
            setTranspiler((code) => transform(code, { transforms: ["typescript", "imports"], disableESTransforms: true }).code);
        }
    });

    it("a syntax error is reported every time, with its line", () => {
        const src = `const x = 1;\nconst y = ;\n`;
        const e1 = compileScript(src).error;
        const e2 = compileScript(src).error;
        expect(e1).toMatch(/SyntaxError: .*\(line 2\)/);
        expect(e2).toBe(e1);
    });
});
