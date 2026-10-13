import { describe, it, expect, beforeEach } from "vitest";
import { CdpStrategy } from "../src/background/engine/strategies/cdpStrategy";
import { parseMeta } from "../src/shared/metaParser";
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
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: parseMeta(code) };
}

describe("tier C participation gate", () => {
    it("script with @strategy hook only is NOT loaded into CdpStrategy", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `// ==ResScript==\n// @name hooky\n// @match *\n// @strategy hook\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/anything")).toEqual([]);
    });

    it("script with @strategy cdp IS loaded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `// ==ResScript==\n// @name cdponly\n// @match *\n// @strategy cdp\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/").length).toBe(1);
    });

    it("auto strategy participates (default hook→cdp)", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `// ==ResScript==\n// @name autob\n// @match *\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/").length).toBe(1);
    });

    it("hook,proxy list without cdp → excluded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `// ==ResScript==\n// @name nope\n// @match *\n// @strategy hook,proxy\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`)]);
        expect(c.cdpRelevantScripts("https://x.com/")).toEqual([]);
    });

    it("disabled scripts never load", () => {
        const s = makeScript("a", `// ==ResScript==\n// @name x\n// @match *\n// @strategy cdp\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`);
        s.enabled = false;
        const c = new CdpStrategy();
        c.reload([s]);
        expect(c.cdpRelevantScripts("https://x.com/")).toEqual([]);
    });
});
