import { describe, it, expect } from "vitest";
import { badPackageImports, coveredMissingModule, missingLocalModule, dependantsOf, packageImportMarks, importKeys, missingImports } from "../src/shared/scriptImports";

describe("script imports", () => {
    it("reads import specifiers", () => {
        expect([...importKeys(`import { a } from "./utils";\nimport x from 'Lib.ts'; const y = await import("./dyn"); require("r")`)]).toEqual(["utils", "lib", "dyn", "r"]);
    });
    it("finds direct and transitive importers by name (case-insensitively)", () => {
        const s = [
            { id: "u", name: "My utils", code: "export const a = 1;" },
            { id: "b", name: "B", code: `import { a } from "./My utils";` },
            { id: "c", name: "C", code: `import { b } from "./b";` },
            { id: "d", name: "D", code: `import { a } from "./my utils.ts";` },
            { id: "e", name: "E", code: `const s = "from nothing";` },
        ];
        expect(dependantsOf("My utils", s).sort()).toEqual(["b", "c", "d"]);
        expect(dependantsOf("C", s)).toEqual([]);
    });
});

describe("missingImports (partial import/export)", () => {
    const s = [
        { name: "My utils", code: "export const a = 1;" },
        { name: "lib2", code: `import { a } from "./My utils";` },
        { name: "App", code: `import { b } from "./lib2";` },
        { name: "Other", code: "" },
    ];
    it("lists unpicked libraries a pick needs, transitively", () => {
        expect(missingImports([2], s)).toEqual([0, 1]);
        expect(missingImports([2, 1], s)).toEqual([0]);
        expect(missingImports([0, 1, 2], s)).toEqual([]);
        expect(missingImports([3], s)).toEqual([]);
    });
});

describe("badPackageImports", () => {
    it("marks unpinned unpkg URLs on the specifier, with what to pin", () => {
        const code = `import { sleep } from 'https://unpkg.com/asyncbox';\nimport d from "https://unpkg.com/dayjs@1.11.13";\nconst x = await import("https://unpkg.com/@scope/pkg@^2/dist/x.js");\n`;
        const bad = badPackageImports(code);
        expect(bad.map((b) => code.slice(b.offset, b.offset + b.length))).toEqual(["https://unpkg.com/asyncbox", "https://unpkg.com/@scope/pkg@^2/dist/x.js"]);
        expect(bad[0].message).toMatch(/^cannot import "https:\/\/unpkg.com\/asyncbox": pin an exact version/);
        expect(bad[0].pin).toEqual({ name: "asyncbox", range: "latest", sub: "" });
        expect(bad[1].pin).toEqual({ name: "@scope/pkg", range: "^2", sub: "dist/x.js" });
    });
    it("other hosts are errors without a pin fix; relative and bare imports are ignored", () => {
        const bad = badPackageImports(`import a from "https://esm.sh/x@1.0.0";\nimport b from "./lib";\nimport c from "utils";`);
        expect(bad).toHaveLength(1);
        expect(bad[0].pin).toBeUndefined();
        expect(bad[0].message).toMatch(/only pinned https:\/\/unpkg.com\//);
    });
});

describe("packageImportMarks", () => {
    const A = "https://unpkg.com/a-lib@1.0.0";
    const code = `import a from "${A}";\nimport b from "https://unpkg.com/b-lib@2";\nimport c from "./lib";\n`;
    const at = (st: any) => packageImportMarks(code, (u) => (u === A ? st : undefined));

    it("an unpinned URL is an error; a valid one not asked about yet (or ready) has no marker", () => {
        for (const st of [undefined, { state: "ready" }]) {
            const marks = at(st);
            expect(marks).toHaveLength(1);
            expect(marks[0]).toMatchObject({ spec: "https://unpkg.com/b-lib@2", severity: "error", pin: { name: "b-lib", range: "2" } });
        }
    });

    it("a download or types under way is a warning on the specifier, not a failure", () => {
        const dl = at({ state: "downloading" })[0];
        expect(dl).toMatchObject({ spec: A, severity: "warning", message: `downloading "${A}" from unpkg… (its types follow)` });
        expect(code.slice(dl.offset, dl.offset + dl.length)).toBe(A);
        expect(at({ state: "typing" })[0]).toMatchObject({ severity: "warning", message: `fetching the types of "${A}"…` });
        expect(at({ state: "untyped", reason: "Failed to fetch" })[0]).toMatchObject({ severity: "warning", message: expect.stringContaining("(Failed to fetch) — it still runs") });
        expect(at({ state: "missing" })[0]).toMatchObject({ severity: "warning", message: expect.stringContaining("save the script to download it") });
    });

    it("a failed download is an error worded as the compile error (so Problems lists it once)", () => {
        expect(at({ state: "failed", reason: "download failed (Failed to fetch)" })[0]).toMatchObject({ severity: "error", message: `cannot import "${A}": download failed (Failed to fetch)` });
    });

    it("TypeScript's \"Cannot find module\" on a URL import is covered until the package is ready", () => {
        const msg = (u: string) => `Cannot find module '${u}' or its corresponding type declarations.`;
        const ready = (st: string) => () => ({ state: st }) as any;
        expect(coveredMissingModule(msg("https://unpkg.com/b-lib@2"), () => undefined)).toBe(true);
        expect(coveredMissingModule(msg(A), () => undefined)).toBe(true);
        expect(coveredMissingModule(msg(A), ready("downloading"))).toBe(true);
        expect(coveredMissingModule(msg(A), ready("ready"))).toBe(false);
        expect(coveredMissingModule(msg("./lib"), () => undefined)).toBe(false);
        expect(coveredMissingModule("Cannot find name 'x'.", () => undefined)).toBe(false);
    });
    it("tells a missing script or data file import (the worker may not have it yet) from other errors", () => {
        const msg = (spec: string) => `Cannot find module '${spec}' or its corresponding type declarations.`;
        expect(missingLocalModule(msg("./lib"))).toBe(true);
        expect(missingLocalModule(msg("../lib/l1"))).toBe(true);
        expect(missingLocalModule(msg("./data/a.json"))).toBe(true);
        expect(missingLocalModule(msg("https://unpkg.com/a@1.0.0"))).toBe(false);
        expect(missingLocalModule(msg("react"))).toBe(false);
        expect(missingLocalModule("Cannot find name 'x'.")).toBe(false);
    });
});
