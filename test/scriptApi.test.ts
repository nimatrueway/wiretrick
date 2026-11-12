/**
 * Script API: per-handler routes, tt.metadata, tt.params / tt.defineParam,
 * and utilities (no handlers).
 */
import { describe, expect, it } from "vitest";
import "../src/shared/transpile"; // register the sucrase TS/imports transpiler
import { compileScript } from "../src/shared/compile";
import { paramDefault, resolveParamValues, isValidParamValue } from "../src/shared/scriptDef";

const CODE = `
tt.metadata({ description: "Blocks things" });
const cfg = tt.params({
    flag: { type: "boolean", default: true },
    note: { type: "string", default: "hi" },
    mode: { type: "enum", choices: ["a", "b"], default: "b" },
});
const hosts = tt.defineParam("hosts", { type: "stringList", default: ["x"] });
tt.log("flag", cfg.flag, hosts.join());
tt.onRequest({ url: ["*://a.com/*", "*://b.com/*"], strategy: "page" }, () => (cfg.flag ? { block: true } : undefined));
tt.onResponseBody({ url: "*://b.com/*", strategy: "helper" }, (c, b) => b);
`;

describe("script API", () => {
    it("routes, description and meta", () => {
        const c = compileScript(CODE);
        expect(c.error).toBeNull();
        expect(c.meta.name).toBe("Untitled script"); // the script/file name is authoritative
        expect(c.meta.description).toBe("Blocks things");
        expect(c.meta.active).toBe(true);
        expect(c.meta.match).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(c.meta.routes.map((r) => [r.kind, r.strategy])).toEqual([
            ["onRequest", "page"],
            ["onResponseBody", "helper"],
        ]);
        expect(c.handlers.onRequest).toHaveLength(1);
        expect(c.handlers.onRequest[0].route.url).toEqual(["*://a.com/*", "*://b.com/*"]);
    });

    it("collects param defs from tt.params and tt.defineParam", () => {
        const c = compileScript(CODE);
        expect(Object.keys(c.paramDefs || {})).toEqual(["flag", "note", "mode", "hosts"]);
    });

    it("returns defaults when nothing stored", () => {
        const seen: any[] = [];
        const c = compileScript(CODE, { logSink: (_l, _s, text) => seen.push(text) });
        expect(c.error).toBeNull();
        expect(seen[0]).toBe("flag true x");
    });

    it("stored values override defaults; invalid fall back", () => {
        const seen: any[] = [];
        const stored = { flag: false, mode: "a", note: 42, hosts: "nope" };
        const c = compileScript(CODE, { paramValues: stored, logSink: (_l, _s, text) => seen.push(text) });
        expect(c.error).toBeNull();
        expect(seen[0]).toBe("flag false x");
        expect(resolveParamValues(c.paramDefs!, stored)).toEqual({ flag: false, note: "hi", mode: "a", hosts: ["x"] });
    });

    it("params can feed routes", () => {
        const c = compileScript(`const p = tt.params({ host: { type: "string", default: "a.com" } });\ntt.onRequest({ url: \`*://\${p.host}/*\`, strategy: "helper" }, () => {});`, { paramValues: { host: "z.org" } });
        expect(c.error).toBeNull();
        expect(c.meta.match).toEqual(["*://z.org/*"]);
    });

    it("bad param definitions and duplicates are script errors", () => {
        expect(compileScript(`tt.params({ a: { default: 1 } });`).error).toMatch(/needs a type/);
        expect(compileScript(`tt.params({ a: { type: "enum" } });`).error).toMatch(/needs choices/);
        expect(compileScript(`tt.params({ a: { type: "number" } }); tt.defineParam("a", { type: "number" });`).error).toMatch(/already defined/);
    });

    it("a script without handlers is a library (params allowed)", () => {
        const c = compileScript(`tt.params({ n: { type: "number", default: 2 } });\nexport const helper = () => 42;`);
        expect(c.error).toBeNull();
        expect(c.meta.active).toBe(false);
        expect(c.paramDefs).toHaveProperty("n");
        expect(c.handlers.onRequest).toHaveLength(0);
    });

    it("route errors surface as script errors", () => {
        expect(compileScript(`tt.onRequest(() => {});`).error).toMatch(/first argument must be a route \{ url, strategy \}/);
        expect(compileScript(`tt.onRequest("*", () => {});`).error).toMatch(/bare URL pattern has no strategy/);
        expect(compileScript(`tt.onRequest({ url: "*" }, () => {});`).error).toMatch(/missing "strategy"/);
        expect(compileScript(`tt.onPage("*", () => {});`).error).toBeNull();
        expect(compileScript(`tt.onRequest({ match: "*", strategy: "helper" }, () => {});`).error).toMatch(/"url", not "match"/);
        expect(compileScript(`tt.onRequest({ url: "*", strategy: ["page", "debugger"] }, () => {});`).error).toMatch(/single value/);
        expect(compileScript(`tt.onRequest({ url: "*", strategy: "auto" }, () => {});`).error).toMatch(/unknown strategy/);
        expect(compileScript(`tt.onRequest({ url: "*", resourceTypes: ["nope"], strategy: "helper" }, () => {});`).error).toMatch(/unknown resource type/);
        expect(compileScript(`tt.onPage({ url: "*", strategy: "page" }, () => {});`).error).toMatch(/doesn't apply to onPage/);
        expect(compileScript(`tt.onRequest({ url: "*", strategy: "helper" }, 1);`).error).toMatch(/second argument/);
    });

    it("exports are importable via the module resolver", async () => {
        const { makeModuleResolver } = await import("../src/shared/compile");
        const lib = { id: "l1", name: "utils", code: `export function double(n) { return n * 2; }` };
        const user = {
            id: "s1",
            name: "user",
            code: `import { double } from "./utils";\ntt.onRequest({ url: "*", strategy: "helper" }, () => double(21) === 42 ? { block: true } : undefined);`,
        };
        const resolver = makeModuleResolver([lib, user], () => ({}));
        const c = compileScript(user.code, { importModule: resolver.resolve });
        expect(c.error).toBeNull();
        expect(c.meta.active).toBe(true);
        expect(c.handlers.onRequest[0].fn({})).toEqual({ block: true });
        expect([...resolver.deps]).toEqual(["utils"]);
    });

    it("missing imports surface as compile errors", async () => {
        const { makeModuleResolver } = await import("../src/shared/compile");
        const resolver = makeModuleResolver([], () => ({}));
        const c = compileScript(`import { x } from "./nope";\ntt.log(x);`, { importModule: resolver.resolve });
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
        await saveScript({ id: "s1", code: `tt.onRequest({ url: "*", strategy: "helper" }, () => {});`, name: "redwood" });
        expect((await getScript("s1"))!.meta.name).toBe("redwood");
        await setEnabled("s1", false);
        expect((await getScript("s1"))!.meta.name).toBe("redwood");
        expect((await getScript("s1"))!.enabled).toBe(false);
    });
});
