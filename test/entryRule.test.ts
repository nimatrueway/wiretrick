/** Only `*.wiretrick.ts` files run; other files are libraries others import. */
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { entryNameOf, fileExtension, isEntryName, notAnEntryProblem } from "../src/shared/scriptName";
import { compareVersions, parseHeader } from "../src/shared/packageHeader";

const SCRIPT = `wt.onRequest({ url: "*://example.com/*", strategy: "extension" }, () => {});`;

describe("entry names", () => {
    it("recognizes entries", () => {
        expect(isEntryName("x.wiretrick")).toBe(true);
        expect(isEntryName("dir/Panel.wiretrick.tsx")).toBe(true);
        expect(isEntryName("x")).toBe(false);
        expect(isEntryName("x.wiretrick.json")).toBe(false);
        expect(isEntryName(".wiretrick")).toBe(false);
    });
    it("maps a name to its entry", () => {
        expect(entryNameOf("x")).toBe("x.wiretrick");
        expect(entryNameOf("a/Panel.tsx")).toBe("a/Panel.wiretrick.tsx");
        expect(entryNameOf("x.wiretrick")).toBe("x.wiretrick");
    });
    it("keeps the whole extension unselected on rename", () => {
        expect(fileExtension("a/x.wiretrick.ts")).toBe(".wiretrick.ts");
        expect(fileExtension("x.wiretrick.tsx")).toBe(".wiretrick.tsx");
        expect(fileExtension("x.ts")).toBe(".ts");
        expect(fileExtension("d.json")).toBe(".json");
        expect(fileExtension("README")).toBe("");
    });
    it("suggests the entry file name", () => {
        expect(notAnEntryProblem("dir/x", 2)).toContain('rename it to "x.wiretrick.ts"');
    });
});

describe("compiling", () => {
    it("runs an entry", () => {
        const c = compileWithLibs({ id: "a", name: "x.wiretrick", code: SCRIPT }, []);
        expect(c.error).toBeNull();
        expect(c.meta.active).toBe(true);
        expect(c.meta.inert).toBeUndefined();
    });
    it("leaves a library that registers handlers inert", () => {
        const c = compileWithLibs({ id: "a", name: "x", code: SCRIPT }, []);
        expect(c.meta.active).toBe(false);
        expect(c.meta.routes).toEqual([]);
        expect(c.meta.inert).toBe(1);
    });
    it("takes the description from the header without wt.about", () => {
        const c = compileWithLibs({ id: "a", name: "x.wiretrick", code: `/**\n * @description Hello\n */\n${SCRIPT}` }, []);
        expect(c.meta.description).toBe("Hello");
    });
});

describe("package header", () => {
    it("parses the leading JSDoc block", () => {
        const h = parseHeader(`// lint\n/**\n * @name Dark\n * @version 1.2.0\n * @description Forces\n *   the dark theme\n * @connect api.github.com\n * @connect a.com B.com\n */\nwt.about("x")`);
        expect(h).toEqual({ name: "Dark", version: "1.2.0", description: "Forces the dark theme", connect: ["api.github.com", "a.com", "b.com"] });
    });
    it("ignores a block after code", () => {
        expect(parseHeader(`const a = 1;\n/** @name X */`).name).toBeUndefined();
    });
    it("compares versions", () => {
        expect(compareVersions("1.10.0", "1.9")).toBe(1);
        expect(compareVersions("1.0", "1.0.0")).toBe(0);
        expect(compareVersions(undefined, "0.1")).toBe(-1);
    });
});
