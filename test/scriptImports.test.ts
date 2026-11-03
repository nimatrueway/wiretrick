import { describe, it, expect } from "vitest";
import { badPackageImports, dependantsOf, importKeys, missingImports } from "../src/shared/scriptImports";

describe("script imports", () => {
    it("reads import specifiers", () => {
        expect([...importKeys(`import { a } from "./utils";\nimport x from 'Lib.ts'; const y = await import("./dyn"); require("r")`)]).toEqual(["utils", "lib", "dyn", "r"]);
    });
    it("finds direct and transitive importers by name (spaced or underscored)", () => {
        const s = [
            { id: "u", name: "My utils", code: "export const a = 1;" },
            { id: "b", name: "B", code: `import { a } from "./My utils";` },
            { id: "c", name: "C", code: `import { b } from "./b";` },
            { id: "d", name: "D", code: `import { a } from "./my_utils.ts";` },
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
