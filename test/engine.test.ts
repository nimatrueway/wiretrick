import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { ExtensionStrategy } from "../src/background/engine/strategies/extensionStrategy";
import { PageStrategy } from "../src/background/engine/strategies/pageStrategy";
import type { Script } from "../src/background/engine/scriptStore";
import { compileScript } from "../src/shared/compile";
import { allLogs } from "../src/background/engine/logs";
import { setSkipRoutes } from "../src/background/engine/skipped";

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

function named(id: string, code: string): Script {
    const s = makeScript(id, code);
    s.meta = { ...s.meta, name: id };
    return s;
}

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

describe("ExtensionStrategy", () => {
    beforeEach(() => setDefaultStrategy("extension"));
    afterEach(() => setDefaultStrategy(null));
    it("onRequest redirect", () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*://api.example.com/*", (ctx) => ({ redirect: "https://mocked.example.com/data" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), "https://app.example.com/") as any;
        expect(d).toEqual({ kind: "redirect", url: "https://mocked.example.com/data" });
    });

    it("a redirect or replacement of a WebSocket isn't applied, with a warning (Chrome ignores it)", () => {
        const s = new ExtensionStrategy();
        s.reload([
            named("Socky", `wt.onRequest("wss://ws.example.com/*", () => ({ redirect: "wss://other.example.com/ws" }));
wt.replaceResponse("wss://ws.example.com/*", () => "nope");`),
            named("Hdr", `wt.onRequest("wss://ws.example.com/*", () => ({ headers: { set: { "x-a": "1" } } }));`),
        ]);
        const ws = details({ url: "wss://ws.example.com/ws", type: "websocket", requestId: "ws1" });
        expect((s.handleBeforeRequest(ws, null) as any).kind).toBe("allow");
        const warns = allLogs().filter((e) => e.level === "warn" && e.message.includes("wss://ws.example.com/ws") && e.message.includes("NOT applied")).map((e) => e.message);
        expect(warns.some((m) => m.startsWith("[Socky] onRequest → redirect wss://ws.example.com/ws → wss://other.example.com/ws NOT applied") && m.includes("Chrome ignores redirects on WebSocket handshakes"))).toBe(true);
        expect(warns.some((m) => m.startsWith("[Socky] replaceResponse wss://ws.example.com/ws NOT applied"))).toBe(true);
        // request headers still apply
        expect(JSON.stringify(s.handleBeforeSendHeaders(ws, null))).toContain('"x-a"');
    });

    it("non-matching url → allow", () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*://other.com/*", () => ({ redirect: "https://x.com" }));`),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });

    it("disabled script does nothing", () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => ({ block: true }));`, false),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });

    it("static replaceResponse → data url redirect", () => {
        const s = new ExtensionStrategy();
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
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `wt.onResponseHeaders("*://api.example.com/*", () => ({ headers: { set: { "access-control-allow-origin": "*" }, remove: ["x-frame-options"] } }));`),
        ]);
        const changes = s.handleHeadersReceived(details(), null) as any;
        expect(changes).not.toBeNull();
        expect(changes!.set).toEqual({ "access-control-allow-origin": "*" });
        expect(changes!.remove).toEqual(["x-frame-options"]);
    });

    it("request header modification via onRequest (run once, cached for header phase)", () => {
        const s = new ExtensionStrategy();
        const code = `wt.onRequest("*://api.example.com/*", () => ({ headers: { set: { authorization: "Bearer x" } } }));`;
        s.reload([makeScript("a", code)]);
        // header phase alone does nothing (cache empty — onRequest hasn't run)
        expect(s.handleBeforeSendHeaders(details(), null)).toBeNull();
        // request phase runs onRequest and caches the header mods
        s.handleBeforeRequest(details(), null);
        const changes = s.handleBeforeSendHeaders(details(), null) as any;
        expect(changes!.set).toEqual({ authorization: "Bearer x" });
    });

    it("same order as every strategy: every onRequest before any replaceResponse", () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `wt.replaceResponse("*://api.example.com/*", () => "mocked");`),
            makeScript("b", `wt.onRequest("*://api.example.com/*", () => ({ block: true }));`),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("cancel");
    });

    it("the later handler wins per header, and the override is a warning", () => {
        const s = new ExtensionStrategy();
        s.reload([
            named("a", `wt.onRequest("*://api.example.com/*", () => ({ headers: { set: { "X-Mode": "a" }, remove: ["cookie"] } }));`),
            named("b", `wt.onRequest("*://api.example.com/*", () => ({ headers: { remove: ["x-mode"], set: { Cookie: "b=1" } } }));`),
        ]);
        s.handleBeforeRequest(details({ requestId: "hdr" }), null);
        const changes = s.handleBeforeSendHeaders(details({ requestId: "hdr" }), null) as any;
        expect(changes).toEqual({ set: { Cookie: "b=1" }, remove: ["x-mode"] });
        const warns = allLogs().filter((e) => e.level === "warn" && e.message.includes("overrides request header"));
        expect(warns.map((e) => e.message.split(" from ")[0])).toEqual(expect.arrayContaining([`[b] onRequest #1 overrides request header "x-mode"`, `[b] onRequest #1 overrides request header "cookie"`]));
    });

    it("a final result warns for each handler it kept from running", () => {
        const scripts = [
            named("a", `wt.onRequest("*://api.example.com/*", () => ({ block: true }));`),
            named("b", `wt.onRequest("*://api.example.com/*", () => ({ headers: { set: { x: "1" } } })); wt.onResponseHeaders("*://api.example.com/*", () => null);`),
        ];
        setSkipRoutes(scripts);
        const s = new ExtensionStrategy();
        s.reload(scripts);
        expect((s.handleBeforeRequest(details({ url: "https://api.example.com/skip" }), null) as any).kind).toBe("cancel");
        const lines = allLogs().filter((e) => e.message.includes("→ skipped: ") && e.message.endsWith("https://api.example.com/skip")).map((e) => e.message);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^\[b\] onRequest #1 → skipped: \[a\] onRequest #1 → block took priority \(it comes earlier in the list\)/);
        expect(lines[1]).toMatch(/^\[b\] onResponseHeaders #1 → skipped: \[a\] onRequest #1 → block took priority \(the request ended there\)/);
        setSkipRoutes([]);
    });

    it("script throwing does not break the pipeline", () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => { throw new Error("boom"); });`),
        ]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
    });
});

describe("PageStrategy (hook tier)", () => {
    it("owns only hook routes and never asks for the debugger itself", () => {
        const s = new PageStrategy();
        s.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "page" }, (ctx, body) => body);`)]);
        expect(s.hasOwners()).toBe(true);
        expect((s.handleBeforeRequest(details({ type: "script" }), null) as any).kind).toBe("allow");
        s.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "debugger" }, (ctx, body) => body);`)]);
        expect(s.hasOwners()).toBe(false);
    });

    it("claimed urls (tier A) are tracked", () => {
        const s = new PageStrategy();
        s.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "page" }, (ctx, body) => body);`)]);
        s.claimRequest("https://cdn.example.com/lib.js");
        expect(s.isClaimed("https://cdn.example.com/lib.js")).toBe(true);
        expect(s.isClaimed("https://cdn.example.com/other.js")).toBe(false);
    });
});
