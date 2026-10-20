/**
 * wt.declareScript: meta override + typed parameters.
 */
import { describe, expect, it } from "vitest";
import "../src/shared/transpile"; // register the sucrase TS/imports transpiler
import { compileScript } from "../src/shared/compile";
import { paramDefault, resolveParamValues, isValidParamValue } from "../src/shared/scriptDef";

const CODE = `
const cfg = wt.declareScript({
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
wt.log("flag", cfg.flag);
wt.onRequest(() => (cfg.flag ? { cancel: true } : undefined));
`;

describe("declareScript", () => {
    it("sets meta fields", () => {
        const c = compileScript(CODE);
        expect(c.meta.name).toBe("Untitled script"); // declareScript has no name field — the script/file name is authoritative
        expect(c.meta.match).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(c.meta.strategy).toBe("hook,cdp");
        expect(c.meta.runAt).toBe("document_idle");
        expect(c.meta.declared).toBe(true);
        expect(c.error).toBeNull();
        expect(c.handlers.onRequest).toHaveLength(1);
    });

    it("collects param defs", () => {
        const c = compileScript(CODE);
        expect(Object.keys(c.paramDefs || {})).toEqual(["flag", "note", "mode", "hosts"]);
    });

    it("returns defaults when nothing stored", () => {
        const seen: any[] = [];
        const c = compileScript(CODE, { logSink: (_l, _s, text) => seen.push(text) });
        expect(c.error).toBeNull();
        expect(seen[0]).toBe("flag true");
    });

    it("stored values override defaults; invalid fall back", () => {
        const seen: any[] = [];
        const c = compileScript(CODE, {
            paramValues: { flag: false, mode: "a", note: 42, hosts: "nope" },
            logSink: (_l, _s, text) => seen.push(text),
        });
        expect(c.error).toBeNull();
        expect(seen[0]).toBe("flag false");
        const values = resolveParamValues(c.paramDefs!, { flag: false, mode: "a", note: 42, hosts: "nope" });
        expect(values).toEqual({ flag: false, note: "hi", mode: "a", hosts: ["x"] });
    });

    it("scripts without declareScript are inert libraries", () => {
        const c = compileScript(`export const helper = () => 42;`);
        expect(c.meta.declared).toBe(false);
        expect(c.error).toBeNull();
        expect(c.handlers.onRequest).toHaveLength(0);
    });

    it("exports are importable via the module resolver", async () => {
        const { makeModuleResolver } = await import("../src/shared/compile");
        const lib = { id: "l1", name: "utils", code: `export function double(n) { return n * 2; }` };
        const user = {
            id: "s1",
            name: "user",
            code: `import { double } from "./utils";\nwt.declareScript({ match: ["*"] });\nwt.onRequest(() => double(21) === 42 ? { cancel: true } : undefined);`,
        };
        const resolver = makeModuleResolver([lib, user], () => ({}));
        const c = compileScript(user.code, { importModule: resolver.resolve });
        expect(c.error).toBeNull();
        expect(c.meta.declared).toBe(true);
        expect(c.handlers.onRequest[0]({})).toEqual({ cancel: true });
        expect([...resolver.deps]).toEqual(["utils"]);
    });

    it("missing imports surface as compile errors", async () => {
        const { makeModuleResolver } = await import("../src/shared/compile");
        const resolver = makeModuleResolver([], () => ({}));
        const c = compileScript(`import { x } from "./nope";\nwt.log(x);`, { importModule: resolver.resolve });
        expect(c.error).toContain("unknown module");
    });
});

describe("param helpers", () => {
    it("defaults per type", () => {
        expect(paramDefault({ type: "boolean" })).toBe(false);
        expect(paramDefault({ type: "number" })).toBe(0);
        expect(paramDefault({ type: "number", default: 5 })).toBe(5);
        expect(paramDefault({ type: "string" })).toBe("");
        expect(paramDefault({ type: "enum", choices: ["a", "b"] })).toBe("a");
        expect(paramDefault({ type: "stringList" })).toEqual([]);
    });
    it("validates values", () => {
        expect(isValidParamValue({ type: "string", multiline: true }, "a\nb")).toBe(true);
        expect(isValidParamValue({ type: "boolean" }, true)).toBe(true);
        expect(isValidParamValue({ type: "boolean" }, "yes")).toBe(false);
        expect(isValidParamValue({ type: "number" }, 42)).toBe(true);
        expect(isValidParamValue({ type: "number" }, "42")).toBe(false);
        expect(isValidParamValue({ type: "number" }, NaN)).toBe(false);
        expect(isValidParamValue({ type: "enum", choices: ["a"] }, "b")).toBe(false);
        expect(isValidParamValue({ type: "stringList" }, ["a", "b"])).toBe(true);
        expect(isValidParamValue({ type: "stringList" }, ["a", 1])).toBe(false);
    });
});

describe("saveScript name handling", () => {
    it("keeps the previous name when re-saved without one (setEnabled path)", async () => {
        const store = new Map<string, any>();
        (globalThis as any).chrome = {
            runtime: { lastError: undefined },
            storage: {
                local: {
                    get: (keys: any, cb: (o: any) => void) => cb(Object.fromEntries(store)),
                    set: (items: any, cb?: () => void) => { for (const [k, v] of Object.entries(items)) store.set(k, v); cb?.(); },
                },
            },
        };
        const { saveScript, setEnabled, getScript } = await import("../src/background/engine/scriptStore");
        await saveScript({ id: "s1", code: `wt.declareScript({ match: ["*"] });\nwt.onRequest(() => {});`, name: "redwood" });
        expect((await getScript("s1"))!.meta.name).toBe("redwood");
        await setEnabled("s1", false);
        expect((await getScript("s1"))!.meta.name).toBe("redwood");
        expect((await getScript("s1"))!.enabled).toBe(false);
    });
});
