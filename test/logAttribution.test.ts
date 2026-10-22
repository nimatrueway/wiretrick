/**
 * Log attribution: every script-identifying log line must use the STORED
 * script name (scriptStore meta.name), never the compiled metadata
 * (scripts have no name of their own — compiled meta is "Untitled script").
 *
 * Also covers the respond-result emit paths: Chromium's webRequest tier
 * can't serve a non-200 respond (data-URLs carry no status) and says so;
 * the CDP tier fulfills a respond itself and logs the success, or logs a
 * script-attributed error when fulfillment fails.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { WebRequestStrategy } from "../src/background/engine/strategies/webRequestStrategy";
import { CdpStrategy } from "../src/background/engine/strategies/cdpStrategy";
import { addUiPort, type LogEntry } from "../src/background/engine/logs";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

// these suites exercise the webRequest tier: make it the settings default
beforeEach(() => setDefaultStrategy("webRequest"));
afterEach(() => setDefaultStrategy(null));

// ---- log capture via a fake UI port ----
const entries: LogEntry[] = [];
addUiPort({
    postMessage: (msg: any) => {
        if (msg?.type === "log") entries.push(msg.entry);
    },
    onDisconnect: { addListener: () => {} },
} as any);

// ---- debugger command capture ----
let debuggerCalls: { command: string; params: any }[] = [];
let failCommands: Set<string> = new Set();

function mockChrome() {
    debuggerCalls = [];
    failCommands = new Set();
    (globalThis as any).chrome = {
        runtime: {
            getURL: (p: string) => `chrome-extension://t/${p}`,
            sendMessage: vi.fn(async () => ({})),
            lastError: undefined,
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        webRequest: {
            onBeforeRequest: { addListener: vi.fn() },
            onBeforeSendHeaders: { addListener: vi.fn() },
            onHeadersReceived: { addListener: vi.fn() },
        },
        tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
        debugger: {
            attach: (_d: any, _v: any, cb: () => void) => cb(),
            detach: (_d: any, cb: () => void) => cb(),
            sendCommand: (_d: any, command: string, params: any, cb: (resp?: any) => void) => {
                debuggerCalls.push({ command, params });
                if (failCommands.has(command)) {
                    (chrome.runtime as any).lastError = { message: `${command} exploded` };
                    cb(undefined);
                    (chrome.runtime as any).lastError = undefined;
                } else {
                    cb({});
                }
            },
            getTargets: (cb: (t: any[]) => void) => cb([]),
        },
    };
    delete (globalThis as any).browser;
}

beforeEach(() => {
    entries.length = 0;
    mockChrome();
});

/** Stored script: like scriptStore.saveScript, the stored meta carries the file/manager name. */
function storedScript(id: string, name: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: { ...compileScript(code).meta, name } };
}

const details = (over: Record<string, any> = {}) => ({
    url: "https://api.example.com/v1/data",
    method: "GET",
    tabId: 1,
    type: "xmlhttprequest",
    requestId: "r1",
    requestHeaders: [],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
    ...over,
});

const RESPOND_500 = `wt.onRequest("*://api.example.com/*", (ctx) => {
    if (ctx.url.includes("/v1/")) return { respond: { status: 500, body: { error: "boom" }, mime: "application/json" } };
});`;

describe("webRequest tier: log lines use the stored script name", () => {
    it("sync respond with non-200 status → not served + named warning", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "API mocker", RESPOND_500)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("allow");
        const line = entries.find((e) => e.message.includes("respond 500"));
        expect(line, "a respond-500 log line must exist").toBeTruthy();
        expect(line!.message).toContain("[API mocker]");
        expect(entries.some((e) => e.message.includes("[Untitled script]"))).toBe(false);
    });

    it("sync respond 200 → served + named serve log", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "API mocker", `wt.onRequest("*", () => ({ respond: { body: "ok", mime: "text/plain" } }));`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        const line = entries.find((e) => e.message.includes("respond 200"));
        expect(line, "a respond log line must exist").toBeTruthy();
        expect(line!.message).toContain("[API mocker]");
    });

    it("redirect/cancel log uses the stored name", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "API mocker", `wt.onRequest("*", () => ({ redirect: "https://mocked.example.com/x" }));`)]);
        s.handleBeforeRequest(details(), null);
        const line = entries.find((e) => e.message.includes("onRequest →"));
        expect(line, "a redirect log line must exist").toBeTruthy();
        expect(line!.message).toContain("[API mocker]");
    });

    it("replaceResponse log uses the stored name", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "API mocker", `wt.replaceResponse("*", () => '{"mocked":true}');`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        const line = entries.find((e) => e.message.includes("replaceResponse →"));
        expect(line, "a replaceResponse log line must exist").toBeTruthy();
        expect(line!.message).toContain("[API mocker]");
    });


    it("no-match (handler returns undefined) logs only a DEBUG 'tapped (no change)' line", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "API mocker", `wt.onRequest("*", () => undefined);`)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("allow");
        const lines = entries.filter((e) => e.message.includes("onRequest →"));
        expect(lines.map((e) => [e.level, e.kind, e.scriptId])).toEqual([["debug", "tapped", "a"]]);
        expect(lines[0].message).toMatch(/^\[API mocker\] onRequest → tapped \(no change\) https:\/\//);
    });

    it("replaceResponse → null and no-op onResponseHeaders are tapped; header changes stay INFO", () => {
        const s = new WebRequestStrategy();
        s.reload([
            storedScript("a", "Looker", `wt.replaceResponse("*", () => null);
wt.onResponseHeaders("*", () => undefined);`),
            storedScript("b", "Hdr", `wt.onResponseHeaders("*", () => ({ headers: { set: { "x-a": "1" } } }));`),
        ]);
        s.handleBeforeRequest(details(), null);
        s.handleHeadersReceived(details(), null);
        expect(entries.filter((e) => e.scriptId).map((e) => [e.level, e.message.replace(/ https:.*/, "")])).toEqual([
            ["debug", "[Looker] replaceResponse → tapped (no change)"],
            ["debug", "[Looker] onResponseHeaders → tapped (no change)"],
            ["info", "[Hdr] onResponseHeaders → set x-a"],
        ]);
    });
});

