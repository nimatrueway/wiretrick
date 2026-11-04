// Compiling overlay code: the top-level registration check, .tsx (JSX with
// the built-in React's automatic runtime, or another via a pragma) and
// what page code gets for built-in imports.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileScript, registrationProblems, toRunnableJs } from "../src/shared/compile";
import { jsxImportSource, usesJsx } from "../src/shared/builtinSpecs";
import { importSpecs, makeLibRequire } from "../src/shared/scriptImports";
import { tsconfigText } from "../src/shared/generatedFiles";

describe("registration check (wt.onPage / wt.onOverlay at the top level)", () => {
    it("accepts top-level registrations, including assigned and exported ones", () => {
        const code = [
            `const page = wt.onPage("*", () => ({ a: () => 1 }));`,
            `export const overlay = wt.onOverlay({ url: "*", when: "document_idle" }, (ctx) => {`,
            `    if (ctx.url) { return { f: () => 2 }; }`,
            `});`,
            `wt.onDocument("*", () => {})`,
            `wt.onPage<{ x(): void }>(`,
            `    "*",`,
            `    () => ({ x() {} })`,
            `)`,
            `const s = "wt.onPage(inside a string)"; // wt.onOverlay( in a comment`,
            `/* if (x) wt.onPage("*", f) */`,
        ].join("\n");
        expect(registrationProblems(code)).toEqual([]);
    });

    it("reports a call inside a function, block, condition, loop or callback, with its line and which call it is", () => {
        const code = [
            `wt.onPage("*", () => {});`, // onPage #1
            `function later() {`,
            `    wt.onPage("*", () => {});`, // onPage #2
            `}`,
            `if (location.host) wt.onOverlay("*", () => {});`, // onOverlay #1
            `for (const u of ["a"]) {`,
            `    wt.onPage(u, () => {});`, // onPage #3
            `}`,
            `setTimeout(() => wt.onOverlay("*", () => {}));`, // onOverlay #2
            `const h = cond ? wt.onPage("*", f) : null;`, // onPage #4
            `ok && wt.onPage("*", f);`, // onPage #5
        ].join("\n");
        expect(registrationProblems(code)).toEqual([
            { api: "onPage", line: 3, nth: 1 },
            { api: "onOverlay", line: 5, nth: 0 },
            { api: "onPage", line: 7, nth: 2 },
            { api: "onOverlay", line: 9, nth: 1 },
            { api: "onPage", line: 10, nth: 3 },
            { api: "onPage", line: 11, nth: 4 },
        ]);
    });

    it("counts onDocument calls in the onPage sequence without reporting them", () => {
        expect(registrationProblems(`if (x) { wt.onDocument("*", f); }\nif (y) wt.onPage("*", f);`)).toEqual([{ api: "onPage", line: 2, nth: 1 }]);
    });

    it("scans template literal code", () => {
        expect(registrationProblems("const t = `${wt.onPage(\"*\", f)}`;")).toEqual([{ api: "onPage", line: 1, nth: 0 }]);
    });

    it("isn't fooled by regex literals or division", () => {
        expect(registrationProblems(`const r = /{/;\nconst d = a / b;\nwt.onPage("*", f);`)).toEqual([]);
    });
});

describe(".tsx scripts", () => {
    it("compile with the built-in React's automatic runtime", () => {
        const code = `import { useState } from "react";\nwt.onOverlay("*", () => {});\nexport const App = ({ n }: { n: number }) => <div className="x">{n}<></></div>;`;
        expect(usesJsx(code)).toBe(true);
        expect(importSpecs(code).has("react/jsx-runtime")).toBe(true);
        const js = toRunnableJs(code);
        expect(js).toContain('require("react/jsx-runtime")');
        expect(js).not.toContain("React.createElement");
    });

    it("a @jsxImportSource pragma picks another runtime", () => {
        const code = `/** @jsxImportSource https://unpkg.com/preact@10.26.4 */\nexport const A = () => <b />;`;
        expect(jsxImportSource(code)).toBe("https://unpkg.com/preact@10.26.4");
        expect(importSpecs(code).has("https://unpkg.com/preact@10.26.4/jsx-runtime")).toBe(true);
        expect(toRunnableJs(code)).toContain('require("https://unpkg.com/preact@10.26.4/jsx-runtime")');
    });

    it("an old-style <T> cast still compiles as TypeScript", () => {
        const code = `const n = <number>(JSON.parse("1"));\nmodule.exports.n = n;`;
        expect(usesJsx(code)).toBe(false);
        const c = compileScript(code);
        expect(c.error).toBeNull();
        expect(c.exports.n).toBe(1);
    });

    it("comparisons and generics aren't JSX", () => {
        expect(usesJsx(`const a = b < c && d > e;\nfunction f<T>(x: T): Array<T> { return [x]; }`)).toBe(false);
    });

    it("the folder's tsconfig compiles JSX against the built-in React", () => {
        const ts = tsconfigText();
        expect(JSON.parse(ts.slice(ts.indexOf("\n") + 1)).compilerOptions.jsx).toBe("react-jsx");
    });
});

describe("built-in imports in page code", () => {
    it("load (the module graph still evaluates) but throw when used", () => {
        const req = makeLibRequire([], () => {})("main");
        const React = req("react");
        expect(React.__esModule).toBe(true);
        expect(() => React.useState).toThrow(/aren't available in page code/);
        expect(() => req("valtio").proxy({})).toThrow(/aren't available in page code/);
    });

    it("a page shim compiles an overlay script that imports React", () => {
        const req = makeLibRequire([], () => {})("main");
        const js = toRunnableJs(`import { useState } from "react";\nexport const App = () => { useState(0); return <div />; };`);
        const fn = new Function("require", "module", "exports", js);
        const m = { exports: {} as any };
        expect(() => fn(req, m, m.exports)).not.toThrow();
        expect(() => m.exports.App()).toThrow(/cannot use "react"/);
    });
});
