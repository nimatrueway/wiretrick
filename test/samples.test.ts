import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import "../src/shared/transpile";
import { compileScript } from "../src/shared/compile";
import { SAMPLES, sampleStrategies, sampleSummary, sampleTryUrl } from "../src/ui/samples";

// built-in imports (react, valtio) only run inside onOverlay handlers, which compiling doesn't call
const stubImports = { importModule: () => ({}) };

/** type errors in a sample, checked like the Editor does (wt-api.d.ts, strict, the built-in React) */
function typeErrors(code: string): string[] {
    // under the repo root, so react and valtio resolve from node_modules
    const [api, file] = [path.resolve("src/types/wt-api.d.ts"), path.resolve("__sample__.tsx")];
    const files: Record<string, string> = { [api]: readFileSync(api, "utf8"), [file]: code };
    const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        types: [],
        skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, lang, ...rest) => (name in files ? ts.createSourceFile(name, files[name], lang) : getSourceFile.call(host, name, lang, ...rest));
    host.fileExists = ((exists) => (name: string) => name in files || exists(name))(host.fileExists);
    host.readFile = ((read) => (name: string) => files[name] ?? read(name))(host.readFile);
    const program = ts.createProgram([api, file], options, host);
    return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("bundled samples", () => {
    for (const s of SAMPLES) {
        it(`${s.name}: compiles, type-checks, names a page to try and needs no helper`, () => {
            expect(compileScript(s.code, stubImports).error).toBeNull();
            expect(typeErrors(s.code)).toEqual([]);
            expect(sampleTryUrl(s.code)).toMatch(/^https:\/\/[^\s]+$/);
            const strategies = sampleStrategies(s.code);
            expect(strategies.length).toBeGreaterThan(0);
            expect(strategies).not.toContain("helper");
            expect(sampleSummary(s.blurb)).not.toMatch(/Try it/);
        });
    }
});

describe("sample helpers", () => {
    it("the type check catches a wrong call", () => {
        expect(typeErrors(`const p = wt.onPage("*://a/*", () => ({ n: () => 1 }));\nwt.onOverlay("*://a/*", async () => { const s: string = await p.n(); });`)).toHaveLength(1);
        expect(typeErrors(`import { useState } from "react";\nconst [n] = useState(0);\nconst el = <div>{n}</div>;`)).toEqual([]);
    });
    it("reads the Try it URL", () => {
        expect(sampleTryUrl(`// Try it: open https://example.com/a?b=1 and reload\nwt.about("x");`)).toBe("https://example.com/a?b=1");
        expect(sampleTryUrl(`wt.about("x");`)).toBeNull();
    });
    it("lists the strategies routes name, both branches of a ternary", () => {
        expect(sampleStrategies(`wt.onRequest({ url: "*://a/*", strategy: "rules" }, f);`)).toEqual(["rules"]);
        expect(sampleStrategies(`wt.onResponseBody({ url: "*://a/*", strategy: wt.isFirefox ? "extension" : "debugger" }, f);`)).toEqual(["debugger", "extension"]);
        expect(sampleStrategies(`wt.onPage("*://a/*", () => {});`)).toEqual(["onPage"]);
        expect(sampleStrategies(`wt.onRequest({ url: "*://a/*", strategy: "page" }, f);\nwt.onPage("*://a/*", f);\nwt.onOverlay("*://a/*", f);`)).toEqual(["page", "overlay"]);
        expect(sampleStrategies(`wt.onPage({ url: "*://a/*", dom: "overlay" }, f);`)).toEqual(["overlay"]);
    });
    it("drops the Try it sentence from the blurb", () => {
        expect(sampleSummary("Send any request elsewhere. Try it: open a.com — b.")).toBe("Send any request elsewhere.");
    });
});
