/**
 * res.declareScript: meta override + typed parameters.
 */
import { describe, expect, it } from "vitest";
import { compileScript } from "../src/shared/compile";
import { paramDefault, resolveParamValues, isValidParamValue } from "../src/shared/scriptDef";

const CODE = `
const cfg = res.declareScript({
    name: "Declared name",
    match: ["*://a.com/*", "*://b.com/*"],
    strategy: ["hook", "cdp"],
    runAt: "document_idle",
    params: {
        flag: { type: "boolean", default: true },
        note: { type: "string", default: "hi" },
        mode: { type: "enum", choices: ["a", "b"], default: "b" },
        hosts: { type: "stringList", default: ["x"] },
    },
});
res.log("flag", cfg.flag);
res.onRequest(() => (cfg.flag ? { cancel: true } : undefined));
`;

describe("declareScript", () => {
    it("overrides meta fields from the comment block", () => {
        const c = compileScript(`// @name Comment name\n${CODE}`);
        expect(c.meta.name).toBe("Declared name");
        expect(c.meta.match).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(c.meta.strategy).toBe("hook,cdp");
        expect(c.meta.runAt).toBe("document_idle");
        expect(c.error).toBeNull();
        expect(c.handlers.onRequest).toHaveLength(1);
    });

    it("collects param defs", () => {
        const c = compileScript(CODE);
        expect(Object.keys(c.paramDefs || {})).toEqual(["flag", "note", "mode", "hosts"]);
    });

    it("returns defaults when nothing stored", () => {
        const seen: any[] = [];
        const c = compileScript(CODE, { log: (...a: any[]) => seen.push(a) });
        expect(c.error).toBeNull();
        expect(seen[0]).toEqual(["flag", true]);
    });

    it("stored values override defaults; invalid fall back", () => {
        const seen: any[] = [];
        const c = compileScript(CODE, {
            paramValues: { flag: false, mode: "a", note: 42, hosts: "nope" },
            log: (...a: any[]) => seen.push(a),
        });
        expect(c.error).toBeNull();
        expect(seen[0]).toEqual(["flag", false]);
        const values = resolveParamValues(c.paramDefs!, { flag: false, mode: "a", note: 42, hosts: "nope" });
        expect(values).toEqual({ flag: false, note: "hi", mode: "a", hosts: ["x"] });
    });

    it("scripts without declareScript still work", () => {
        const c = compileScript(`// @name Plain\nres.onRequest(() => {});`);
        expect(c.meta.name).toBe("Plain");
        expect(c.paramDefs).toBeUndefined();
    });
});

describe("param helpers", () => {
    it("defaults per type", () => {
        expect(paramDefault({ type: "boolean" })).toBe(false);
        expect(paramDefault({ type: "string" })).toBe("");
        expect(paramDefault({ type: "enum", choices: ["a", "b"] })).toBe("a");
        expect(paramDefault({ type: "stringList" })).toEqual([]);
    });
    it("validates values", () => {
        expect(isValidParamValue({ type: "boolean" }, true)).toBe(true);
        expect(isValidParamValue({ type: "boolean" }, "yes")).toBe(false);
        expect(isValidParamValue({ type: "enum", choices: ["a"] }, "b")).toBe(false);
        expect(isValidParamValue({ type: "stringList" }, ["a", "b"])).toBe(true);
        expect(isValidParamValue({ type: "stringList" }, ["a", 1])).toBe(false);
    });
});
