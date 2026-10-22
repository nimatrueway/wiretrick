import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { WebRequestStrategy } from "../src/background/engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "../src/background/engine/strategies/chromeBodyStrategy";
import type { Script } from "../src/background/engine/scriptStore";
import { compileScript } from "../src/shared/compile";

// ---- chrome mock ----
const storageData: Record<string, any> = {};
const listeners: { [k: string]: Function[] } = {};

function mockChrome() {
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[] | string) => {
                    const out: Record<string, any> = {};
                    for (const k of Array.isArray(keys) ? keys : [keys]) {
                        if (k in storageData) out[k] = JSON.parse(JSON.stringify(storageData[k]));
                    }
                    return out;
                },
                set: async (obj: Record<string, any>) => {
                    for (const [k, v] of Object.entries(obj)) storageData[k] = v;
                },
            },
        },
        runtime: {
            getURL: (p: string) => `chrome-extension://testid/${p}`,
            sendMessage: vi.fn(async () => ({})),
            onMessage: { addListener: vi.fn() },
            onConnect: { addListener: vi.fn() },
        },
        tabs: {
            onUpdated: { addListener: vi.fn() },
            onRemoved: { addListener: vi.fn() },
        },
        webRequest: {
            onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
            onBeforeSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
            onHeadersReceived: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        debugger: undefined,
    };
}

beforeEach(() => {
    mockChrome();
});

function makeScript(id: string, code: string, enabled = true): Script {
    return {
        id,
        code,
        enabled,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
        meta: compileScript(code).meta,
    };
}

const details = (over: Partial<any> = {}) => ({
    url: "https://api.example.com/v1/data",
    method: "GET",
    tabId: 1,
    type: "xmlhttprequest",
    requestId: "r1",
    requestHeaders: [{ name: "accept", value: "application/json" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    statusLine: "HTTP/1.1 200 OK",
    statusCode: 200,
    ...over,
});

describe("WebRequestStrategy", () => {
    beforeEach(() => setDefaultStrategy("webRequest"));
    afterEach(() => setDefaultStrategy(null));
    it("onRequest redirect", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*://api.example.com/*", (ctx) => ({ redirect: "https://mocked.example.com/data" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), "https://app.example.com/") as any;
        expect(d).toEqual({ kind: "redirect", url: "https://mocked.example.com/data" });
    });

    it("non-matching url → allow", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*://other.com/*", () => ({ redirect: "https://x.com" }));`),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });

    it("disabled script does nothing", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => ({ block: true }));`, false),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });

    it("static replaceResponse → data url redirect", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.replaceResponse("*://api.example.com/v1/data", () => JSON.stringify({ mocked: true }));`),
        ]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        if (d.kind === "redirect") {
            expect(d.url).toContain("data:application/json");
            expect(decodeURIComponent(d.url)).toContain('"mocked"');
        }
    });

    it("onResponseHeaders modifies headers", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onResponseHeaders("*://api.example.com/*", () => ({ headers: { set: { "access-control-allow-origin": "*" }, remove: ["x-frame-options"] } }));`),
        ]);
        const changes = s.handleHeadersReceived(details(), null) as any;
        expect(changes).not.toBeNull();
        expect(changes!.set).toEqual({ "access-control-allow-origin": "*" });
        expect(changes!.remove).toEqual(["x-frame-options"]);
    });

    it("request header modification via onRequest (run once, cached for header phase)", () => {
        const s = new WebRequestStrategy();
        const code = `wt.onRequest("*://api.example.com/*", () => ({ headers: { set: { authorization: "Bearer x" } } }));`;
        s.reload([makeScript("a", code)]);
        // header phase alone does nothing (cache empty — onRequest hasn't run)
        expect(s.handleBeforeSendHeaders(details(), null)).toBeNull();
        // request phase runs onRequest and caches the header mods
        s.handleBeforeRequest(details(), null);
        const changes = s.handleBeforeSendHeaders(details(), null) as any;
        expect(changes!.set).toEqual({ authorization: "Bearer x" });
    });

    it("script throwing does not break the pipeline", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => { throw new Error("boom"); });`),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });
});

describe("ChromeBodyStrategy (hook tier)", () => {
    it("owns only hook routes and never asks for the debugger itself", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "page" }, (ctx, body) => body);`)]);
        expect(s.hasOwners()).toBe(true);
        expect((s.handleBeforeRequest(details({ type: "script" }), null) as any).kind).toBe("allow");
        s.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "debugger" }, (ctx, body) => body);`)]);
        expect(s.hasOwners()).toBe(false);
    });

    it("claimed urls (tier A) are tracked", () => {
        const s = new ChromeBodyStrategy();
        s.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "page" }, (ctx, body) => body);`)]);
        s.claimRequest("https://cdn.example.com/lib.js");
        expect(s.isClaimed("https://cdn.example.com/lib.js")).toBe(true);
        expect(s.isClaimed("https://cdn.example.com/other.js")).toBe(false);
    });
});
