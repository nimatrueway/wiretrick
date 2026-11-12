/** tt.metadata (a script's package metadata) and metadata.json (a bundle's) */
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { fileExtension } from "../src/shared/scriptName";
import { compareVersions, parseManifest } from "../src/shared/packageMetadata";
import { resolveWorkspaceIcons } from "../src/shared/packageModel";

const SCRIPT = `tt.onRequest({ url: "*://example.com/*", strategy: "extension" }, () => {});`;

describe("file names", () => {
    it("keeps the whole extension unselected on rename", () => {
        expect(fileExtension("a/x.tangitweak.ts")).toBe(".tangitweak.ts");
        expect(fileExtension("x.tangitweak.tsx")).toBe(".tangitweak.tsx");
        expect(fileExtension("x.ts")).toBe(".ts");
        expect(fileExtension("d.json")).toBe(".json");
        expect(fileExtension("README")).toBe("");
    });
});

describe("compiling", () => {
    it("runs any script that registers handlers", () => {
        for (const name of ["x", "x.tangitweak", "dir/lib"]) expect(compileWithLibs({ id: "a", name, code: SCRIPT }, []).meta.active).toBe(true);
    });
    it("reads tt.metadata", () => {
        const c = compileWithLibs({ id: "a", name: "x.tangitweak", code: `tt.metadata({ name: "Dark", version: "1.2.0", description: "Hello", connect: ["API.github.com", "a.com", "a.com"], extra: 1 } as any);\n${SCRIPT}` }, []);
        expect(c.error).toBeNull();
        expect(c.meta.description).toBe("Hello");
        expect(c.meta.metadata).toEqual({ name: "Dark", version: "1.2.0", description: "Hello", connect: ["api.github.com", "a.com"] });
    });
    it("reads and checks updateURL", () => {
        const ok = compileWithLibs({ id: "a", name: "x.tangitweak", code: `tt.metadata({ updateURL: "https://github.com/me/s/tree/main/kit" });\n${SCRIPT}` }, []);
        expect(ok.meta.metadata).toEqual({ updateURL: "https://github.com/me/s/tree/main/kit", connect: [] });
        expect(compileWithLibs({ id: "a", name: "x.tangitweak", code: `tt.metadata({ updateURL: "https://x.dev/a.js" });` }, []).error).toMatch(/"updateURL" — the URL must end in/);
        expect(parseManifest(JSON.stringify({ updateURL: "https://x.dev/kit.zip", scripts: ["a.ts"] })).updateURL).toBe("https://x.dev/kit.zip");
    });
    it("rejects a wrong tt.metadata", () => {
        expect(compileWithLibs({ id: "a", name: "x.tangitweak", code: `tt.metadata({ version: 1 } as any);` }, []).error).toMatch(/"version" must be a string/);
        expect(compileWithLibs({ id: "a", name: "x.tangitweak", code: `tt.metadata({}); tt.metadata({});` }, []).error).toMatch(/once/);
    });
});

describe("package metadata", () => {
    it("parses a bundle's metadata.json", () => {
        const m = parseManifest(JSON.stringify({ name: "Kit", version: "2.0.0", icon: "./icon.svg", connect: ["X.com"], scripts: ["./a.ts", "sub/b.tangitweak.tsx"] }));
        expect(m).toEqual({ name: "Kit", version: "2.0.0", icon: "./icon.svg", connect: ["x.com"], scripts: ["a.ts", "sub/b.tangitweak.tsx"] });
    });
    it("resolves script and bundle icons from relative .svg/.png files, inline <svg>, and URLs", () => {
        const pngUrl = "data:image/png;base64,AAAA";
        const scripts = [
            { id: "s1", meta: { name: "kit/main", metadata: {} } },
            { id: "s2", meta: { name: "solo", metadata: { icon: '<svg xmlns="http://www.w3.org/2000/svg"/>' } } },
            { id: "s3", meta: { name: "app/entry", metadata: { icon: "./logo.png" } } },
        ];
        const dataFiles = [
            { path: "kit/metadata.json", text: JSON.stringify({ name: "Kit", icon: "badge.svg", scripts: ["main.ts"] }) },
            { path: "kit/badge.svg", text: '<svg viewBox="0 0 8 8"><circle r="4"/></svg>' },
            { path: "app/metadata.json", text: JSON.stringify({ name: "App", scripts: ["entry.ts"] }) },
            { path: "app/logo.png", text: pngUrl },
        ];
        const { scriptIcons, folderIcons } = resolveWorkspaceIcons(scripts, dataFiles);
        expect(folderIcons.get("kit")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
        expect(scriptIcons.get("s1")).toBe(folderIcons.get("kit"));
        expect(scriptIcons.get("s2")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
        expect(scriptIcons.get("s3")).toBe(pngUrl);
        expect(folderIcons.get("app")).toBe(pngUrl);
    });
    it("rejects a wrong metadata.json", () => {
        expect(() => parseManifest("{")).toThrow(/valid JSON/);
        expect(() => parseManifest(`{"name":"x"}`)).toThrow(/scripts/);
        expect(() => parseManifest(`{"scripts":["data.json"]}`)).toThrow(/data\.json/);
        expect(() => parseManifest(`{"scripts":["../a.tangitweak.ts"]}`)).toThrow(/bundle's folder/);
        expect(() => parseManifest(`{"name":3,"scripts":["a.tangitweak.ts"]}`)).toThrow(/"name" must be a string/);
    });
    it("compares versions", () => {
        expect(compareVersions("1.10.0", "1.9")).toBe(1);
        expect(compareVersions("1.0", "1.0.0")).toBe(0);
        expect(compareVersions(undefined, "0.1")).toBe(-1);
    });
});
