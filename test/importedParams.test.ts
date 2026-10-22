/**
 * Param definitions imported from a utility script:
 *   import { envParam } from "./utils"; wt.params({ intercept_environments: envParam })
 * The save-time (meta-only) compile used to stub every import, so the def
 * reached wt.params as the stub proxy and the explorer showed a bogus
 * "needs a type" compile error while the editor's TypeScript was happy.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "../src/shared/transpile";
import { compileScript, compileWithLibs, makeStubModule } from "../src/shared/compile";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

const { saveScript, listScripts, setParamValue } = await import("../src/background/engine/scriptStore");
const { compileForStorage } = await import("../src/background/compileHost");

const UTILS = `
export const envParam = { type: "stringList", default: ["dev", "staging"], description: "environments" } as const;
export const defs = {
    verbose: { type: "boolean", default: false },
    mode: { type: "enum", choices: ["a", "b"], default: "b" },
} as const;
export const choices = ["x", "y"];
`;

const IMPORTER = `
import { envParam } from "./utils";
const p = wt.params({ intercept_environments: envParam });
wt.onRequest("*://*/*", () => { void p.intercept_environments; });
`;

const SPREAD = `
import { defs, choices } from "./utils";
const p = wt.params({ ...defs, pick: { type: "enum", choices, default: "y" } });
wt.onRequest("*://*/*", () => { void p.mode; });
`;

describe("imported param definitions", () => {
    it("a stubbed import never produces a bogus 'needs a type' compile error", () => {
        for (const code of [
            IMPORTER,
            SPREAD,
            `import { envParam } from "./utils"; wt.defineParam("e", envParam); wt.onRequest("*://*/*", () => {});`,
            `import { defs } from "./utils"; wt.params(defs); wt.onRequest("*://*/*", () => {});`,
            `import { t } from "./utils"; wt.params({ x: { type: t, default: 1 } }); wt.onRequest("*://*/*", () => {});`,
        ]) {
            const c = compileScript(code, { importModule: () => makeStubModule() });
            expect(c.error, code).toBeNull();
            expect(c.meta.active, code).toBe(true);
        }
    });

    it("a genuinely invalid inline def still errors", () => {
        const c = compileScript(`wt.params({ x: { default: 1 } }); wt.onRequest("*://*/*", () => {});`, { importModule: () => makeStubModule() });
        expect(c.error).toMatch(/parameter "x" needs a type/);
    });

    it("compileWithLibs resolves imports against the stored scripts (real defs)", () => {
        const scripts = [{ id: "u", name: "utils", code: UTILS }];
        const c = compileWithLibs({ id: "m", name: "main", code: IMPORTER }, scripts, {});
        expect(c.error).toBeNull();
        expect(c.paramDefs?.intercept_environments).toEqual({ type: "stringList", default: ["dev", "staging"], description: "environments" });
        expect(c.deps).toEqual(["utils"]);
        const s = compileWithLibs({ id: "m", name: "main", code: SPREAD }, scripts, { m: { mode: "a" } });
        expect(s.error).toBeNull();
        expect(Object.keys(s.paramDefs || {})).toEqual(["verbose", "mode", "pick"]);
        expect(s.paramDefs?.pick).toEqual({ type: "enum", choices: ["x", "y"], default: "y" });
    });

    it("compileWithLibs stubs imports that don't resolve (missing / broken library)", () => {
        const missing = compileWithLibs({ id: "m", name: "main", code: IMPORTER }, [], {});
        expect(missing.error).toBeNull();
        expect(missing.meta.active).toBe(true);
        const broken = compileWithLibs({ id: "m", name: "main", code: IMPORTER }, [{ id: "u", name: "utils", code: "throw new Error('boom')" }], {});
        expect(broken.error).toBeNull();
        expect(broken.meta.active).toBe(true);
    });

    it("compileForStorage (MV2) captures imported defs when given the stored scripts", async () => {
        const c = await compileForStorage(IMPORTER, "main", undefined, { id: "m", scripts: [{ id: "u", name: "utils", code: UTILS }] });
        expect(c.error).toBeNull();
        expect(c.paramDefs.intercept_environments?.type).toBe("stringList");
    });
});

describe("saveScript with imported params", () => {
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
    });

    it("stores paramDefs from the imported def and no compile error", async () => {
        await saveScript({ id: "u", name: "utils", code: UTILS });
        const s = await saveScript({ id: "m", name: "main", code: IMPORTER });
        expect(s.error).toBeNull();
        expect(s.meta.active).toBe(true);
        expect(s.paramDefs?.intercept_environments).toMatchObject({ type: "stringList" });
    });

    it("saving the library refreshes the importers' paramDefs", async () => {
        await saveScript({ id: "u", name: "utils", code: `export const envParam = { type: "boolean", default: true };` });
        await saveScript({ id: "m", name: "main", code: IMPORTER });
        await saveScript({ id: "u", code: UTILS });
        const main = (await listScripts()).find((x) => x.id === "m")!;
        expect(main.paramDefs?.intercept_environments).toMatchObject({ type: "stringList" });
        expect(main.error).toBeNull();
    });

    it("a script saved before its library exists is fixed once the library is saved", async () => {
        const first = await saveScript({ id: "m", name: "main", code: IMPORTER });
        expect(first.error).toBeNull();
        await saveScript({ id: "u", name: "utils", code: UTILS });
        const main = (await listScripts()).find((x) => x.id === "m")!;
        expect(main.paramDefs?.intercept_environments).toMatchObject({ type: "stringList" });
    });

    it("param values of the importer apply to imported defs", async () => {
        await saveScript({ id: "u", name: "utils", code: UTILS });
        await saveScript({ id: "m", name: "main", code: `import { envParam } from "./utils";\nconst p = wt.params({ e: envParam });\nif (p.e.includes("prod")) wt.onRequest("*://*/*", () => {});` });
        await setParamValue("m", "e", ["prod"]);
        const main = (await listScripts()).find((x) => x.id === "m")!;
        expect(main.meta.active).toBe(true);
    });
});
