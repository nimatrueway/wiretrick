import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { WebRequestStrategy } from "../src/background/engine/strategies/webRequestStrategy";
import { CdpStrategy } from "../src/background/engine/strategies/cdpStrategy";
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
    // not Firefox in unit tests
    delete (globalThis as any).browser;
    // clear the module-static per-request caches between tests
    new WebRequestStrategy().pruneRequest("r1");
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

const details = () => ({
    url: "https://api.example.com/v1/data",
    method: "GET",
    tabId: 1,
    type: "xmlhttprequest",
    requestId: "r1",
    requestHeaders: [],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
});

// ---------- stacking: multiple scripts, same hook ----------

describe("handler stacking", () => {
    it("onRequest: first matching script's redirect wins (later scripts skipped)", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("first", `wt.onRequest("*", () => ({ redirect: "https://first.com" }));`),
            makeScript("second", `wt.onRequest("*", () => ({ redirect: "https://second.com" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d).toEqual({ kind: "redirect", url: "https://first.com" });
    });

    it("onRequest: non-terminal results don't stop later scripts", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("logger", `wt.onRequest("*", () => { wt.log("just logging"); });`),
            makeScript("redirector", `wt.onRequest("*", () => ({ redirect: "https://second.com" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d).toEqual({ kind: "redirect", url: "https://second.com" });
    });

    it("onRequest: header changes from MULTIPLE scripts merge (later set wins, removes accumulate)", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => ({ headers: { set: { "x-a": "1", "x-b": "old" }, remove: ["x-r1"] } }));`),
            makeScript("b", `wt.onRequest("*", () => ({ headers: { set: { "x-b": "new", "x-c": "3" }, remove: ["x-r2"] } }));`),
        ]);
        s.handleBeforeRequest(details(), null); // runs both, caches merged mods
        const c = s.handleBeforeSendHeaders(details(), null) as any;
        expect(c.set).toEqual({ "x-a": "1", "x-b": "new", "x-c": "3" });
        expect(c.remove).toEqual(["x-r1", "x-r2"]);
    });

    it("onRequest: headers from an earlier non-terminal script APPLY even when a later script redirects", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onRequest("*", () => ({ headers: { set: { "x-keep": "yes" } } }));`),
            makeScript("b", `wt.onRequest("*", () => ({ redirect: "https://win.com" }));`),
        ]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        const c = s.handleBeforeSendHeaders(details(), null) as any;
        expect(c.set).toEqual({ "x-keep": "yes" });
    });

    it("onResponseHeaders: multiple scripts MERGE — set overwritten by later, removes accumulate", () => {
        const s = new WebRequestStrategy();
        s.reload([
            makeScript("a", `wt.onResponseHeaders("*", () => ({ headers: { set: { "x-a": "1", "x-b": "old" }, remove: ["x-r1"] } }));`),
            makeScript("b", `wt.onResponseHeaders("*", () => ({ headers: { set: { "x-b": "new", "x-c": "3" }, remove: ["x-r2"] } }));`),
        ]);
        const c = s.handleHeadersReceived(details(), null) as any;
        expect(c.set).toEqual({ "x-a": "1", "x-b": "new", "x-c": "3" });
        expect(c.remove).toEqual(["x-r1", "x-r2"]);
    });

    it("modifyResponse: transforms COMPOSE in script order (chained)", async () => {
        const { compileScript } = await import("../src/shared/compile");
        const chain = [
            makeScript("a", `wt.modifyResponse("*", (ctx, body) => body + "-A");`),
            makeScript("b", `wt.modifyResponse("*", (ctx, body) => body + "-B");`),
        ];
        let out: string | Uint8Array = "base";
        for (const sc of chain) {
            const c = compileScript(sc.code);
            for (const { fn } of c.handlers.modifyResponse) {
                out = await fn({ url: "x" }, out);
            }
        }
        expect(out).toBe("base-A-B");
    });

    it("async modifyResponse: promises compose in script order", async () => {
        const { compileScript } = await import("../src/shared/compile");
        const chain = [
            makeScript("a", `wt.modifyResponse("*", async (ctx, body) => body + "-A");`),
            makeScript("b", `wt.modifyResponse("*", async (ctx, body) => body + "-B");`),
        ];
        let out: string | Uint8Array = "base";
        for (const sc of chain) {
            const c = compileScript(sc.code);
            for (const { fn } of c.handlers.modifyResponse) {
                out = await fn({ url: "x" }, out);
            }
        }
        expect(out).toBe("base-A-B");
    });
});

// ---------- async handlers ----------

describe("async handlers (Chrome webRequest tier)", () => {
    it("async onRequest redirect → skipped with allow (needs sync or cdp)", async () => {
        const s = new WebRequestStrategy();
        s.reload([makeScript("a", `wt.onRequest("*", async (ctx) => ({ redirect: "https://async.com" }));`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        // not a promise (Chrome path) and not a redirect — allow
        expect(d.then).toBeUndefined();
        expect(d.kind).toBe("allow");
    });

    it("async replaceResponse → not served (no fallback; the error says to pick cdp/process)", () => {
        const s = new WebRequestStrategy();
        s.reload([makeScript("a", `wt.replaceResponse("*", async () => JSON.stringify({ async: true }));`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("allow");
    });

    it("sync replaceResponse still redirects synchronously", () => {
        const s = new WebRequestStrategy();
        s.reload([makeScript("a", `wt.replaceResponse("*", () => "static body");`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        expect(d.url).toContain("data:");
    });
});

describe("async handlers (CDP tier loading)", () => {
    it("routes on other strategies are not loaded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.replaceResponse("*", async () => "x");`)]);
        expect(c.hasOwners()).toBe(false);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(false);
    });

    it("async replaceResponse script is loaded into CdpStrategy", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.replaceResponse({ url: "*", strategy: "cdp" }, async () => "x");`)]);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(true);
    });

    it("SYNC replaceResponse script IS loaded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.replaceResponse({ url: "*", strategy: "cdp" }, () => "x");`)]);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(true);
    });

    it("async onRequest script is loaded (request-stage redirect/cancel)", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.onRequest({ url: "*", strategy: "cdp" }, async () => ({ cancel: true }));`)]);
        expect(c.needs({ url: "https://x.com/", method: "GET", type: "main_frame" })).toBe(true);
    });
});
