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
import { scriptFunction } from "../src/shared/scriptFn";
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
    // a library's function, called from the script's top level, called by
    // the page hook (an inline <script>: Chrome names its frames <anonymous>)
    const STACK = `TypeError: Cannot read properties of undefined (reading 'split')
    at boom (wiretrick-script:///lib/My%20Lib.ts:8:14)
    at eval (wiretrick-script:///My%20Script:10:1)
    at requireFrom (<anonymous>:2504:6)
    at <anonymous>:2442:5
    at Object.eval (https://unpkg.com/cmdk@1.1.1/dist/index.js:1:200)
    at run (file:///x/scratch.mjs:16:9)`;

    it("maps each script's frames to its own source (constant wrapper offset); drops the rest", () => {
        const out = formatScriptError("My Script", STACK);
        expect(out.split("\n")).toEqual([
            "[My Script] TypeError: Cannot read properties of undefined (reading 'split')",
            "    at boom (lib/My Lib.ts:5:14)", // the library's named function, line 8 − 3
            "    at My Script:7:1", // top-level body frame, line 10 − 3
        ]);
    });

    it("drops extension/hook/eval frames and keeps the message", () => {
        expect(rewriteFrame("    at run (file:///x.mjs:16:9)")).toBeNull();
        expect(rewriteFrame("    at ModuleJob.run (node:internal/x)")).toBeNull();
        expect(rewriteFrame("    at <anonymous>:240:11")).toBeNull();
        expect(rewriteFrame("    at f (wiretrick-script:///S:2:1)")).toBeNull(); // inside the wrapper
        expect(rewriteFrame("  continued message")).toBe("  continued message");
    });

    it("context is inserted after the name; non-Error values work", () => {
        expect(formatScriptError("S", "plain failure", "onRequest")).toBe("[S] onRequest: plain failure");
        expect(formatScriptError("S", new TypeError("boom"), undefined)).toContain("[S] TypeError: boom");
    });

    it("a real scriptFunction names its frames; EVAL_WRAPPER_LINES matches the wrapper", () => {
        const lib = scriptFunction(`module.exports = () => {\n    throw new Error("x");\n};`, "lib/a b.ts");
        const libMod: any = { exports: {} };
        lib({}, console, null, libMod, libMod.exports);
        let err: any;
        try {
            scriptFunction(`// one\nrequire()();`, "redwood/main.tsx")({}, console, () => libMod.exports, {}, {});
        } catch (e) {
            err = e;
        }
        expect(Number(err.stack.match(/wiretrick-script:\/\/\/lib\/a%20b\.ts:(\d+):\d+/)?.[1])).toBe(2 + EVAL_WRAPPER_LINES);
        const frames = formatScriptError("redwood/main.tsx", err).split("\n").slice(1);
        expect(frames).toHaveLength(2); // the test runner's frames are dropped
        expect(frames[0]).toMatch(/lib\/a b\.ts:2:\d+\)?$/);
        expect(frames[1]).toMatch(/^ {4}at redwood\/main\.tsx:2:\d+$/);
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

    it("compile-time (top-level) throw → a problem with the mapped line, not a Log line", () => {
        const s = new ExtensionStrategy();
        // stored meta is from the last good save (saveScript keeps it on a failed compile)
        const good = storedScript("a", "Thrower", TOPLEVEL.replace(`x.split(".");`, ""));
        s.reload([{ ...good, code: TOPLEVEL }]);
        expect(entries.filter((e) => e.level === "error")).toEqual([]);
        const err = compileScript(TOPLEVEL, { name: "Thrower" }).error;
        expect(formatScriptError("Thrower", err)).toContain("[Thrower]");
        expect(formatScriptError("Thrower", err)).toMatch(/Thrower:4:\d+/);
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

describe("compile: positions for the Problems view", () => {
    it("each route records the line of its registration (also in a loop / helper)", () => {
        const c = compileScript(["// a", 'wt.onRequest({ url: "*://a.test/*", strategy: "helper" }, () => {});', "", "function reg(u) {", "    wt.onResponseBody({ url: u, strategy: \"helper\" }, (ctx, b) => b);", "}", 'reg("*://b.test/*");', 'wt.onRequest({ url: "*://c.test/*", strategy: "helper" }, () => {});'].join("\n"));
        expect(c.error).toBeNull();
        expect(c.meta.routes.map((r) => [r.kind, r.index, r.line])).toEqual([
            ["onRequest", 0, 2],
            ["onRequest", 1, 8],
            ["onResponseBody", 0, 7],
        ]);
    });

    it("a syntax error names the line the transpiler found", async () => {
        await import("../src/shared/transpile");
        const c = compileScript(["const a: number = 1;", 'wt.onRequest({ url: "*://a.test/*", strategy: "helper" }, () => {});', "foo(", "const b = 2;"].join("\n"));
        expect(c.error).toMatch(/^SyntaxError: .* \(line 4\)$/);
    });
});
