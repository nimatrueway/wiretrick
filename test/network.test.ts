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

const { addNetworkPort, annotateFromLog, __test } = await import("../src/background/network");
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
        annotateFromLog(7, "s1", "[My script] modifyResponse applied (10b → 12b) https://a.test/api", "info");
        expect(entries.get("1")!.interventions).toMatchObject([{ scriptId: "s1", scriptName: "My script", action: "modifyResponse applied (10b → 12b)" }]);
        expect(entries.get("2")!.interventions).toEqual([]);
        p.disconnect();
    });

    it("creates a synthetic row when nothing hit the network", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        annotateFromLog(7, "s1", "[Mock] respond 200 https://a.test/mocked", "info");
        const [e] = [...entries.values()];
        expect(e).toMatchObject({ synthetic: true, url: "https://a.test/mocked", tabId: 7 });
        expect(e.interventions[0].action).toBe("respond 200");
        p.disconnect();
    });

    it("does nothing without a viewer, and ignores lines without a URL", () => {
        annotateFromLog(7, "s1", "[Mock] respond 200 https://a.test/x", "info");
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
});
