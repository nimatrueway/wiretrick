import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { WebRequestStrategy } from "../src/background/engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "../src/background/engine/strategies/chromeBodyStrategy";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

// these suites exercise the webRequest tier: make it the settings default
beforeEach(() => setDefaultStrategy("webrequest"));
afterEach(() => setDefaultStrategy(null));

beforeEach(() => {
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://t/${p}`, sendMessage: async () => ({}) },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        webRequest: {
            onBeforeRequest: { addListener: vi.fn() },
            onBeforeSendHeaders: { addListener: vi.fn() },
            onHeadersReceived: { addListener: vi.fn() },
            onCompleted: { addListener: vi.fn() },
            onErrorOccurred: { addListener: vi.fn() },
        },
        tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    };
    delete (globalThis as any).browser;
    new WebRequestStrategy().pruneRequest("r1");
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

const details = () => ({
    url: "https://api.example.com/v1/user",
    method: "GET",
    tabId: 1,
    type: "xmlhttprequest",
    requestId: "r1",
    requestHeaders: [],
});

describe("onRequest respond", () => {
    it("webRequest tier: object body → JSON data-url redirect", () => {
        const s = new WebRequestStrategy();
        s.reload([makeScript("a", `wt.onRequest("*", () => ({ respond: { body: { mocked: true } } }));`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        expect(decodeURIComponent(d.url)).toContain('"mocked"');
        expect(d.url).toContain("application/json");
    });

    it("webRequest tier: string body + explicit mime", () => {
        const s = new WebRequestStrategy();
        s.reload([makeScript("a", `wt.onRequest("*", () => ({ respond: { body: "<h1>hi</h1>", mime: "text/html" } }));`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        expect(d.url).toContain("text/html");
    });

    it("respond is terminal: later scripts don't run", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => ({ respond: { body: "first" } }));`),
            makeScript("b", `wt.onRequest("*", () => ({ redirect: "https://second.com" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        expect(d.url).toContain("first");
    });

    it("hook tier: runRequestDecision returns the respond decision (async handler)", async () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `wt.onRequest({ url: "*", strategy: "hook" }, async () => ({ respond: { body: { ok: 1 }, status: 201 } }));`)]);
        const r = await s.runRequestDecision("https://api.example.com/v1/user", "GET");
        expect(r).not.toBeNull();
        expect(r!.kind).toBe("respond");
        expect((r as any).content).toBe('{"ok":1}');
        expect((r as any).status).toBe(201);
    });

    it("hook tier: non-respond scripts → headers merged or null", async () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `wt.onRequest({ url: "*", strategy: "hook" }, () => ({ headers: { set: { "x": "1" } } }));`)]);
        const r = await s.runRequestDecision("https://api.example.com/v1/user", "GET");
        expect(r!.kind).toBe("headers");
    });

    it("hook tier: redirect and cancel decisions pass through", async () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("r", `wt.onRequest({ url: "*", strategy: "hook" }, () => ({ redirect: "https://r.com" }));`),
        ]);
        expect((await s.runRequestDecision("https://x.com/", "GET"))!.kind).toBe("redirect");
        const s2 = new ChromeBodyStrategy();
        s2.reload([makeScript("c", `wt.onRequest({ url: "*", strategy: "hook" }, () => ({ cancel: true }));`)]);
        expect((await s2.runRequestDecision("https://x.com/", "GET"))!.kind).toBe("cancel");
    });

    it("webRequest tier: respond + headers in one result apply the headers", () => {
        const s = new WebRequestStrategy();
        s.reload([makeScript("a", `wt.onRequest("*", () => ({ respond: { body: "x" }, headers: { set: { "x-m": "1" } } }));`)]);
        s.handleBeforeRequest(details(), null);
        const c = s.handleBeforeSendHeaders(details(), null) as any;
        expect(c.set).toEqual({ "x-m": "1" });
    });
});

describe("replacementContent (webrequest)", () => {
    it("serves a plain object as JSON, like the other tiers", async () => {
        const { replacementContent } = await import("../src/background/engine/strategies/webRequestStrategy");
        expect(replacementContent({ url: "https://dummyjson.com/users/1", type: "main_frame" }, { mocked: true })).toEqual({ mime: "application/json", content: '{"mocked":true}' });
        expect(replacementContent({ url: "https://x.test/a", type: "xmlhttprequest" }, [1, 2])).toEqual({ mime: "application/json", content: "[1,2]" });
        expect(replacementContent({ url: "https://x.test/a.html", type: "main_frame" }, "<p>hi</p>")).toEqual({ mime: "text/html", content: "<p>hi</p>" });
        expect(replacementContent({ url: "https://x.test/a", type: "main_frame" }, null)).toBeNull();
    });
});
