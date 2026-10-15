import { describe, it, expect, beforeEach } from "vitest";
import { ChromeBodyStrategy } from "../src/background/engine/strategies/chromeBodyStrategy";
import { compileScript } from "../src/shared/compile";
import { parseStrategyList } from "../src/shared/metaParser";
import type { Script } from "../src/background/engine/scriptStore";

beforeEach(() => {
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://t/${p}`, sendMessage: async () => ({}) },
    };
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

const xhr = (url = "https://x.com/api") =>
    ({ url, method: "GET", tabId: 1, type: "xmlhttprequest", requestId: "r" } as any);
const mainFrame = (url = "https://x.com/") =>
    ({ url, method: "GET", tabId: 1, type: "main_frame", requestId: "r" } as any);

describe("parseStrategyList", () => {
    it("parses comma lists, trims, lowercases, dedups invalid", () => {
        expect(parseStrategyList("hook, cdp")).toEqual(["hook", "cdp"]);
        expect(parseStrategyList("CDP")).toEqual(["cdp"]);
        expect(parseStrategyList("bogus,hook")).toEqual(["hook"]);
        expect(parseStrategyList("")).toEqual(["auto"]);
    });
});

describe("@strategy priority lists", () => {
    it("hook,cdp: hook-ready tab → allow (no debugger)", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `res.declareScript({ match: ["*"], strategy: ["hook", "cdp"] });\nres.modifyResponse((c, b) => b);`)]);
        s.markHookReady(1);
        expect((s.handleBeforeRequest(xhr(), null) as any).kind).toBe("allow");
    });

    it("hook,cdp: hook NOT ready → needsCdp (cold start fallback)", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `res.declareScript({ match: ["*"], strategy: ["hook", "cdp"] });\nres.modifyResponse((c, b) => b);`)]);
        expect((s.handleBeforeRequest(xhr(), null) as any).kind).toBe("needsCdp");
    });

    it("cdp,hook: debugger first, even when hook is ready", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `res.declareScript({ match: ["*"], strategy: ["cdp", "hook"] });\nres.modifyResponse((c, b) => b);`)]);
        s.markHookReady(1);
        expect((s.handleBeforeRequest(xhr(), null) as any).kind).toBe("needsCdp");
    });

    it("cdp-only: main frame → needsCdp; hook-only list never touches CDP", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `res.declareScript({ match: ["*"], strategy: ["cdp"] });\nres.modifyResponse((c, b) => b);`)]);
        expect((s.handleBeforeRequest(mainFrame(), null) as any).kind).toBe("needsCdp");

        const s2 = new ChromeBodyStrategy();
        s2.reload([makeScript("b", `res.declareScript({ match: ["*"], strategy: ["hook"] });\nres.modifyResponse((c, b) => b);`)]);
        expect((s2.handleBeforeRequest(mainFrame(), null) as any).kind).toBe("allow");
    });

    it("multiple scripts: first script's hook choice wins before second's cdp", () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("a", `res.declareScript({ match: ["*"], strategy: ["hook"] });\nres.modifyResponse((c, b) => b);`),
            makeScript("b", `res.declareScript({ match: ["*"], strategy: ["cdp"] });\nres.modifyResponse((c, b) => b);`),
        ]);
        s.markHookReady(1);
        expect((s.handleBeforeRequest(xhr(), null) as any).kind).toBe("allow");
    });
});
