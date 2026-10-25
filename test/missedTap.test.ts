/** "onResponseBody never ran": reason selection, throttle, and the tap registry. */
import { describe, it, expect, beforeEach } from "vitest";
import { binaryOptedOut, bodySkipReason, frameHasHook, helperSkipReason, isLoopbackUrl, makeMissedThrottle, missedReason, missedWhat, routeProblem, MISSED_REASONS, type MissedCase } from "../src/shared/missedTap";
import { outcomeKind, missedLine } from "../src/shared/netTypes";
import { __resetTaps, bodyObservedSince, bodySkipSince, helperSkipSince, log, logObserved, noteBodySkip, noteHelperSkip } from "../src/background/engine/logs";

const base: MissedCase = { strategy: "debugger", type: "main_frame", firefox: false, mv3: false, fromCache: false, helperActive: false, cdpWarned: false };
const reason = (over: Partial<MissedCase>) => missedReason({ ...base, ...over });

describe("missedReason", () => {
    it("routes whose strategy can't run here were already warned at load", () => {
        expect(reason({ strategy: "helper", firefox: true })).toBeNull();
        expect(reason({ strategy: "debugger", firefox: true })).toBeNull();
        expect(reason({ strategy: "extension", mv3: true })).toBeNull();
        // Chromium webrequest can't read bodies: routeProblem covers it
        expect(reason({ strategy: "extension" })).toBeNull();
    });

    it("hook: silent for fetch/XHR (the page may never read it), explains other loads", () => {
        expect(reason({ strategy: "page", type: "xmlhttprequest" })).toBeNull();
        expect(reason({ strategy: "page", type: "script" })).toBe(MISSED_REASONS.hookNotFetch);
        expect(reason({ strategy: "page" })).toBe(MISSED_REASONS.hookNotFetch);
    });

    it("hook: fetch/XHR in a tab without the page hook (opened before Wiretrick started)", () => {
        expect(reason({ strategy: "page", type: "xmlhttprequest", hookLoaded: false })).toBe(MISSED_REASONS.hookNotLoaded);
        expect(reason({ strategy: "page", type: "xmlhttprequest", hookLoaded: true })).toBeNull();
    });

    it("process with the helper down", () => {
        expect(reason({ strategy: "helper" })).toBe(MISSED_REASONS.helperDown);
        expect(reason({ strategy: "helper", helperActive: true })).toBe(MISSED_REASONS.fallback);
    });

    it("helper on a loopback URL: Chrome never proxies it, up or down", () => {
        expect(reason({ strategy: "helper", helperActive: true, loopback: true })).toBe(MISSED_REASONS.helperLoopback);
        expect(reason({ strategy: "helper", loopback: true })).toBe(MISSED_REASONS.helperLoopback);
        expect(reason({ loopback: true })).toBe(MISSED_REASONS.fallback);
    });

    it("helper skipped the body on purpose: says why; an empty body (204/304/HEAD) isn't a miss", () => {
        const on = { strategy: "helper" as const, helperActive: true };
        expect(reason({ ...on, helperSkip: { why: "empty", contentType: "" } })).toBeNull();
        const bin = reason({ ...on, helperSkip: { why: "binary", contentType: "video/mp4; codecs=avc1" } })!;
        expect(bin).toContain("binary (video/mp4)");
        expect(bin).toContain("binary: true");
        expect(bin).toContain("settings.textTypes");
        expect(reason({ ...on, helperSkip: { why: "too-large", contentType: "" } })).toContain("64 MB");
        expect(reason({ ...on, helperSkip: { why: "stream", contentType: "text/event-stream" } })).toContain("streamed");
        expect(helperSkipReason({ why: "weird", contentType: "" })).toContain("(weird)");
        // only the helper's own skips count
        expect(reason({ strategy: "debugger", helperSkip: { why: "binary", contentType: "" } })).toBe(MISSED_REASONS.fallback);
    });

    it("binary: false on every matching route opts out of the binary warning (and the warning says so)", () => {
        const skip = { strategy: "helper" as const, why: "binary", contentType: "image/png" };
        expect(binaryOptedOut(skip, "helper", [false])).toBe(true);
        expect(binaryOptedOut(skip, "helper", [false, false])).toBe(true);
        expect(binaryOptedOut(skip, "helper", [false, undefined])).toBe(false);
        expect(binaryOptedOut(skip, "helper", [undefined])).toBe(false);
        expect(binaryOptedOut(skip, "helper", [])).toBe(false);
        expect(binaryOptedOut(skip, "debugger", [false])).toBe(false);
        expect(binaryOptedOut({ ...skip, why: "too-large" }, "helper", [false])).toBe(false);
        expect(binaryOptedOut(undefined, "helper", [false])).toBe(false);
        expect(bodySkipReason(skip)).toContain("set `binary: false` to silence this warning");
        expect(bodySkipReason(skip)).toContain('`binary: "both"`');
    });

    it("a binary route the strategy didn't serve blames the strategy (an outdated helper), not the route", () => {
        const on = { strategy: "helper" as const, helperActive: true };
        const helperSkip = { why: "binary", contentType: "image/png" };
        const outdated = reason({ ...on, helperSkip, takesBinary: true, helperOutdated: "0.3.0" })!;
        expect(outdated).toContain("helper (0.3.0) is older than");
        expect(outdated).toContain("reinstall");
        expect(outdated).not.toContain("set `binary: false`");
        expect(reason({ ...on, helperSkip, takesBinary: true })).toContain("the helper strategy didn't pass it on");
        expect(reason({ strategy: "debugger", bodySkip: { strategy: "debugger", ...helperSkip }, takesBinary: true, helperOutdated: "0.3.0" })).toContain("the debugger strategy didn't pass it on");
        expect(reason({ ...on, helperSkip, helperOutdated: "0.3.0" })).toContain("set `binary: false`");
    });
    it("debugger/page/extension binary skips explain themselves — only for their own strategy", () => {
        const skip = (strategy: any) => ({ strategy, why: "binary", contentType: "image/png" });
        expect(reason({ strategy: "debugger", bodySkip: skip("debugger") })).toContain("binary (image/png)");
        expect(reason({ strategy: "debugger", bodySkip: skip("page") })).toBe(MISSED_REASONS.fallback);
        expect(reason({ strategy: "page", type: "xmlhttprequest", bodySkip: skip("page") })).toContain("binary: true");
        expect(reason({ strategy: "extension", firefox: true, bodySkip: skip("extension") })).toContain("binary (image/png)");
        expect(reason({ strategy: "helper", helperActive: true, bodySkip: skip("helper") })).toContain("binary (image/png)");
    });

    it("body skip registry keeps the strategy; helperSkipSince sees the helper's only", () => {
        __resetTaps();
        noteBodySkip("debugger", "https://x.example/a.png", "binary", "image/png");
        expect(bodySkipSince("https://x.example/a.png", 0)).toMatchObject({ strategy: "debugger", why: "binary" });
        expect(helperSkipSince("https://x.example/a.png", 0)).toBeUndefined();
    });

    it("helper skip registry: per URL, since the request started", () => {
        __resetTaps();
        noteHelperSkip("https://v.example/videoplayback?a=1", "binary", "video/mp4");
        expect(helperSkipSince("https://v.example/videoplayback?a=1", Date.now() - 1000)).toMatchObject({ why: "binary", contentType: "video/mp4" });
        expect(helperSkipSince("https://v.example/videoplayback?a=1", Date.now() + 1000)).toBeUndefined();
        expect(helperSkipSince("https://v.example/other", 0)).toBeUndefined();
    });

    it("isLoopbackUrl", () => {
        for (const u of ["http://localhost:8081/a.json", "http://app.localhost/", "http://127.0.0.1:3000/", "http://127.1.2.3/", "http://[::1]:8080/"]) expect(isLoopbackUrl(u)).toBe(true);
        for (const u of ["https://example.com/", "http://localhost.example.com/", "http://10.0.0.1/", "not a url"]) expect(isLoopbackUrl(u)).toBe(false);
    });

    it("cache, the existing debugger warning, and the fallback", () => {
        expect(reason({ fromCache: true })).toBe(MISSED_REASONS.cache);
        expect(reason({ cdpWarned: true })).toBeNull();
        expect(reason({})).toBe(MISSED_REASONS.fallback);
        expect(reason({ mv3: true })).toBe(MISSED_REASONS.fallback);
    });

    it("Firefox: the webrequest tier streams every body", () => {
        expect(reason({ strategy: "extension", firefox: true })).toBe(MISSED_REASONS.fallback);
        expect(reason({ strategy: "extension", firefox: true, fromCache: true })).toBe(MISSED_REASONS.cache);
    });

    it("skips sockets and pings", () => {
        for (const type of ["websocket", "ping", "csp_report"]) expect(reason({ type })).toBeNull();
    });

    it("names the request type", () => {
        expect(missedWhat("main_frame")).toBe("document");
        expect(missedWhat("script")).toBe("script");
    });
});

