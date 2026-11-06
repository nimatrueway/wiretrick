// Compiling overlay code: the top-level registration check, .tsx (JSX with
// the built-in React's automatic runtime, or another via a pragma) and
// what page code gets for built-in imports.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileScript, mainWorldProblems, onPageUses, registrationProblems, toRunnableJs } from "../src/shared/compile";
import { jsxImportSource, usesJsx } from "../src/shared/builtinSpecs";
import { importSpecs, makeLibRequire } from "../src/shared/scriptImports";
import { tsconfigText } from "../src/shared/generatedFiles";

describe("registration check (wt.onPage at the top level)", () => {
    it("accepts top-level registrations, including assigned and exported ones", () => {
        const code = [
            `const page = wt.onPage("*", () => ({ a: () => 1 }));`,
            `export const overlay = wt.onPage({ url: "*", dom: "overlay", when: "document_idle" }, (ctx) => {`,
            `    if (ctx.url) { return { f: () => 2 }; }`,
            `});`,
            `wt.onPage<{ x(): void }>(`,
            `    "*",`,
            `    () => ({ x() {} })`,
            `)`,
            `const s = "wt.onPage(inside a string)"; // wt.onPage( in a comment`,
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
            `if (location.host) wt.onPage({ url: "*", dom: "overlay" }, () => {});`, // onPage #3
            `for (const u of ["a"]) {`,
            `    wt.onPage(u, () => {});`, // onPage #4
            `}`,
            `setTimeout(() => wt.onPage({ url: "*", dom: "overlay" }, () => {}));`, // onPage #5
            `const h = cond ? wt.onPage("*", f) : null;`, // onPage #6
            `ok && wt.onPage("*", f);`, // onPage #7
        ].join("\n");
        expect(registrationProblems(code)).toEqual([
            { api: "onPage", line: 3, nth: 1 },
            { api: "onPage", line: 5, nth: 2 },
            { api: "onPage", line: 7, nth: 3 },
            { api: "onPage", line: 9, nth: 4 },
            { api: "onPage", line: 10, nth: 5 },
            { api: "onPage", line: 11, nth: 6 },
        ]);
    });

    it("scans template literal code", () => {
        expect(registrationProblems("const t = `${wt.onPage(\"*\", f)}`;")).toEqual([{ api: "onPage", line: 1, nth: 0 }]);
    });

    it("isn't fooled by JSX's `/>` after an attribute's `}`", () => {
        const code = `wt.onPage("*", () => {\n    f(() => <A port={cfg.port} />);\n});\nwt.onPage("*", f);`;
        expect(registrationProblems(code)).toEqual([]);
        expect(registrationProblems(`${code}\nif (x) wt.onPage("*", f);`)).toEqual([{ api: "onPage", line: 5, nth: 2 }]);
    });

    it("isn't fooled by regex literals or division", () => {
        expect(registrationProblems(`const r = /{/;\nconst d = a / b;\nwt.onPage("*", f);`)).toEqual([]);
    });
});

