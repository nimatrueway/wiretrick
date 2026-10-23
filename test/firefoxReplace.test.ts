/**
 * Firefox: the extension strategy serves replaceResponse / respond 200 in place
 * (filterResponseData) instead of redirecting, so the URL is kept.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

// these suites exercise the extension strategy: make it the settings default
beforeEach(() => setDefaultStrategy("extension"));
afterEach(() => setDefaultStrategy(null));

interface FakeFilter {
    ondata?: (e: any) => void;
    onstart?: () => void;
    written: Uint8Array[];
    closed: boolean;
    write(b: Uint8Array): void;
    close(): void;
}

let filters: Map<string, FakeFilter>;
let entries: any[];

function makeScript(id: string, name: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: { ...compileScript(code).meta, name } };
}

async function load() {
    vi.resetModules();
    filters = new Map();
    entries = [];
    const webRequest = {
        onBeforeRequest: { addListener: vi.fn() },
        onBeforeSendHeaders: { addListener: vi.fn() },
        onHeadersReceived: { addListener: vi.fn() },
        filterResponseData: (requestId: string) => {
            const f: FakeFilter = {
                written: [],
                closed: false,
                write(b) { this.written.push(b); },
                close() { this.closed = true; },
            };
            filters.set(requestId, f);
            return f;
        },
    };
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `moz-extension://t/${p}`, sendMessage: async () => ({}) },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        webRequest,
        tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    };
    (globalThis as any).browser = { webRequest };
    const logs = await import("../src/background/engine/logs");
    logs.addUiPort({ postMessage: (m: any) => m?.type === "log" && entries.push(m.entry), onDisconnect: { addListener: () => {} } } as any);
    const { ExtensionStrategy } = await import("../src/background/engine/strategies/extensionStrategy");
    return new ExtensionStrategy();
}

const page = (over: Record<string, any> = {}) => ({
    url: "https://site.example/page",
    method: "GET",
    tabId: 3,
    type: "main_frame",
    requestId: "f1",
    requestHeaders: [],
    statusCode: 200,
    responseHeaders: [
        { name: "Content-Type", value: "text/html" },
        { name: "Content-Length", value: "1234" },
        { name: "Content-Encoding", value: "gzip" },
    ],
    ...over,
});

const text = (f: FakeFilter) => new TextDecoder().decode(f.written[0]);

beforeEach(() => {
    delete (globalThis as any).browser;
});

describe("Firefox extension strategy: in-place replacement", () => {
    it("sync replaceResponse on a page load: no redirect, body swapped, headers fixed", async () => {
        const s = await load();
        s.reload([makeScript("a", "Page swap", `wt.replaceResponse("*", () => "<h1>NEW</h1>");`)]);
        expect((s.handleBeforeRequest(page(), null) as any).kind).toBe("allow");
        expect(filters.size).toBe(0); // wired when the response headers arrive
        const h = (await s.handleHeadersReceived(page(), null)) as any;
        expect(h.set["Content-Type"]).toBe("text/html; charset=utf-8");
        expect(h.remove).toEqual(expect.arrayContaining(["Content-Length", "Content-Encoding"]));
        const f = filters.get("f1")!;
        f.onstart!();
        expect(text(f)).toBe("<h1>NEW</h1>");
        expect(f.closed).toBe(true);
        expect(entries.filter((e) => e.scriptId === "a").map((e) => [e.level, e.message])).toEqual([
            ["info", "[Page swap] replaceResponse → text/html (12 bytes) https://site.example/page"],
        ]);
    });

    it("async replaceResponse is also served in place", async () => {
        const s = await load();
        s.reload([makeScript("a", "Async swap", `wt.replaceResponse("*", async () => JSON.stringify({ ok: 1 }));`)]);
        const d = await s.handleBeforeRequest(page({ type: "xmlhttprequest", url: "https://site.example/api" }), null);
        expect((d as any).kind).toBe("allow");
        await s.handleHeadersReceived(page({ type: "xmlhttprequest", url: "https://site.example/api" }), null);
        const f = filters.get("f1")!;
        f.onstart!();
        expect(text(f)).toBe('{"ok":1}');
    });

    it("respond 200 in place; a redirect hop keeps the replacement for the final response", async () => {
        const s = await load();
        s.reload([makeScript("a", "Mock", `wt.onRequest("*", () => ({ replaceResponse: { body: { m: true } } }));`)]);
        expect((s.handleBeforeRequest(page(), null) as any).kind).toBe("allow");
        await s.handleHeadersReceived(page({ statusCode: 302, responseHeaders: [{ name: "Location", value: "/other" }] }), null);
        expect(filters.size).toBe(0);
        const h = (await s.handleHeadersReceived(page(), null)) as any;
        expect(h.set["Content-Type"]).toBe("application/json; charset=utf-8");
        const f = filters.get("f1")!;
        f.onstart!();
        expect(text(f)).toBe('{"m":true}');
        expect(entries.find((e) => e.scriptId === "a")!.message).toMatch(/^\[Mock\] onRequest → replaceResponse 200 application\/json/);
    });

    it("respond with a non-200 status isn't served (no status control) and says so", async () => {
        const s = await load();
        s.reload([makeScript("a", "Mock", `wt.onRequest("*", () => ({ replaceResponse: { status: 404, body: "no" } }));`)]);
        expect((s.handleBeforeRequest(page(), null) as any).kind).toBe("allow");
        await s.handleHeadersReceived(page(), null);
        expect(filters.size).toBe(0);
        expect(entries.find((e) => e.scriptId === "a")).toMatchObject({ level: "warn", message: expect.stringContaining("replaceResponse 404 not served") });
    });

    it("a pruned request leaves nothing behind", async () => {
        const s = await load();
        s.reload([makeScript("a", "Page swap", `wt.replaceResponse("*", () => "x");`)]);
        s.handleBeforeRequest(page(), null);
        s.pruneRequest("f1");
        await s.handleHeadersReceived(page(), null);
        expect(filters.size).toBe(0);
    });
});