describe("CDP tier: request-stage respond fulfillment", () => {
    const paused = (over: Record<string, any> = {}) => ({
        requestId: "r1",
        request: { url: "https://api.example.com/v1/data", method: "GET" },
        resourceType: "xmlhttprequest",
        ...over,
    });
    const CDP_500 = RESPOND_500.replace(`"*://api.example.com/*"`, `{ url: "*://api.example.com/*", strategy: "debugger" }`);

    it("SYNC onRequest respond-500 is fulfilled + named success log", async () => {
        const c = new CdpStrategy();
        c.reload([storedScript("a", "API mocker", CDP_500)]);
        await c.handlePaused("tab:1", paused());
        const fulfill = debuggerCalls.find((x) => x.command === "Fetch.fulfillRequest");
        expect(fulfill, "the respond must be fulfilled at the Request stage").toBeTruthy();
        expect(fulfill!.params.responseCode).toBe(500);
        const line = entries.find((e) => e.message.includes("respond 500"));
        expect(line, "a respond-500 success log must exist").toBeTruthy();
        expect(line!.message).toContain("[API mocker]");
        expect(line!.level).toBe("info");
        expect(line!.scriptId).toBe("a");
        expect(entries.filter((e) => e.scriptId === "a")).toHaveLength(1);
    });

    it("a cdp route is never run by the webRequest tier", () => {
        const w = new WebRequestStrategy();
        w.reload([storedScript("a", "API mocker", CDP_500)]);
        expect((w.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
        expect(entries.filter((e) => e.scriptId === "a")).toEqual([]);
    });

    it("sync respond 200 is fulfilled in place by the debugger tier (no redirect)", async () => {
        const code = `wt.onRequest({ url: "*", strategy: "debugger" }, () => ({ respond: { body: "<h1>mock</h1>", mime: "text/html" } }));`;
        const c = new CdpStrategy();
        c.reload([storedScript("a", "Page mock", code)]);
        await c.handlePaused("tab:1", paused({ resourceType: "Document" }));
        const fulfill = debuggerCalls.find((x) => x.command === "Fetch.fulfillRequest");
        expect(fulfill!.params.responseCode).toBe(200);
        expect(atob(fulfill!.params.body)).toBe("<h1>mock</h1>");
        expect(entries.filter((e) => e.scriptId === "a").map((e) => e.message.replace(/ https:.*/, ""))).toEqual([
            "[Page mock] onRequest → respond 200 text/html (13b)",
        ]);
    });

    it("sync replaceResponse runs once, in the debugger tier", async () => {
        const code = `wt.replaceResponse({ url: "*", strategy: "debugger" }, () => "<h1>replaced</h1>");`;
        const w = new WebRequestStrategy();
        const c = new CdpStrategy();
        w.reload([storedScript("a", "Page mock", code)]);
        c.reload([storedScript("a", "Page mock", code)]);
        expect((w.handleBeforeRequest(details({ type: "main_frame" }), null) as any).kind).toBe("allow");
        expect(entries.filter((e) => e.scriptId === "a")).toEqual([]);
        await c.handlePaused("tab:1", paused({ resourceType: "Document", responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }] }));
        const fulfill = debuggerCalls.find((x) => x.command === "Fetch.fulfillRequest");
        expect(fulfill, "the debugger tier fulfills the replacement in place").toBeTruthy();
        expect(atob(fulfill!.params.body)).toBe("<h1>replaced</h1>");
        expect(entries.filter((e) => e.scriptId === "a" && e.message.includes("replaceResponse"))).toHaveLength(1);
    });

    it("routes on another strategy are not run by the debugger tier", async () => {
        const c = new CdpStrategy();
        c.reload([
            storedScript("a", "API mocker", `wt.onRequest("*", () => ({ redirect: "https://mocked.example.com/x" }));`),
            storedScript("b", "Responder", `wt.onRequest("*", () => ({ respond: { body: "ok" } }));`),
        ]);
        await c.handlePaused("tab:1", paused());
        expect(debuggerCalls.filter((x) => x.command === "Fetch.fulfillRequest")).toEqual([]);
        expect(debuggerCalls.filter((x) => x.command === "Fetch.failRequest")).toEqual([]);
        const cont = debuggerCalls.find((x) => x.command === "Fetch.continueRequest");
        expect(cont).toBeTruthy();
        expect(cont!.params.url).toBeUndefined();
    });

    it("async onRequest respond is fulfilled", async () => {
        const c = new CdpStrategy();
        c.reload([storedScript("a", "API mocker", `wt.onRequest({ url: "*", strategy: "debugger" }, async () => ({ respond: { status: 503, body: "later" } }));`)]);
        await c.handlePaused("tab:1", paused());
        const fulfill = debuggerCalls.find((x) => x.command === "Fetch.fulfillRequest");
        expect(fulfill).toBeTruthy();
        expect(fulfill!.params.responseCode).toBe(503);
        expect(entries.find((e) => e.message.includes("respond 503"))!.message).toContain("[API mocker]");
    });

    it("fulfill failure → script-attributed error log + request continued", async () => {
        failCommands.add("Fetch.fulfillRequest");
        const c = new CdpStrategy();
        c.reload([storedScript("a", "API mocker", CDP_500)]);
        await c.handlePaused("tab:1", paused());
        const line = entries.find((e) => e.level === "error" && e.message.includes("respond 500"));
        expect(line, "a script-attributed failure log must exist").toBeTruthy();
        expect(line!.message).toContain("[API mocker]");
        expect(debuggerCalls.some((x) => x.command === "Fetch.continueRequest")).toBe(true);
    });
});