describe("page-world onPage handlers using stores or overlay handles (route warnings)", () => {
    const code = [
        `const g = wt.globalStore("g", { n: 0 });`,
        `const ps: { hits: number } = wt.pageStore("ps", { hits: 0 });`,
        `const ov = wt.onPage({ url: "*", dom: "overlay" }, () => ({ ping: () => 1 }));`, // #1 the overlay
        `wt.onPage({ url: "*", js: "page" }, () => { document.title = String(ps.hits); });`, // #2 page: pageStore
        `wt.onPage("*", () => { g.n++; ps.hits++; ov.ping(); });`, // #3 isolated (the default): fine
        `wt.onPage({ url: "*", js: "page" }, async () => { await ov.ping(); g.n = wt.pageStore("x", {}).y; });`, // #4 page: all three
        `wt.onPage({ url: "*", js: "page" }, () => { const o = { g: 1, ps: 2 }; console.log("g ps ov", o.g, /ov/); /* ps */ });`, // #5 keys, strings, comments: nothing
        "wt.onPage({ url: \"*\", js: \"page\" }, () => { document.title = `${g.n}`; });", // #6 template code counts
    ].join("\n");

    it("finds, per onPage call, the stores and overlay handles its handler uses", () => {
        expect(onPageUses(code)).toEqual([
            { nth: 1, pageStore: ["ps"], globalStore: [], overlay: [] },
            { nth: 2, pageStore: ["ps"], globalStore: ["g"], overlay: ["ov"] },
            { nth: 3, pageStore: ["wt.pageStore"], globalStore: ["g"], overlay: ["ov"] },
            { nth: 5, pageStore: [], globalStore: ["g"], overlay: [] },
        ]);
    });

    it("warns for page-world handlers only, in the API's words, with the isolated-world fix", () => {
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const w = mainWorldProblems(code, c.meta.routes);
        expect(w.map((m) => m.slice(0, m.indexOf(":")))).toEqual(["onPage #2", "onPage #4", "onPage #4", "onPage #4", "onPage #6"]);
        expect(w[0]).toContain("your script also accesses pageStore (`ps`) inside onPage, which the API explicitly disallows in the page world");
        expect(w[0]).toContain("Changing the request strategy alone won't resolve those accesses. Switching to globalStore would lose per-page isolation and still wouldn't make a one-time rules callback track requests");
        expect(w[2]).toContain("your script also accesses globalStore (`g`) inside onPage, which the API explicitly disallows in the page world");
        expect(w[3]).toContain("accessing the overlay (`ov`) inside onPage, which the API explicitly disallows in the page world");
        for (const m of w) expect(m).toContain('drop js: "page"');
    });

    it("covers the page-world overlay, numbered among wt.onPage calls, and dom: \"overlay\" handles", () => {
        const src = [
            `const ps = wt.pageStore("ps", { n: 0 });`,
            `const ov = wt.onPage({ url: "*", dom: "overlay" }, () => ({ pick: () => 1 }));`,
            `wt.onPage({ url: "*", js: "page" }, () => { void ov.pick(); });`,
            `wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => { ps.n++; });`,
            `wt.onPage({ url: "*", dom: "overlay" }, () => { ps.n++; });`,
        ].join("\n");
        const c = compileScript(src);
        expect(c.error).toBeNull();
        const w = mainWorldProblems(src, c.meta.routes);
        // the page-world overlay is unsafe: true, which lets it use stores
        expect(w.map((m) => m.slice(0, m.indexOf(":")))).toEqual(["onPage #2"]);
        expect(w[0]).toContain("accessing the overlay (`ov`)");
        expect(w[0]).toContain("or add unsafe: true");
    });

    it("says nothing for unsafe: true page-world handlers", () => {
        const src = [`const ps = wt.pageStore("ps", { n: 0 });`, `const ov = wt.onPage({ url: "*", dom: "overlay" }, () => ({ pick: () => 1 }));`, `wt.onPage({ url: "*", js: "page", unsafe: true }, () => { ps.n++; void ov.pick(); });`].join("\n");
        const c = compileScript(src);
        expect(c.error).toBeNull();
        expect(mainWorldProblems(src, c.meta.routes)).toEqual([]);
    });

    it("says nothing for scripts without stores or overlays", () => {
        expect(mainWorldProblems(`wt.onPage("*", () => {});`, compileScript(`wt.onPage("*", () => {});`).handlers.onDocument.map((h) => h.route))).toEqual([]);
    });
});

describe(".tsx scripts", () => {
    it("compile with the built-in React's automatic runtime", () => {
        const code = `import { useState } from "react";\nwt.onPage({ url: "*", dom: "overlay" }, () => {});\nexport const App = ({ n }: { n: number }) => <div className="x">{n}<></></div>;`;
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

describe("built-in imports in page-world code", () => {
    it("load (the module graph still evaluates) but throw when used", () => {
        const req = makeLibRequire([], () => {})("main");
        const React = req("react");
        expect(React.__esModule).toBe(true);
        expect(() => React.useState).toThrow(/aren't available in page-world code/);
        expect(() => req("valtio").proxy({})).toThrow(/aren't available in page-world code/);
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
