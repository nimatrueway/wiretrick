import { describe, it, expect, beforeEach } from "vitest";
import { ChromeBodyStrategy } from "../src/background/engine/strategies/chromeBodyStrategy";
import { parseMeta } from "../src/shared/metaParser";
import type { Script } from "../src/background/engine/scriptStore";

beforeEach(() => {
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://t/${p}`, sendMessage: async () => ({}) },
    };
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: parseMeta(code) };
}

describe("@mainframes off", () => {
    it("main_frame is allowed (no CDP) when all matching scripts declare it off", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `// ==ResScript==\n// @name api-only\n// @match *://x.com/*\n// @mainframes off\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`)]);
        const d = s.handleBeforeRequest({ url: "https://x.com/page", method: "GET", tabId: 1, type: "main_frame", requestId: "r" } as any, null);
        expect(d.kind).toBe("allow");
    });

    it("main_frame still needsCdp when any matching script wants main frames", () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("a", `// ==ResScript==\n// @name api-only\n// @match *://x.com/*\n// @mainframes off\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`),
            makeScript("b", `// ==ResScript==\n// @name html-rewriter\n// @match *://x.com/*\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`),
        ]);
        const d = s.handleBeforeRequest({ url: "https://x.com/page", method: "GET", tabId: 1, type: "main_frame", requestId: "r" } as any, null);
        expect(d.kind).toBe("needsCdp");
    });

    it("default (no @mainframes) keeps CDP behavior for main frames", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `// @match *://x.com/*\nres.modifyResponse((c, b) => b);`)]);
        expect(s.handleBeforeRequest({ url: "https://x.com/page", method: "GET", tabId: 1, type: "main_frame", requestId: "r" } as any, null).kind).toBe("needsCdp");
    });

    it("resource requests still go needsCdp regardless of @mainframes", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `// ==ResScript==\n// @name api-only\n// @match *://x.com/*\n// @mainframes off\n// ==/ResScript==\nres.modifyResponse((c, b) => b);`)]);
        const d = s.handleBeforeRequest({ url: "https://x.com/lib.js", method: "GET", tabId: 1, type: "script", requestId: "r" } as any, null);
        expect(d.kind).toBe("needsCdp");
    });
});