describe("per-script runtime error tracking", () => {
    it("records script errors (not console.error), clears on demand", async () => {
        const { log, getScriptErrors, clearScriptErrors } = await import("../src/background/engine/logs");
        await clearScriptErrors();
        log(1, "[S] onRequest threw: boom", "error", "sx");
        log(1, "[S] onRequest threw: boom2", "error", "sx");
        log(1, "[S] console.error: user said so", "error", "sy");
        log(1, "[S] warned", "warn", "sz");
        log(1, "[engine] not a script", "error", null);
        await new Promise((r) => setTimeout(r, 10));
        const errs = await getScriptErrors();
        expect([...errs.keys()]).toEqual(["sx"]);
        expect(errs.get("sx")).toMatchObject({ message: "[S] onRequest threw: boom2", count: 2 });
        await clearScriptErrors("sx");
        expect((await getScriptErrors()).size).toBe(0);
    });
});

describe("per-script TypeScript error tracking", () => {
    it("logs new type errors once at ERROR, not as runtime errors; clears", async () => {
        const logs = await import("../src/background/engine/logs");
        const entries: LogEntry[] = [];
        logs.addUiPort({ postMessage: (m: any) => m.type === "log" && entries.push(m.entry), onDisconnect: { addListener() {} } } as any);
        await logs.clearScriptErrors();
        await logs.setScriptTypeErrors("tx", "Typed", ["line 1: bad"]);
        await logs.setScriptTypeErrors("tx", "Typed", ["line 1: bad"]);
        await logs.setScriptTypeErrors("tx", "Typed", ["line 1: bad", "line 2: worse"]);
        const lines = entries.filter((e) => e.message.includes("type error"));
        expect(lines.map((e) => [e.level, e.message, e.scriptId])).toEqual([
            ["error", "[Typed] type error: line 1: bad", "tx"],
            ["error", "[Typed] type error: line 2: worse", "tx"],
        ]);
        expect((await logs.getScriptErrors()).has("tx")).toBe(false);
        expect((await logs.getScriptTypeErrors()).get("tx")).toEqual(["line 1: bad", "line 2: worse"]);
        await logs.setScriptTypeErrors("tx", "Typed", []);
        expect((await logs.getScriptTypeErrors()).has("tx")).toBe(false);
    });
});

describe("Chromium webRequest tier: how it serves replacements (redirect)", () => {
    const REPLACE = `wt.replaceResponse("*", () => "<h1>x</h1>");`;
    it("a page load is served via serve.html", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "Wr page", REPLACE)]);
        const d = s.handleBeforeRequest(details({ type: "main_frame" }), null) as any;
        expect(d.kind).toBe("redirect");
        expect(d.url).toContain("serve.html");
    });
    it("a fetch/XHR gets a data: URL", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "Wr api", REPLACE)]);
        const d = s.handleBeforeRequest(details(), null) as any;
        expect(d.kind).toBe("redirect");
        expect(d.url).toMatch(/^data:/);
    });
    it("a route on another strategy is left alone", () => {
        const s = new WebRequestStrategy();
        s.reload([storedScript("a", "Cdp api", `wt.replaceResponse({ url: "*", strategy: "debugger" }, () => "<h1>x</h1>");`)]);
        expect((s.handleBeforeRequest(details(), null) as any).kind).toBe("allow");
        expect(entries.filter((e) => e.scriptId === "a")).toEqual([]);
    });
});
