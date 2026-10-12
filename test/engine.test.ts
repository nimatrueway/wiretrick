import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebRequestStrategy } from "../src/background/engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "../src/background/engine/strategies/chromeBodyStrategy";
import type { Script } from "../src/background/engine/scriptStore";
import { parseMeta } from "../src/shared/metaParser";

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
        meta: parseMeta(code),
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
    it("onRequest redirect", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `// ==ResScript==
// @name redirector
// @match *://api.example.com/*
// ==/ResScript==
res.onRequest((ctx) => ({ redirect: "https://mocked.example.com/data" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), "https://app.example.com/");
        expect(d).toEqual({ kind: "redirect", url: "https://mocked.example.com/data" });
    });

    it("non-matching url → allow", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `// @match *://other.com/*\nres.onRequest(() => ({ redirect: "https://x.com" }));`),
        ]);
        expect(s.handleBeforeRequest(details(), null).kind).toBe("allow");
    });

    it("disabled script does nothing", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `// @match *\nres.onRequest(() => ({ cancel: true }));`, false),
        ]);
        expect(s.handleBeforeRequest(details(), null).kind).toBe("allow");
    });

    it("static replaceResponse → data url redirect", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `// ==ResScript==
// @name mock
// @match *://api.example.com/v1/data
// ==/ResScript==
res.replaceResponse(() => JSON.stringify({ mocked: true }));`),
        ]);
        const d = s.handleBeforeRequest(details(), null);
        expect(d.kind).toBe("redirect");
        if (d.kind === "redirect") {
            expect(d.url).toContain("data:application/json");
            expect(decodeURIComponent(d.url)).toContain('"mocked"');
        }
    });

    it("onResponseHeaders modifies headers", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `// ==ResScript==
// @name cors
// @match *://api.example.com/*
// @phase response
// ==/ResScript==
res.onResponseHeaders(() => ({ headers: { set: { "access-control-allow-origin": "*" }, remove: ["x-frame-options"] } }));`),
        ]);
        const changes = s.handleHeadersReceived(details(), null);
        expect(changes).not.toBeNull();
        expect(changes!.set).toEqual({ "access-control-allow-origin": "*" });
        expect(changes!.remove).toEqual(["x-frame-options"]);
    });

    it("request header modification via onRequest (run once, cached for header phase)", () => {
        const s = new WebRequestStrategy();
        const code = `// @match *://api.example.com/*\nres.onRequest(() => ({ headers: { set: { authorization: "Bearer x" } } }));`;
        s.reload([makeScript("a", code)]);
        // header phase alone does nothing (cache empty — onRequest hasn't run)
        expect(s.handleBeforeSendHeaders(details(), null)).toBeNull();
        // request phase runs onRequest and caches the header mods
        s.handleBeforeRequest(details(), null);
        const changes = s.handleBeforeSendHeaders(details(), null);
        expect(changes!.set).toEqual({ authorization: "Bearer x" });
    });

    it("script throwing does not break the pipeline", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `// @match *\nres.onRequest(() => { throw new Error("boom"); });`),
        ]);
        expect(s.handleBeforeRequest(details(), null).kind).toBe("allow");
    });
});

describe("ChromeBodyStrategy", () => {
    it("non-JS resources → needsCdp (CDP intercepts the response)", () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("a", `// ==ResScript==
// @name rewriter
// @match *://cdn.example.com/lib.js
// ==/ResScript==
res.modifyResponse((ctx, body) => body.replace("foo", "bar"));`),
        ]);
        const d = s.handleBeforeRequest(details({ type: "script", url: "https://cdn.example.com/lib.js" }), null);
        expect(d.kind).toBe("needsCdp");
    });

    it("claimed urls (tier A) are left alone", () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("a", `// @match *\nres.modifyResponse((ctx, body) => body);`),
        ]);
        s.claimRequest("https://cdn.example.com/lib.js");
        expect(s.handleBeforeRequest(details({ type: "script", url: "https://cdn.example.com/lib.js" }), null).kind).toBe("allow");
    });

    it("main_frame goes through the CDP tier", () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("a", `// @match *\nres.modifyResponse((ctx, body) => body);`),
        ]);
        expect(s.handleBeforeRequest(details({ type: "main_frame" }), null).kind).toBe("needsCdp");
    });

    it("cdp-strategy scripts are left to tier C", () => {
        const s = new ChromeBodyStrategy();
        s.reload([
            makeScript("a", `// ==ResScript==
// @name cdpone
// @match *
// @strategy cdp
// ==/ResScript==
res.modifyResponse((ctx, body) => body);`),
        ]);
        expect(s.handleBeforeRequest(details({ type: "script" }), null).kind).toBe("allow");
    });
});
