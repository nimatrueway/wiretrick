import { describe, it, expect, beforeEach } from "vitest";
import { CdpStrategy } from "../src/background/engine/strategies/cdpStrategy";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

beforeEach(() => {
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://t/${p}` },
        storage: {
            local: {
                get: async () => ({}),
                set: async () => {},
            },
        },
    };
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

describe("tier C participation gate", () => {
    it("script with @strategy hook only is NOT loaded into CdpStrategy", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.declareScript({ match: ["*"], strategy: ["hook"] });\nwt.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/anything")).toEqual([]);
    });

    it("script with @strategy cdp IS loaded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.declareScript({ match: ["*"], strategy: ["cdp"] });\nwt.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/").length).toBe(1);
    });

    it("auto strategy participates (default hook→cdp)", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.declareScript({ match: ["*"] });\nwt.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/").length).toBe(1);
    });

    it("hook-only list without cdp → excluded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.declareScript({ match: ["*"], strategy: ["hook"] });\nwt.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/")).toEqual([]);
    });

    it("disabled scripts never load", () => {
        const s = makeScript("a", `wt.declareScript({ match: ["*"], strategy: ["cdp"] });\nwt.modifyResponse((c, b) => b);`);
        s.enabled = false;
        const c = new CdpStrategy();
        c.reload([s]);
        expect(c.cdpRelevantScripts("https://x.com/")).toEqual([]);
    });
});
