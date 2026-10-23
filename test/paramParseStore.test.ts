/**
 * Param `parse` through the store: defs persist without the function, the
 * stored / settings.yaml value stays raw, and a value the parser rejects
 * marks the script errored (a compile error naming the param — a problem, not a Log line).
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
            // structuredClone: a function left in the defs would throw here (like chrome.storage / postMessage)
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

const { saveScript, listScripts, setParamValue, loadAllParamValues } = await import("../src/background/engine/scriptStore");
const { currentSettingsState, getSettingsText, applySettingsText } = await import("../src/background/settingsFile");
const { addUiPort, getScriptErrors } = await import("../src/background/engine/logs");

const logs: { message: string; level: string; scriptId: string | null }[] = [];
addUiPort({ postMessage: (m: any) => m?.type === "log" && logs.push(m.entry), onDisconnect: { addListener: () => {} } } as any);

const CODE = `
const cfg = wt.params({ origin: { type: "string", default: "https://a.com", parse: (s) => new URL(s) } });
wt.onRequest(\`*://\${cfg.origin.host}/*\`, () => {});
`;
const get = async (id: string) => (await listScripts()).find((s) => s.id === id)!;

describe("param parse — store and settings", () => {
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
        logs.length = 0;
    });

    it("stores defs without parse; values and settings.yaml stay raw", async () => {
        const s = await saveScript({ id: "p", name: "parsed", code: CODE });
        expect(s.error).toBeNull();
        expect(s.meta.match).toEqual(["*://a.com/*"]);
        expect(s.paramDefs).toEqual({ origin: { type: "string", default: "https://a.com" } });
        expect(JSON.stringify(store.resScripts.p.paramDefs)).not.toContain("parse");

        expect((await applySettingsText("params:\n  parsed:\n    origin: https://b.org\n")).error).toBeUndefined();
        expect((await loadAllParamValues()).p).toEqual({ origin: "https://b.org" });
        expect((await get("p")).meta.match).toEqual(["*://b.org/*"]);
        const st = await currentSettingsState();
        expect(st.scripts.find((x) => x.name === "parsed")?.defs.origin).toEqual({ type: "string", default: "https://a.com" });
        expect(await getSettingsText()).toContain("origin: https://b.org");
    });

    it("a value the parser rejects: a compile error naming the param, not logged", async () => {
        await saveScript({ id: "p", name: "parsed", code: CODE });
        await setParamValue("p", "origin", "xyz");
        const s = await get("p");
        expect(s.error).toMatch(/param "origin": parse failed for value "xyz": Invalid URL/);
        expect(s.meta.active).toBe(false);
        expect((await loadAllParamValues()).p).toEqual({ origin: "xyz" }); // raw value kept: fixable from ⚙
        expect(logs.find((l) => l.level === "error" && l.scriptId === "p")).toBeUndefined();
        expect((await getScriptErrors()).get("p")).toBeUndefined(); // not a runtime error either
        // fixing the value clears the error
        await setParamValue("p", "origin", "https://c.io");
        expect((await get("p")).error).toBeNull();
        expect((await get("p")).meta.match).toEqual(["*://c.io/*"]);
    });
});
