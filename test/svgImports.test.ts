// `.svg` data files: importing one gives its markup, a string.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { bytesToImageDataUrl, dataFileValue, dependantsOf, imageDataUrlToBytes, importResolver, isDataSpec, makeLibRequire } from "../src/shared/scriptImports";
import { dataFilePathProblem } from "../src/shared/scriptName";

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const data = [{ path: "icons/logo.svg", text: LOGO }];

describe(".svg data files", () => {
    it("are data files by path (.svg and raster images)", () => {
        expect(isDataSpec("./icons/Logo.SVG")).toBe(true);
        expect(isDataSpec("./icons/Logo.PNG")).toBe(true);
        expect(dataFilePathProblem("icons/logo.svg")).toBe("");
        expect(dataFilePathProblem("icons/logo.png")).toBe("");
        expect(dataFilePathProblem("icons/.svg")).toMatch(/just \.svg/);
        expect(dataFilePathProblem("icons/.png")).toMatch(/just \.png/);
        expect(dataFilePathProblem("icons/logo.txt")).toMatch(/\.json, \.svg or image/);
        expect(importResolver([], ["icons/logo.svg", "icons/logo.png"])("ui/panel", "../icons/logo.png")).toEqual({ kind: "data", path: "icons/logo.png" });
        expect(dependantsOf("icons/logo.svg", [{ id: "a", name: "a", code: 'import l from "./icons/logo.svg";' }], "data")).toEqual(["a"]);
        const raw = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
        const url = bytesToImageDataUrl("icons/logo.png", raw);
        expect(url).toMatch(/^data:image\/png;base64,/);
        expect(Array.from(imageDataUrlToBytes(url))).toEqual(Array.from(raw));
        expect(dataFileValue("icons/logo.png", url)).toBe(url);
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

    it("build.mjs keeps Monaco's xml basic-language bundle for .svg models", () => {
        const buildSrc = readFileSync("scripts/build.mjs", "utf8");
        const langs = [...(buildSrc.match(/MONACO_BASIC_LANGUAGES\s*=\s*new Set\(\[([^\]]+)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(langs).toEqual(expect.arrayContaining(["typescript", "javascript", "yaml", "xml"]));
    });
});
