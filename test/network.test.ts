/** Network recorder: webRequest → NetEntry, redirects, and script annotation. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const listeners: Record<string, Function[]> = {};
const ev = (name: string) => ({
    addListener: (fn: Function) => (listeners[name] ||= []).push(fn),
    removeListener: (fn: Function) => (listeners[name] = (listeners[name] || []).filter((f) => f !== fn)),
});
(globalThis as any).chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://ext/${p}` },
    webRequest: {
        onBeforeRequest: ev("before"),
        onSendHeaders: ev("send"),
        onHeadersReceived: ev("headers"),
        onBeforeRedirect: ev("redirect"),
        onCompleted: ev("completed"),
        onErrorOccurred: ev("error"),
    },
};

const { addNetworkCountsPort, addNetworkPort, annotateFromLog, recordNetBody, toNetBody, MAX_BODY, MAX_IDLE, __test } = await import("../src/background/network");
const { L, entries } = __test;

function fakePort() {
    const sent: any[] = [];
    const onMsg: Function[] = [];
    const onDisc: Function[] = [];
    return {
        sent,
        port: {
            postMessage: (m: any) => sent.push(m),
            onMessage: { addListener: (f: Function) => onMsg.push(f) },
            onDisconnect: { addListener: (f: Function) => onDisc.push(f) },
        } as any,
        message: (m: any) => onMsg.forEach((f) => f(m)),
        disconnect: () => onDisc.forEach((f) => f()),
    };
}

const req = (id: string, url: string, extra: any = {}) =>
    L.before({ requestId: id, url, method: "GET", type: "xmlhttprequest", tabId: 7, timeStamp: Date.now(), frameId: 0, parentFrameId: -1, ...extra } as any);

describe("network recorder", () => {
    beforeEach(() => {
        __test.reset();
        for (const k of Object.keys(listeners)) delete listeners[k];
    });

    it("attaches webRequest listeners only while a port is connected", () => {
        expect(listeners.before?.length ?? 0).toBe(0);
        const p = fakePort();
        addNetworkPort(p.port);
        expect(listeners.before.length).toBe(1);
        expect(p.sent[0]).toEqual({ type: "netSnapshot", entries: [] });
        req("1", "https://a.test/x");
        p.disconnect();
        expect(listeners.before.length).toBe(0);
        expect(entries.size).toBe(0);
    });

    it("records a request lifecycle and flushes batched updates", async () => {
        vi.useFakeTimers();
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/api?q=1");
        L.sendHeaders({ requestId: "1", requestHeaders: [{ name: "Accept", value: "*/*" }] } as any);
        L.headersReceived({
            requestId: "1",
            statusCode: 200,
            statusLine: "HTTP/1.1 200 OK",
            responseHeaders: [
                { name: "Content-Type", value: "application/json; charset=utf-8" },
                { name: "Content-Length", value: "42" },
            ],
        } as any);
        L.completed({ requestId: "1", statusCode: 200, fromCache: false, ip: "1.2.3.4", timeStamp: Date.now() + 5 } as any);
        vi.advanceTimersByTime(200);
        vi.useRealTimers();
        const upd = p.sent.filter((m) => m.type === "netUpdate");
        expect(upd.length).toBe(1); // one batch
        const e = upd[0].entries[0];
        expect(e).toMatchObject({ status: 200, statusText: "OK", mime: "application/json", size: 42, state: "done", ip: "1.2.3.4" });
        expect(e.requestHeaders).toEqual([["Accept", "*/*"]]);
        p.disconnect();
    });

    it("ignores the extension's own and non-http requests", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/", { initiator: "chrome-extension://ext" });
        req("2", "data:text/plain,hi");
        expect(entries.size).toBe(0);
        p.disconnect();
    });

    it("keeps script-touched rows while no Network tab is open, without listeners or bodies", () => {
        annotateFromLog(7, "s1", "[S] onRequest → observed (no change) https://a.test/x", "debug", "observed");
        annotateFromLog(7, "s1", "[S] onResponseBody applied https://a.test/x", "info");
        recordNetBody({ tabId: 7, url: "https://a.test/x", modified: "big" });
        expect(listeners.before?.length ?? 0).toBe(0);
        expect([...entries.values()].map((e) => [e.url, e.outcomes.map((i) => i.kind), e.responseBody])).toEqual([["https://a.test/x", ["observed", "modified"], undefined]]);
        const p = fakePort();
        addNetworkPort(p.port);
        expect(p.sent[0].entries.length).toBe(1);
        p.disconnect();
    });

    it("a passive counts port gets script-touched rows without starting the recording", async () => {
        vi.useFakeTimers();
        try {
            const c = fakePort();
            const last = () => c.sent[c.sent.length - 1];
            addNetworkCountsPort(c.port);
            expect(listeners.before?.length ?? 0).toBe(0);
            expect(c.sent[0]).toEqual({ type: "netSnapshot", entries: [] });
            annotateFromLog(7, "s1", "[S] onRequest → observed (no change) https://a.test/x", "debug", "observed");
            await vi.advanceTimersByTimeAsync(200);
            expect(last().type).toBe("netUpdate");
            expect(last().entries.map((e: any) => e.url)).toEqual(["https://a.test/x"]);
            // the Network tab opens and closes: untouched rows go, the counts port is resynced
            const p = fakePort();
            addNetworkPort(p.port);
            req("1", "https://a.test/plain");
            p.disconnect();
            expect(last()).toMatchObject({ type: "netSnapshot" });
            expect(last().entries.map((e: any) => e.url)).toEqual(["https://a.test/x"]);
            c.disconnect();
            annotateFromLog(7, "s1", "[S] onRequest → observed (no change) https://a.test/y", "debug", "observed");
            const n = c.sent.length;
            await vi.advanceTimersByTimeAsync(200);
            expect(c.sent.length).toBe(n);
        } finally {
            vi.useRealTimers();
        }
    });

    it("on close keeps only touched rows (bodies dropped, pending settled) and caps idle rows", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/plain");
        req("2", "https://a.test/hit");
        annotateFromLog(7, "s1", "[S] onResponseBody applied https://a.test/hit", "info");
        recordNetBody({ tabId: 7, url: "https://a.test/hit", original: "a", modified: "b" });
        p.disconnect();
        expect([...entries.keys()]).toEqual(["2"]);
        expect(entries.get("2")).toMatchObject({ state: "done", responseBody: undefined, originalResponseBody: undefined });
        for (let i = 0; i < MAX_IDLE + 20; i++) annotateFromLog(7, "s1", `[S] onRequest → set x https://a.test/${i}`, "info");
        expect(entries.size).toBe(MAX_IDLE);
    });

    it("records a page navigation opened from the extension (e.g. an editor link)", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/", { type: "main_frame", initiator: "chrome-extension://ext" });
        annotateFromLog(7, "s1", "[S] onResponseHeaders → set x-a https://a.test/", "info");
        expect([...entries.values()].map((e) => [e.id, e.outcomes.length])).toEqual([["1", 1]]);
        p.disconnect();
    });

    it("shows the final response headers, including blocking-listener changes", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/");
        L.headersReceived({ requestId: "1", statusCode: 200, responseHeaders: [{ name: "a", value: "1" }] } as any);
        L.completed({ requestId: "1", statusCode: 200, timeStamp: Date.now(), responseHeaders: [{ name: "a", value: "1" }, { name: "x-debug", value: "1" }] } as any);
        expect(entries.get("1")!.responseHeaders).toEqual([["a", "1"], ["x-debug", "1"]]);
        p.disconnect();
    });

    it("archives redirect hops as their own rows", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "http://a.test/");
        L.redirect({ requestId: "1", statusCode: 301, statusLine: "HTTP/1.1 301 Moved", redirectUrl: "https://a.test/", timeStamp: Date.now() } as any);
        const all = [...entries.values()];
        expect(all.map((e) => [e.url, e.status, e.redirectTo])).toEqual([
            ["http://a.test/", 301, "https://a.test/"],
            ["https://a.test/", null, undefined],
        ]);
        p.disconnect();
    });

    it("marks failures", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/");
        L.error({ requestId: "1", error: "net::ERR_BLOCKED_BY_CLIENT", timeStamp: Date.now() } as any);
        expect(entries.get("1")).toMatchObject({ state: "failed", error: "net::ERR_BLOCKED_BY_CLIENT" });
        p.disconnect();
    });

    it("annotates the matching request with the script action", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/api");
        req("2", "https://a.test/api", { tabId: 9 });
        annotateFromLog(7, "s1", "[My script] onResponseBody applied (10b → 12b) https://a.test/api", "info");
        expect(entries.get("1")!.outcomes).toMatchObject([{ scriptId: "s1", scriptName: "My script", action: "onResponseBody applied (10b → 12b)" }]);
        expect(entries.get("2")!.outcomes).toEqual([]);
        p.disconnect();
    });

    it("records each annotation as observed or modified", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/api");
        annotateFromLog(7, "s1", "[W] onRequest → observed (no change) https://a.test/api", "debug", "observed");
        annotateFromLog(7, "s1", "[W] onResponseBody applied (1b → 2b) https://a.test/api", "info");
        annotateFromLog(7, "s1", "[W] onResponseBody threw: boom https://a.test/api", "error");
        expect(entries.get("1")!.outcomes.map((i) => [i.action, i.kind])).toEqual([
            ["onRequest → observed (no change)", "observed"],
            ["onResponseBody applied (1b → 2b)", "modified"],
            ["onResponseBody threw: boom", "observed"],
        ]);
        p.disconnect();
    });

    it("names the script, not the tier tag, for tier-prefixed lines", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/api");
        annotateFromLog(7, "s1", "[helper] [My script] onResponseBody applied (1b → 2b) https://a.test/api", "info");
        annotateFromLog(7, "s2", "[helper] onRequest → block https://a.test/api", "info");
        expect(entries.get("1")!.outcomes.map((i) => [i.scriptName, i.action])).toEqual([
            ["My script", "onResponseBody applied (1b → 2b) (helper)"],
            ["helper", "onRequest → block"],
        ]);
        p.disconnect();
    });

    it("creates a synthetic row when nothing hit the network", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        annotateFromLog(7, "s1", "[Mock] replaceResponse 200 https://a.test/mocked", "info");
        const [e] = [...entries.values()];
        expect(e).toMatchObject({ synthetic: true, url: "https://a.test/mocked", tabId: 7 });
        expect(e.outcomes[0].action).toBe("replaceResponse 200");
        p.disconnect();
    });

    it("a extension-strategy annotation made before the recorder saw the request lands on the real row", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        // the pipeline's blocking onBeforeRequest runs before the recorder's
        annotateFromLog(7, "s1", "[Hdr] onRequest → request headers (set x-a) https://a.test/api", "info");
        req("1", "https://a.test/api");
        expect([...entries.values()].filter((e) => e.synthetic)).toEqual([]);
        expect(entries.get("1")!.outcomes).toMatchObject([{ scriptName: "Hdr", action: "onRequest → request headers (set x-a)" }]);
        expect(p.sent.some((m) => m.type === "netRemoved")).toBe(true);
        p.disconnect();
    });

    it("a missed warning annotates its request by explicit URL, as kind missed", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/page", { type: "main_frame" });
        annotateFromLog(7, "s1", "[Mod] onResponseBody never ran for https://a.test/page (document) — the local helper isn't running", "warn", "missed", "https://a.test/page");
        expect(entries.get("1")!.outcomes).toMatchObject([{ scriptName: "Mod", kind: "missed", action: "onResponseBody never ran for https://a.test/page (document) — the local helper isn't running" }]);
        p.disconnect();
    });

    it("ignores lines without a URL, with or without a viewer", () => {
        annotateFromLog(7, "s1", "[Mock] compiled ok", "info");
        expect(entries.size).toBe(0);
        const p = fakePort();
        addNetworkPort(p.port);
        annotateFromLog(7, "s1", "[Mock] compiled ok", "info");
        expect(entries.size).toBe(0);
        p.disconnect();
    });

    it("netClear from the UI clears and broadcasts", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/");
        p.message({ type: "netClear" });
        expect(entries.size).toBe(0);
        expect(p.sent[p.sent.length - 1]).toEqual({ type: "netCleared" });
        p.disconnect();
    });

    it("captures request payloads (raw bytes and form data)", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/post", { method: "POST", requestBody: { raw: [{ bytes: new TextEncoder().encode('{"a":1}').buffer }] } });
        req("2", "https://a.test/form", { method: "POST", requestBody: { formData: { q: ["x y"], n: ["1"] } } });
        expect(entries.get("1")!.requestBody).toMatchObject({ text: '{"a":1}', size: 7, binary: false });
        expect(entries.get("2")!.requestBody!.text).toBe("q=x%20y&n=1");
        p.disconnect();
    });

    it("records original + modified bodies on the matching request", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        req("1", "https://a.test/todos/1");
        recordNetBody({ tabId: -1, url: "https://a.test/todos/1", method: "GET", original: new TextEncoder().encode('{"x":1}'), modified: '{"x":2}' });
        const e = entries.get("1")!;
        expect(e.responseBody!.text).toBe('{"x":2}');
        expect(e.originalResponseBody!.text).toBe('{"x":1}');
        // unmodified: the body alone
        req("2", "https://a.test/plain");
        recordNetBody({ tabId: 7, url: "https://a.test/plain", original: "hello", modified: null });
        expect(entries.get("2")!.responseBody!.text).toBe("hello");
        expect(entries.get("2")!.originalResponseBody).toBeUndefined();
        p.disconnect();
    });

    it("a script-served response becomes a synthetic row in the right tab", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        annotateFromLog(-1, "s1", "[Mock] onRequest → replaceResponse 200 https://a.test/mocked", "info");
        recordNetBody({ tabId: 9, url: "https://a.test/mocked", method: "POST", modified: "{}", mime: "application/json", status: 201 });
        expect(entries.size).toBe(1);
        const [e] = [...entries.values()];
        // the unknown-tab annotation and the tab-aware body land on one row
        expect(e).toMatchObject({ synthetic: true, tabId: 9, method: "POST", mime: "application/json", status: 201 });
        expect(e.outcomes).toHaveLength(1);
        expect(e.responseBody!.text).toBe("{}");
        p.disconnect();
    });

    it("caps big bodies and marks binary ones", () => {
        const big = toNetBody("x".repeat(MAX_BODY + 10))!;
        expect(big.truncated).toBe(true);
        expect(big.text.length).toBe(MAX_BODY);
        expect(big.size).toBe(MAX_BODY + 10);
        expect(toNetBody(new Uint8Array([1, 0, 2]))).toMatchObject({ binary: true, size: 3 });
        expect(toNetBody(null)).toBeUndefined();
    });
});
