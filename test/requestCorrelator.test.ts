/** Per-request correlation: webRequest requestId claims, Network rows, and the "never ran" registries. */
import { describe, it, expect, beforeEach } from "vitest";

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

const { ClaimCache, RequestCorrelator, CORRELATE_TTL_MS, DONE_TTL_MS } = await import("../src/background/engine/requestCorrelator");
const { addNetworkPort, recordNetBody, __test } = await import("../src/background/network");
const { __resetTaps, allLogs, bodyObservedSince, bodySkipSince, log, noteHelperSkip } = await import("../src/background/engine/logs");
const { missedReason, MISSED_REASONS } = await import("../src/shared/missedTap");
const { compileScript } = await import("../src/shared/compile");
const { reportSkipped, setSkipRoutes } = await import("../src/background/engine/skipped");
const { L, entries } = __test;

const URL = "https://cdn.test/live/playlist.m3u8";
const wr = (requestId: string, extra: any = {}) => ({ requestId, url: URL, method: "GET", tabId: 4, type: "xmlhttprequest", ...extra });

function fakePort() {
    const onDisc: Function[] = [];
    return {
        port: {
            postMessage: () => {},
            onMessage: { addListener: () => {} },
            onDisconnect: { addListener: (f: Function) => onDisc.push(f) },
        } as any,
        disconnect: () => onDisc.forEach((f) => f()),
    };
}

describe("RequestCorrelator", () => {
    let c: InstanceType<typeof RequestCorrelator>;
    let now = 1_000_000;
    beforeEach(() => {
        now = 1_000_000;
        c = new RequestCorrelator();
        c.now = () => now;
    });

    it("claims same method + URL requests oldest first, once per strategy", () => {
        c.noteRequest(wr("1"));
        c.noteRequest(wr("2"));
        expect(c.claim("helper", "GET", URL)?.requestId).toBe("1");
        expect(c.claim("helper", "get", URL + "#frag")?.requestId).toBe("2");
        expect(c.claim("helper", "GET", URL)).toBeUndefined();
        // another strategy claims independently
        expect(c.claim("page", "GET", URL)?.requestId).toBe("1");
        expect(c.claim("helper", "POST", URL)).toBeUndefined();
    });

    it("filters by tab and skips completed requests when asked (a cache hit never reaches the helper)", () => {
        c.noteRequest(wr("1"));
        c.noteRequest(wr("2", { tabId: 9 }));
        c.noteRequest(wr("3"));
        c.noteDone("1", true);
        expect(c.claim("debugger", "GET", URL, { tabId: 9, pendingOnly: true })?.requestId).toBe("2");
        expect(c.claim("debugger", "GET", URL, { tabId: 4, pendingOnly: true })?.requestId).toBe("3");
        // without pendingOnly (the page hook reads bodies after completion) it's claimable
        expect(c.claim("page", "GET", URL, { tabId: 4 })?.requestId).toBe("1");
    });

    it("mark: a strategy won't claim a request it already answered", () => {
        c.noteRequest(wr("1"));
        c.noteRequest(wr("2"));
        c.mark("1", "helper:res");
        expect(c.claim("helper:res", "GET", URL)?.requestId).toBe("2");
    });

    it("a redirect re-notes the requestId under its new URL", () => {
        c.noteRequest(wr("1"));
        c.noteRequest(wr("1", { url: "https://cdn.test/other" }));
        expect(c.claim("helper", "GET", URL)).toBeUndefined();
        expect(c.claim("helper", "GET", "https://cdn.test/other")?.requestId).toBe("1");
        // the same URL again (no redirect) keeps its claims
        c.noteRequest(wr("1", { url: "https://cdn.test/other" }));
        expect(c.claim("helper", "GET", "https://cdn.test/other")).toBeUndefined();
    });

    it("expires stale and completed requests", () => {
        c.noteRequest(wr("1"));
        c.noteRequest(wr("2"));
        now += 2000;
        c.noteDone("2");
        now += DONE_TTL_MS + 1;
        expect(c.get("2")).toBeDefined(); // pruned lazily
        expect(c.claim("x", "GET", URL)?.requestId).toBe("1");
        expect(c.get("2")).toBeUndefined();
        now += CORRELATE_TTL_MS;
        expect(c.claim("y", "GET", URL)).toBeUndefined();
        expect(c.get("1")).toBeUndefined();
    });

    it("tracks the tab's page for the context", () => {
        c.noteRequest({ requestId: "p", url: "https://site.test/", method: "GET", tabId: 4, type: "main_frame" });
        c.noteRequest(wr("1"));
        expect(c.latest("GET", URL)).toMatchObject({ requestId: "1", tabId: 4, type: "xmlhttprequest", tabUrl: "https://site.test/" });
    });

    it("ClaimCache: one claim per strategy-side request, retried until it succeeds", () => {
        const cache = new ClaimCache<number>(c, "helper");
        expect(cache.claim(7, "GET", URL)).toBeUndefined(); // webRequest event not in yet
        c.noteRequest(wr("1"));
        c.noteRequest(wr("2"));
        expect(cache.claim(7, "GET", URL)?.requestId).toBe("1");
        expect(cache.claim(7, "GET", URL)?.requestId).toBe("1"); // stable
        expect(cache.claim(8, "GET", URL)?.requestId).toBe("2");
        cache.forget(7);
        expect(cache.size).toBe(1);
        expect(cache.claim(7, "GET", URL)).toBeUndefined(); // both claimed
    });

    it("attach listens to webRequest", () => {
        for (const k of Object.keys(listeners)) delete listeners[k];
        c.attach((globalThis as any).chrome.webRequest);
        listeners.before[0](wr("1"));
        listeners.completed[0]({ requestId: "1", fromCache: true });
        expect(c.get("1")).toMatchObject({ fromCache: true });
        expect(c.claim("helper", "GET", URL, { pendingOnly: true })).toBeUndefined();
    });
});

