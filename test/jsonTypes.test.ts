import { describe, expect, it } from "vitest";
import { dataPathOfDecl, jsonDeclPath, jsonModuleDts, jsonType } from "../src/ui/jsonTypes";

describe("jsonType", () => {
    it("widens primitives", () => {
        expect(jsonType(1)).toBe("number");
        expect(jsonType("x")).toBe("string");
        expect(jsonType(true)).toBe("boolean");
        expect(jsonType(null)).toBe("null");
    });

    it("arrays: element union, any[] when empty", () => {
        expect(jsonType([])).toBe("any[]");
        expect(jsonType([1, 2])).toBe("number[]");
        expect(jsonType([1, "a"])).toBe("(number | string)[]");
    });

    it("objects, quoting keys that aren't identifiers", () => {
        expect(jsonType({})).toBe("{}");
        expect(jsonType({ a: 1, "b-c": { d: [true] } })).toBe('{\n    a: number;\n    "b-c": {\n        d: boolean[];\n    };\n}');
    });
});

describe("jsonModuleDts", () => {
    it("declares the module's export", () => {
        expect(jsonModuleDts('{"limit": 3}')).toBe("declare const data: {\n    limit: number;\n};\nexport = data;\n");
    });

    it("invalid JSON is any", () => {
        expect(jsonModuleDts("{ nope")).toBe("declare const data: any;\nexport = data;\n");
    });
});

describe("declaration paths", () => {
    it("sits next to the data file", () => {
        expect(jsonDeclPath("mock/rate-limits.json")).toBe("mock/rate-limits.d.json.ts");
    });

    it("maps back, decoding", () => {
        expect(dataPathOfDecl("file:///mock/rate-limits.d.json.ts")).toBe("mock/rate-limits.json");
        expect(dataPathOfDecl("file:///my%20mocks/a.d.json.ts")).toBe("my mocks/a.json");
        expect(dataPathOfDecl("file:///mock/a.ts")).toBeNull();
    });
});
