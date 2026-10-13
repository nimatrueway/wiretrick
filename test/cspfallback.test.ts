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

const xhr = () => ({ url: "https://x.com/api", method: "GET", tabId: 7, type: "xmlhttprequest", requestId: "r" } as any);

describe("hook CSP-blocked fallback", () => {
    it("hookReady tab → allow; after markHookBroken → needsCdp", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `// @match *\nres.modifyResponse((c, b) => b);`)]);
        s.markHookReady(7);
        expect(s.handleBeforeRequest(xhr(), null).kind).toBe("allow");
        s.markHookBroken(7);
        expect(s.handleBeforeRequest(xhr(), null).kind).toBe("needsCdp");
    });

    it("forgetTab clears the broken state (fresh navigation can retry the hook)", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `// @match *\nres.modifyResponse((c, b) => b);`)]);
        s.markHookReady(7);
        s.markHookBroken(7);
        s.forgetTab(7);
        // after forgetting, cold-start fallback still routes to CDP (safe)
        expect(s.handleBeforeRequest(xhr(), null).kind).toBe("needsCdp");
    });
});