describe("two requests to the same URL", () => {
    beforeEach(() => {
        __test.reset();
        __resetTaps();
        setSkipRoutes([]);
    });

    it("each Network row gets its own outcomes (by requestId), not the latest row", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        L.before({ ...wr("1"), timeStamp: Date.now() } as any);
        L.before({ ...wr("2"), timeStamp: Date.now() + 3 } as any);
        log(4, `[helper] [S] onResponseBody applied (1b → 2b) ${URL}`, "info", "s1", undefined, undefined, "1");
        log(4, `[S] onResponseBody never ran for ${URL} (fetch/XHR) — ${MISSED_REASONS.cache}`, "warn", "s1", "missed", URL, "2");
        recordNetBody({ tabId: -1, url: URL, original: "a", modified: "ab", requestId: "1" });
        expect(entries.get("1")!.outcomes.map((o) => o.kind)).toEqual(["modified"]);
        expect(entries.get("1")!.responseBody?.text).toBe("ab");
        expect(entries.get("2")!.outcomes.map((o) => o.kind)).toEqual(["missed"]);
        expect(entries.get("2")!.responseBody).toBeUndefined();
        // the log lines carry their request
        expect(allLogs().filter((l) => l.scriptId === "s1").map((l) => l.requestId)).toEqual(["1", "2"]);
        // no requestId: the newest same-URL row, as before
        log(4, `[S] onResponseBody applied (1b → 2b) ${URL}`, "info", "s1");
        expect(entries.get("2")!.outcomes).toHaveLength(2);
        p.disconnect();
    });

    it("while idle (no Network tab) they become two synthetic rows; a row recorded later adopts its own", () => {
        log(4, `[S] onResponseBody applied (1b → 2b) ${URL}`, "info", "s1", undefined, undefined, "10");
        log(4, `[S] onResponseBody never ran for ${URL} (fetch/XHR) — x`, "warn", "s1", "missed", URL, "11");
        expect([...entries.keys()]).toEqual(["10", "11"]);
        expect(entries.get("10")!.synthetic).toBe(true);
        // a blocking listener annotated it before the recorder's onBeforeRequest ran
        L.before({ ...wr("11"), timeStamp: Date.now() } as any);
        expect(entries.get("11")!.synthetic).toBeUndefined();
        expect(entries.get("11")!.outcomes.map((o) => o.kind)).toEqual(["missed"]);
        expect(entries.get("10")!.outcomes.map((o) => o.kind)).toEqual(["modified"]); // not adopted by URL
    });

    it("a skip/tap of one request isn't the other's: each gets its own 'never ran' reason", () => {
        const since = Date.now() - 10;
        // request 1 reached the helper, which skipped its binary body; request 2 came from the cache
        noteHelperSkip(URL, "binary", "application/octet-stream", "1");
        const s1 = bodySkipSince(URL, since, "1");
        const s2 = bodySkipSince(URL, since, "2");
        expect(s1).toMatchObject({ strategy: "helper", why: "binary" });
        expect(s2).toBeUndefined();
        const base = { strategy: "helper" as const, type: "xmlhttprequest", firefox: false, mv3: true, helperActive: true, cdpWarned: false };
        const r1 = missedReason({ ...base, fromCache: false, bodySkip: s1 });
        const r2 = missedReason({ ...base, fromCache: true, bodySkip: s2 });
        expect(r1).toContain("binary");
        expect(r2).toBe(MISSED_REASONS.cache);
        // a skip that didn't know its request still applies by URL
        noteHelperSkip("https://cdn.test/x.ts", "binary", "video/mp2t");
        expect(bodySkipSince("https://cdn.test/x.ts", since, "3")).toMatchObject({ why: "binary" });
    });

    it("only the request a handler ran for counts as tapped", () => {
        const since = Date.now() - 10;
        log(4, `[helper] [S] onResponseBody applied (1b → 2b) ${URL}`, "info", "s1", undefined, undefined, "1");
        expect(bodyObservedSince("s1", URL, since, "1")).toBe(true);
        expect(bodyObservedSince("s1", URL, since, "2")).toBe(false);
        expect(bodyObservedSince("s2", URL, since, "1")).toBe(false);
        // a line without a requestId counts for any request to the URL
        log(4, `[S] onResponseBody applied (1b → 2b) ${URL}`, "info", "s1");
        expect(bodyObservedSince("s1", URL, since, "2")).toBe(true);
    });

    it("'→ skipped' warnings land on their own request's row", () => {
        const p = fakePort();
        addNetworkPort(p.port);
        L.before({ ...wr("1"), timeStamp: Date.now() } as any);
        L.before({ ...wr("2"), timeStamp: Date.now() } as any);
        const script = (id: string, code: string) => ({ id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: { ...compileScript(code).meta, name: id } });
        setSkipRoutes([
            script("a", `wt.onRequest("*://cdn.test/*", () => ({ block: true }));`),
            script("b", `wt.onResponseBody("*://cdn.test/*", (ctx, body) => body);`),
        ] as any);
        reportSkipped(4, { url: URL, method: "GET", type: "xmlhttprequest" }, { scriptId: "a", scriptName: "a", kind: "onRequest", index: 1, strategy: "extension", outcome: "block" }, "1");
        expect(entries.get("1")!.outcomes.length).toBeGreaterThan(0);
        expect(entries.get("2")!.outcomes).toEqual([]);
        p.disconnect();
    });
});
