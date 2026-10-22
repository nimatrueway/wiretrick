/**
 * saveScript resilience: when the MV3 sandbox compile RPC fails
 * (compileForStorage → the "sandbox compile failed" sentinel), the stored
 * script keeps its PREVIOUS meta/paramDefs instead of being corrupted into
 * a utility (𝑓 icon, active: false). A failed toggle/edit must never
 * destroy the script/utility state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

// compileForStorage is mocked per-test; saveScript imports it directly
const compileResult: any = { meta: { active: true, name: "x", match: ["*://*/*"], routes: [{ kind: "onRequest", index: 0, url: ["*://*/*"], exclude: [] }] }, paramDefs: { p: { type: "number", default: 1 } }, error: null };
vi.mock("../src/background/compileHost", () => ({
    compileForStorage: () => Promise.resolve(structuredClone(compileResult)),
    SANDBOX_COMPILE_FAILED: "sandbox compile failed",
}));

import { saveScript, newId } from "../src/background/engine/scriptStore";
import { defaultMeta } from "../src/shared/metaParser";

describe("saveScript sandbox-failure resilience", () => {
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
        compileResult.meta = { active: true, name: "x", match: ["*://*/*"], routes: [{ kind: "onRequest", index: 0, url: ["*://*/*"], exclude: [] }] };
        compileResult.paramDefs = { p: { type: "number", default: 1 } };
        compileResult.error = null;
    });

    it("a good save stores the compiled meta", async () => {
        const s = await saveScript({ id: newId(), name: "Good", code: "x" });
        expect(s.meta.active).toBe(true);
        expect(s.paramDefs?.p).toBeTruthy();
    });

    it("a failed sandbox compile keeps the previous meta/paramDefs", async () => {
        const id = newId();
        const good = await saveScript({ id, name: "Mine", code: "x" });
        compileResult.meta = { ...defaultMeta() }; // active: false
        compileResult.paramDefs = {};
        compileResult.error = "sandbox compile failed";
        const again = await saveScript({ id, code: "x" });
        expect(again.meta.active).toBe(true); // not corrupted to a library
        expect(again.meta.name).toBe("Mine"); // name kept
        expect(again.paramDefs?.p).toBeTruthy();
        expect(good.meta.active).toBe(true);
    });

    it("a first save with a failed sandbox compile stores defaults (nothing to keep)", async () => {
        compileResult.error = "sandbox compile failed";
        compileResult.meta = { ...defaultMeta() };
        const s = await saveScript({ id: newId(), name: "Fresh", code: "x" });
        expect(s.meta.active).toBe(false);
        expect(s.meta.name).toBe("Fresh"); // name still applies
        void s;
    });
});
