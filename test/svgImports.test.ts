// `.svg` data files: importing one gives its markup, a string.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { dataFileValue, dependantsOf, importResolver, isDataSpec, makeLibRequire } from "../src/shared/scriptImports";
import { dataFilePathProblem } from "../src/shared/scriptName";

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const data = [{ path: "icons/logo.svg", text: LOGO }];

describe(".svg data files", () => {
    it("are data files by path", () => {
        expect(isDataSpec("./icons/Logo.SVG")).toBe(true);
        expect(dataFilePathProblem("icons/logo.svg")).toBe("");
        expect(dataFilePathProblem("icons/.svg")).toMatch(/just \.svg/);
        expect(dataFilePathProblem("icons/logo.png")).toMatch(/\.json or \.svg/);
        expect(importResolver([], ["icons/logo.svg"])("ui/panel", "../icons/logo.svg")).toEqual({ kind: "data", path: "icons/logo.svg" });
        expect(dependantsOf("icons/logo.svg", [{ id: "a", name: "a", code: 'import l from "./icons/logo.svg";' }], "data")).toEqual(["a"]);
    });

    it("import as their markup (never parsed), in scripts and libraries", () => {
        expect(dataFileValue("a.svg", LOGO)).toBe(LOGO);
        const lib = { id: "l", name: "ui/icons", code: `import logo from "../icons/logo.svg";\nexport const html = logo;` };
        const main = { id: "m", name: "main", code: `import { html } from "./ui/icons";\nimport logo from "./icons/logo.svg";\ntt.params({ a: { type: "string", default: html }, b: { type: "string", default: logo } });` };
        const c = compileWithLibs(main, [lib], {}, data);
        expect(c.error).toBeNull();
        expect(c.paramDefs?.a.default).toBe(LOGO);
        expect(c.paramDefs?.b.default).toBe(LOGO);
        expect(c.deps).toContain("icons/logo.svg");
    });

    it("a missing one is the importer's compile error", () => {
        const c = compileWithLibs({ id: "m", name: "main", code: `import x from "./nope.svg";\nconsole.log(x);` }, [], {}, data);
        expect(c.error).toMatch(/no data file "nope\.svg"/);
    });

    it("the page-side require gives the markup too", () => {
        const requireFrom = makeLibRequire([{ name: "icons/logo.svg", json: LOGO }], () => {});
        expect(requireFrom("main")("./icons/logo.svg")).toBe(LOGO);
    });
});
