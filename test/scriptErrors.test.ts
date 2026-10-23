/**
 * Script error attribution: error log lines carry the STORED script name
 * and the user-source line:col (the eval wrapper's <anonymous> frames are
 * rewritten; extension/eval frames are dropped).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { formatScriptError, rewriteFrame, EVAL_WRAPPER_LINES } from "../src/shared/scriptError";
import { ExtensionStrategy } from "../src/background/engine/strategies/extensionStrategy";
import { DebuggerStrategy } from "../src/background/engine/strategies/debuggerStrategy";
import { addUiPort, type LogEntry } from "../src/background/engine/logs";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

// ---- log capture via a fake UI port ----
const entries: LogEntry[] = [];
addUiPort({
    postMessage: (msg: any) => {
        if (msg?.type === "log") entries.push(msg.entry);
    },
    onDisconnect: { addListener: () => {} },
} as any);

function mockChrome() {
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
            sendCommand: (_d: any, _c: string, _p: any, cb: (resp?: any) => void) => cb({}),
            getTargets: (cb: (t: any[]) => void) => cb([]),
            onEvent: { addListener: vi.fn() },
            onDetach: { addListener: vi.fn() },
        },
    };
    delete (globalThis as any).browser;
}

beforeEach(() => {
    entries.length = 0;
    mockChrome();
});

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
    responseHeaders: [],
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
    ...over,
});

// line 4 throws (x is undefined):
// line 4 throws inside the handler
const throws = (strategy: string, async = "") => `// a handler that throws
wt.onRequest({ url: "*", strategy: "${strategy}" }, ${async}(ctx) => {
    const x = undefined;
    return x.split(".");
});`;
const THROWS = throws("extension");

// line 4 throws at module top level (compile-time):
const TOPLEVEL = `
wt.onRequest({ url: "*", strategy: "extension" }, () => {});
const x = undefined;
x.split(".");
`;

describe("formatScriptError / rewriteFrame", () => {
    const STACK = `TypeError: Cannot read properties of undefined (reading 'split')
    at boom (eval at run (file:///x/scratch.mjs:15:20), <anonymous>:8:14)
    at eval (eval at run (file:///x/scratch.mjs:15:20), <anonymous>:10:1)
    at run (file:///x/scratch.mjs:16:9)
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)`;

    it("maps <anonymous> frames to the user source (constant wrapper offset)", () => {
        const out = formatScriptError("My Script", STACK);
        expect(out.split("\n")).toEqual([
            "[My Script] TypeError: Cannot read properties of undefined (reading 'split')",
            "    at boom (My Script:5:14)", // named user function, line 8 − 3
            "    at My Script:7:1", // top-level body frame, line 10 − 3
        ]);
    });

    it("drops extension/eval frames and keeps the message", () => {
        expect(rewriteFrame("S", "    at run (file:///x.mjs:16:9)")).toBeNull();
        expect(rewriteFrame("S", "    at ModuleJob.run (node:internal/x)")).toBeNull();
    });

    it("context is inserted after the name; non-Error values work", () => {
        expect(formatScriptError("S", "plain failure", "onRequest")).toBe("[S] onRequest: plain failure");
        expect(formatScriptError("S", new TypeError("boom"), undefined)).toContain("[S] TypeError: boom");
    });

    it("EVAL_WRAPPER_LINES matches the real new Function wrapper", () => {
        // empirical: a throw at user line 1 reports <anonymous>:(1+OFFSET)
        let line = 0;
        try {
            new Function("wt", `"use strict";\nthrow new Error("x");`)({});
        } catch (e: any) {
            line = Number(e.stack.match(/<anonymous>:(\d+):\d+/)?.[1]);
        }
        expect(line).toBe(1 + EVAL_WRAPPER_LINES);
    });
});

describe("extension strategy: error logs carry name + user line:col", () => {
    it("handler throws → [name] + mapped line", () => {
        const s = new ExtensionStrategy();
        s.reload([storedScript("a", "Thrower", THROWS)]);
        s.handleBeforeRequest(details(), null);
        const line = entries.find((e) => e.level === "error");
        expect(line, "an error log line must exist").toBeTruthy();
        expect(line!.message).toContain("[Thrower]");
        expect(line!.message).toContain("TypeError");
        expect(line!.message).toMatch(/Thrower:4:\d+/); // user line 4
        expect(line!.message).not.toContain("background.js");
        expect(line!.message).not.toContain("<anonymous>");
    });

    it("compile-time (top-level) throw → [name] + mapped line", () => {
        const s = new ExtensionStrategy();
        // stored meta is from the last good save (saveScript keeps it on a failed compile)
        const good = storedScript("a", "Thrower", TOPLEVEL.replace(`x.split(".");`, ""));
        s.reload([{ ...good, code: TOPLEVEL }]);
        const line = entries.find((e) => e.level === "error");
        expect(line, "a compile error log line must exist").toBeTruthy();
        expect(line!.message).toContain("[Thrower]");
        expect(line!.message).toMatch(/Thrower:4:\d+/);
    });
});

describe("CDP tier: error logs carry name + user line:col", () => {
    it("onRequest throws at the Request stage → [name] + mapped line", async () => {
        const c = new DebuggerStrategy();
        // sync onRequest runs in the extension strategy only; the Request stage runs async ones
        c.reload([storedScript("a", "Thrower", throws("debugger", "async "))]);
        await c.handlePaused("tab:1", {
            requestId: "r1",
            request: { url: "https://api.example.com/v1/data", method: "GET" },
            resourceType: "xmlhttprequest",
        });
        const line = entries.find((e) => e.level === "error");
        expect(line, "an error log line must exist").toBeTruthy();
        expect(line!.message).toContain("[Thrower]");
        expect(line!.message).toMatch(/Thrower:4:\d+/);
    });
});
