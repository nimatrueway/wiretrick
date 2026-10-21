import { describe, it, expect } from "vitest";
import { dependantsOf, importKeys, missingImports } from "../src/shared/scriptImports";

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