describe("routeProblem (up-front warning, no fallback)", () => {
    const chrome = { firefox: false, mv3: false };
    const p = (kind: any, strategy: any, env = chrome, types?: string[]) => routeProblem({ kind, strategy, resourceTypes: types }, env);

    it("unavailable strategies", () => {
        expect(p("onRequest", "helper", { firefox: true, mv3: false })).toMatch(/not available in Firefox/);
        expect(p("onRequest", "debugger", { firefox: true, mv3: false })).toMatch(/not available in Firefox/);
        expect(p("onRequest", "extension", { firefox: false, mv3: true })).toMatch(/MV3/);
        expect(p("onRequest", "extension", chrome)).toBeNull();
        expect(p("onRequest", "helper", chrome)).toBeNull(); // helper down is reported by the tier
    });

    it("Chromium webrequest can't read bodies; Firefox can", () => {
        expect(p("onResponseBody", "extension")).toMatch(/can't read response bodies/);
        expect(p("replaceResponse", "extension")).toBeNull();
        expect(p("onResponseBody", "extension", { firefox: true, mv3: false })).toBeNull();
    });

    it("hook: no response headers, and types must include xmlhttprequest", () => {
        expect(p("onResponseHeaders", "page")).toMatch(/onResponseHeaders never runs/);
        expect(p("onResponseBody", "page", chrome, ["script"])).toMatch(/excludes "xmlhttprequest"/);
        expect(p("onResponseBody", "page", chrome, ["xmlhttprequest", "script"])).toBeNull();
        expect(p("onResponseBody", "page")).toBeNull();
    });
});

describe("missed warning line", () => {
    it("is classified missed — never observed — with or without an explicit kind", () => {
        const line = missedLine("Mod", "onResponseBody", "https://a.test/", "document", MISSED_REASONS.helperDown);
        expect(line).toBe(`[Mod] onResponseBody never ran for https://a.test/ (document) — ${MISSED_REASONS.helperDown}`);
        expect(outcomeKind("warn", line)).toBe("missed");
        expect(outcomeKind("warn", line, "missed")).toBe("missed");
    });
});

describe("makeMissedThrottle", () => {
    it("once per key per minute, and a global cap", () => {
        const allow = makeMissedThrottle(60000, 3);
        expect(allow("a", 0)).toBe(true);
        expect(allow("a", 1000)).toBe(false);
        expect(allow("a", 60000)).toBe(true);
        expect(allow("b", 60001)).toBe(true);
        expect(allow("c", 60002)).toBe(true);
        expect(allow("d", 60003)).toBe(false); // 3 in the last minute
        expect(allow("d", 120001)).toBe(true);
    });
});

describe("body tap registry", () => {
    beforeEach(() => __resetTaps());

    it("records body-handler lines per script+url, whatever the tab, with no manager open", () => {
        const t0 = Date.now() - 10;
        expect(bodyObservedSince("s1", "https://a.test/x", t0)).toBe(false);
        logObserved(-1, "S", "onResponseBody", "https://a.test/x", "s1");
        expect(bodyObservedSince("s1", "https://a.test/x", t0)).toBe(true);
        expect(bodyObservedSince("s2", "https://a.test/x", t0)).toBe(false);
        expect(bodyObservedSince("s1", "https://a.test/x", Date.now() + 1000)).toBe(false);
    });

    it("onRequest header taps don't count; terminal onRequest results do", () => {
        const t0 = Date.now() - 10;
        logObserved(3, "S", "onRequest", "https://a.test/h", "s1");
        log(3, "[S] onRequest → request headers (set x) https://a.test/h", "info", "s1");
        expect(bodyObservedSince("s1", "https://a.test/h", t0)).toBe(false);
        log(3, "[S] onRequest → block https://a.test/h", "info", "s1");
        expect(bodyObservedSince("s1", "https://a.test/h", t0)).toBe(true);
    });

    it("a script error counts (it ran), the missed line itself doesn't", () => {
        const t0 = Date.now() - 10;
        log(3, "[S] onResponseBody never ran for https://a.test/m (document) — x", "warn", "s1", "missed", "https://a.test/m");
        expect(bodyObservedSince("s1", "https://a.test/m", t0)).toBe(false);
        log(3, "[S] onResponseBody threw: boom", "error", "s1");
        expect(bodyObservedSince("s1", "https://a.test/m", t0)).toBe(true);
    });
});

describe("frameHasHook", () => {
    const tabs = (reply: (cb: (r: any) => void) => void) => ({ sendMessage: (_t: number, _m: any, _o: any, cb: (r: any) => void) => reply(cb) });
    it("a frame whose bridge answers has the hook", async () => {
        expect(await frameHasHook(tabs((cb) => cb({ ok: true })), () => undefined, 1, 0)).toBe(true);
    });
    it("no receiver (lastError) or a throwing sendMessage: no hook", async () => {
        expect(await frameHasHook(tabs((cb) => cb(undefined)), () => ({ message: "Receiving end does not exist." }), 1, 0)).toBe(false);
        expect(await frameHasHook({ sendMessage: () => { throw new Error("x"); } }, () => undefined, 1, 0)).toBe(false);
    });
    it("no reply in time (a busy page) doesn't count as missing", async () => {
        expect(await frameHasHook(tabs(() => {}), () => undefined, 1, 0, 5)).toBe(true);
    });
});
