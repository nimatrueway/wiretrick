/**
 * Utility scripts (no handlers at top level) with params: their params are
 * editable (popup / settings.yaml), and a param value may make them
 * register handlers — changing it must turn the utility into a script
 * (stored meta, settings.yaml `enabled`, reload) and back.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "../src/shared/transpile";

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

const { saveScript, listScripts, setParamValue, loadAllParamValues, onScriptsChanged } = await import("../src/background/engine/scriptStore");
const { analyzeScripts } = await import("../src/background/compileHost");
const { currentSettingsState, applySettingsText } = await import("../src/background/settingsFile");

const GATE = `
const p = wt.params({ on: { type: "boolean", default: false, description: "intercept" } });
export const helper = () => p.on;
if (p.on) wt.onRequest("*://example.com/*", () => ({ block: true }));
`;

const get = async (id: string) => (await listScripts()).find((s) => s.id === id)!;

describe("library scripts with params", () => {
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
    });

    it("stores a param-gated library as a library with its paramDefs", async () => {
        const s = await saveScript({ id: "g", name: "gate", code: GATE });
        expect(s.error).toBeNull();
        expect(s.meta.active).toBe(false);
        expect(s.paramDefs?.on).toMatchObject({ type: "boolean" });
    });

    it("changing the param turns it into a script and back (stored meta)", async () => {
        await saveScript({ id: "g", name: "gate", code: GATE });
        let notified = 0;
        const off = onScriptsChanged(() => notified++);
        await setParamValue("g", "on", true);
        let s = await get("g");
        expect(s.meta.active).toBe(true);
        expect(s.meta.match).toEqual(["*://example.com/*"]);
        expect(s.meta.name).toBe("gate");
        expect(notified).toBeGreaterThan(0);
        // a later save (e.g. setEnabled) compiles with the stored values too
        s = await saveScript({ id: "g", code: GATE });
        expect(s.meta.active).toBe(true);
        await setParamValue("g", "on", false);
        s = await get("g");
        expect(s.meta.active).toBe(false);
        expect(s.paramDefs?.on).toBeTruthy();
        off();
    });

    it("the reload-time analyze uses the param values", async () => {
        await saveScript({ id: "g", name: "gate", code: GATE });
        const scripts = [{ id: "g", name: "gate", code: GATE, updatedAt: 1 }];
        expect((await analyzeScripts(scripts, {})).get("g")!.meta.active).toBe(false);
        expect((await analyzeScripts(scripts, { g: { on: true } })).get("g")!.meta.active).toBe(true);
    });

    it("settings.yaml lists the library's params and gains `enabled` once it's a script", async () => {
        await saveScript({ id: "g", name: "gate", code: GATE });
        let st = await currentSettingsState();
        expect(st.scripts.find((x) => x.name === "gate")).toMatchObject({ declared: false, defs: { on: { type: "boolean" } } });
        expect((await applySettingsText("params:\n  gate:\n    on: true\n")).error).toBeUndefined();
        expect((await loadAllParamValues()).g).toEqual({ on: true });
        expect((await get("g")).meta.active).toBe(true);
        st = await currentSettingsState();
        expect(st.scripts.find((x) => x.name === "gate")?.declared).toBe(true);
    });

    it("importers keep working when a library flips (its exports stay importable)", async () => {
        await saveScript({ id: "g", name: "gate", code: GATE });
        const m = await saveScript({ id: "m", name: "main", code: `import { helper } from "./gate";\nwt.onRequest("*://a.test/*", () => { helper(); });` });
        expect(m.error).toBeNull();
        expect(m.meta.active).toBe(true);
        await setParamValue("g", "on", true);
        expect((await get("m")).error).toBeNull();
    });
});
