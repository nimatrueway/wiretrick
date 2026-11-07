// Compiling overlay code: the top-level registration check, .tsx (JSX with
// the built-in React's automatic runtime, or another via a pragma) and
// what page code gets for built-in imports.
import { describe, it, expect } from "vitest";
import { siteBuiltin } from "../src/shared/siteBuiltin";
import "../src/shared/transpile";
import { compileScript, keyPlaceCalls, onSiteUses, siteProblems, toRunnableJs } from "../src/shared/compile";
import { SITE_DISALLOWED, SITE_NO_HANDLES, SITE_NO_STORES } from "../src/shared/remote";
import { jsxImportSource, usesJsx } from "../src/shared/builtinSpecs";
import { importSpecs, makeLibRequire, topLevel } from "../src/shared/scriptImports";
import { tsconfigText } from "../src/shared/generatedFiles";

describe("keyPlaceCalls (handle names by source order)", () => {
    // it runs on the transpiled JavaScript: no type arguments left
    it("numbers each API's calls in source order, wherever they are", () => {
        const code = [
            `const page = wt.onPage("*", () => ({ a: () => 1 }));`,
            `export const overlay = wt.onOverlay({ url: "*", when: "document_idle" }, (ctx) => ({ f: () => 2 }));`,
            `function later() { wt.onPage("*", () => {}); }`,
            `wt.onSite(`,
            `    "*",`,
            `    () => ({ x() {} })`,
            `)`,
            `const s = "wt.onPage(inside a string)"; // wt.onPage( in a comment`,
            `/* if (x) wt.onPage("*", f) */`,
            `if (ok) wt.onSite("*", f);`,
        ].join("\n");
        const out = keyPlaceCalls(code);
        expect(out.split("\n")).toHaveLength(code.split("\n").length);
        expect([...out.matchAll(/wt\.(on\w+)\.k\((\d+)\)\(/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(["onPage:0", "onOverlay:0", "onPage:1", "onSite:0", "onSite:1"]);
        expect(out).toContain(`"wt.onPage(inside a string)"`);
        expect(out).toContain(`// wt.onPage( in a comment`);
        expect(keyPlaceCalls(`wt.onRequest({ url: "*", strategy: "page" }, f);`)).toBe(`wt.onRequest({ url: "*", strategy: "page" }, f);`);
    });

    it("scans template literal code, and isn't fooled by JSX or regex literals", () => {
        expect(keyPlaceCalls("const t = `${wt.onPage(\"*\", f)}`;")).toBe("const t = `${wt.onPage.k(0)(\"*\", f)}`;");
        const jsx = `wt.onOverlay("*", () => {\n    f(() => <A port={cfg.port} />);\n});\nwt.onOverlay("*", f);`;
        expect(keyPlaceCalls(jsx)).toContain(`wt.onOverlay.k(1)("*", f)`);
        expect(keyPlaceCalls(`const r = /{/;\nconst d = a / b;\nwt.onPage("*", f);`)).toContain(`wt.onPage.k(0)("*", f)`);
    });

    it("compiled handlers get their keys, the same in the background and the page", () => {
        const c = compileScript(`function reg() { return wt.onPage("*", () => {}); }\nwt.onSite("*", () => {});\nreg();\nwt.onPage("*", () => {});\nreg();`);
        expect(c.error).toBeNull();
        expect(c.meta.routes.map((r) => r.key)).toEqual(["onSite:0", "onPage:0", "onPage:1", "onPage:0#1"]);
    });
});

describe("onSite handlers using stores or handles (route warnings)", () => {
    const code = [
        `const g = wt.globalStore("g", { n: 0 });`,
        `const ps: { hits: number } = wt.pageStore("ps", { hits: 0 });`,
        `const ov = wt.onOverlay("*", () => ({ ping: () => 1 }));`,
        `wt.onSite("*", () => { document.title = String(ps.hits); });`, // #1: pageStore
        `wt.onPage("*", () => { g.n++; ps.hits++; ov.ping(); });`, // onPage: fine
        `wt.onSite("*", async () => { await ov.ping(); g.n = wt.pageStore("x", {}).y; });`, // #2: all three
        `wt.onSite("*", () => { const o = { g: 1, ps: 2 }; console.log("g ps ov", o.g, /ov/); /* ps */ });`, // #3 keys, strings, comments: nothing
        "wt.onSite(\"*\", () => { document.title = `${g.n}`; });", // #4 template code counts
    ].join("\n");

    it("finds, per onSite call, the stores and handles its handler uses", () => {
        expect(onSiteUses(code)).toEqual([
            { nth: 0, pageStore: ["ps"], globalStore: [], handles: [] },
            { nth: 1, pageStore: ["wt.pageStore"], globalStore: ["g"], handles: ["ov"] },
            { nth: 3, pageStore: [], globalStore: ["g"], handles: [] },
        ]);
    });

    it("warns for onSite handlers only, with the move-to-onPage fix", () => {
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const w = siteProblems(code, c.meta.routes);
        expect(w.map((m) => m.slice(0, m.indexOf(":")))).toEqual(["onSite #1", "onSite #2", "onSite #2", "onSite #4"]);
        expect(w[0]).toBe(`onSite #1: uses \`ps\` — ${SITE_NO_STORES}`);
        expect(w[1]).toBe(`onSite #2: uses \`wt.pageStore\`, \`g\` — ${SITE_NO_STORES}`);
        expect(w[2]).toBe(`onSite #2: uses \`ov\` — ${SITE_NO_HANDLES}`);
        for (const m of w) expect(m).toContain(SITE_DISALLOWED);
    });

    it("says nothing for scripts without stores or handles in onSite code", () => {
        const src = `const ps = wt.pageStore("ps", {});\nwt.onPage("*", () => ps);\nwt.onSite("*", () => {});`;
        expect(siteProblems(src, compileScript(src).meta.routes)).toEqual([]);
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

describe("built-in imports in onSite code", () => {
    it("load (the module graph still evaluates) but throw when used", () => {
        const req = makeLibRequire([], () => {})("main");
        const React = req("react");
        expect(React.__esModule).toBe(true);
        expect(() => React.useState).toThrow(/cannot use "react" in onSite code/);
        expect(() => req("valtio").proxy({})).toThrow(/cannot use "valtio" in onSite code/);
    });

    it("the site's world has valtio's core (for its site stores), not its React hooks", () => {
        const req = makeLibRequire([], () => {}, { builtin: siteBuiltin })("main");
        const v = req("valtio");
        const p = v.proxy({ n: 1 });
        expect(v.snapshot(p)).toEqual({ n: 1 });
        expect(req("valtio/vanilla").proxy).toBe(v.proxy);
        expect(() => v.useSnapshot(p)).toThrow(/needs React/);
        expect(() => req("react").useState).toThrow(/cannot use "react" in onSite code/);
    });

    it("the site's world still compiles a script importing a package that needs React (for its onOverlay code); using it there throws", () => {
        const url = "https://unpkg.com/ui-lib@1.0.0";
        const libs = [{ name: `${url}/index.js`, pkg: { js: `var React = require("react");\nexports.Button = React.forwardRef(function () {});\n`, requires: {} } }, { name: url, alias: `${url}/index.js` }];
        const req = makeLibRequire(libs, () => {}, { builtin: siteBuiltin, onSite: true })("main");
        const js = toRunnableJs(`import { Button } from "${url}";\nimport * as UI from "${url}";\nimport Def from "${url}";\nexport const use = () => Button;\nexport const all = () => UI.Button;`);
        const m = { exports: {} as any };
        expect(() => new Function("require", "module", "exports", js)(req, m, m.exports)).not.toThrow();
        expect(() => m.exports.use()).toThrow(/cannot use "https:\/\/unpkg\.com\/ui-lib@1\.0\.0" in onSite code: it doesn't load there \(cannot use "react" in onSite code.*onPage or onOverlay/s);
        expect(() => m.exports.all()).toThrow(/in onSite code/);
        // elsewhere the load error stays a compile error
        const iso = makeLibRequire(libs, () => {}, { builtin: siteBuiltin })("main");
        expect(() => iso(url)).toThrow(/cannot import "https:\/\/unpkg\.com\/ui-lib@1\.0\.0": cannot use "react"/);
    });

    it("the site's world runs a module's top-level React calls (memo, forwardRef, a class component) inertly; using the result in a handler throws", () => {
        const url = "https://unpkg.com/ui-lib@1.0.0";
        const libs = [
            { name: `${url}/index.js`, pkg: { js: `var React = require("react");\nexports.Button = React.forwardRef(function () {});\nexports.Button.displayName = "Button";\nexports.v = parseInt(React.version) + "" + React.version;\n`, requires: {} } },
            { name: url, alias: `${url}/index.js` },
            { name: "gui", src: toRunnableJs(`import { memo, createContext, Component } from "react";\nimport { Button } from "${url}";\nexport const Item = memo(function Item() { return null; });\nItem.displayName = "Item";\nexport const Ctx = createContext(null);\nexport class Box extends Component {}\nexport const Wrapped = memo(Button);\nfor (const _ of [...Object.keys(Ctx)]) {}`) },
        ];
        const requireFrom = makeLibRequire(libs, (lib, require, m) => new Function("require", "module", "exports", lib.src!)(require, m, m.exports), { builtin: siteBuiltin, onSite: true });
        const js = toRunnableJs(`import { Item } from "./gui";\nimport { memo } from "react";\nconst Top = memo(() => null);\nexport const handler = () => Item.type;\nexport const top = () => Top.type;`);
        const m = { exports: {} as any };
        expect(() => topLevel(() => new Function("require", "module", "exports", js)(requireFrom("main"), m, m.exports))).not.toThrow();
        expect(() => m.exports.handler()).toThrow(/cannot use "react" in onSite code/);
        expect(() => m.exports.top()).toThrow(/cannot use "react" in onSite code/);
        // outside a top level, using a stand-in throws right away
        expect(() => requireFrom("main")("react").memo).toThrow(/cannot use "react" in onSite code/);
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
