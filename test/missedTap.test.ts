/** "onResponseBody never ran": reason selection, throttle, and the tap registry. */
import { describe, it, expect, beforeEach } from "vitest";
import { makeMissedThrottle, missedReason, missedWhat, routeProblem, MISSED_REASONS, type MissedCase } from "../src/shared/missedTap";
import { interventionKind, missedLine } from "../src/shared/netTypes";
import { __resetTaps, bodyTappedSince, log, logTapped } from "../src/background/engine/logs";

const base: MissedCase = { strategy: "debugger", type: "main_frame", firefox: false, mv3: false, fromCache: false, helperActive: false, cdpWarned: false };
const reason = (over: Partial<MissedCase>) => missedReason({ ...base, ...over });

describe("missedReason", () => {
    it("routes whose strategy can't run here were already warned at load", () => {
        expect(reason({ strategy: "helper", firefox: true })).toBeNull();
        expect(reason({ strategy: "debugger", firefox: true })).toBeNull();
        expect(reason({ strategy: "webRequest", mv3: true })).toBeNull();
        // Chromium webrequest can't read bodies: routeProblem covers it
        expect(reason({ strategy: "webRequest" })).toBeNull();
    });

    it("hook: silent for fetch/XHR (the page may never read it), explains other loads", () => {
        expect(reason({ strategy: "page", type: "xmlhttprequest" })).toBeNull();
        expect(reason({ strategy: "page", type: "script" })).toBe(MISSED_REASONS.hookNotFetch);
        expect(reason({ strategy: "page" })).toBe(MISSED_REASONS.hookNotFetch);
    });

    it("process with the helper down", () => {
        expect(reason({ strategy: "helper" })).toBe(MISSED_REASONS.helperDown);
        expect(reason({ strategy: "helper", helperActive: true })).toBe(MISSED_REASONS.fallback);
    });

    it("cache, the existing debugger warning, and the fallback", () => {
        expect(reason({ fromCache: true })).toBe(MISSED_REASONS.cache);
        expect(reason({ cdpWarned: true })).toBeNull();
        expect(reason({})).toBe(MISSED_REASONS.fallback);
        expect(reason({ mv3: true })).toBe(MISSED_REASONS.fallback);
    });

    it("Firefox: the webrequest tier streams every body", () => {
        expect(reason({ strategy: "webRequest", firefox: true })).toBe(MISSED_REASONS.fallback);
        expect(reason({ strategy: "webRequest", firefox: true, fromCache: true })).toBe(MISSED_REASONS.cache);
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
        expect(p("onRequest", "webRequest", { firefox: false, mv3: true })).toMatch(/MV3/);
        expect(p("onRequest", "webRequest", chrome)).toBeNull();
        expect(p("onRequest", "helper", chrome)).toBeNull(); // helper down is reported by the tier
    });

    it("Chromium webrequest can't read bodies; Firefox can", () => {
        expect(p("onResponseBody", "webRequest")).toMatch(/can't read response bodies/);
        expect(p("replaceResponse", "webRequest")).toBeNull();
        expect(p("onResponseBody", "webRequest", { firefox: true, mv3: false })).toBeNull();
    });

    it("hook: no response headers, and types must include xmlhttprequest", () => {
        expect(p("onResponseHeaders", "page")).toMatch(/onResponseHeaders never runs/);
        expect(p("onResponseBody", "page", chrome, ["script"])).toMatch(/excludes "xmlhttprequest"/);
        expect(p("onResponseBody", "page", chrome, ["xmlhttprequest", "script"])).toBeNull();
        expect(p("onResponseBody", "page")).toBeNull();
    });
});

describe("missed warning line", () => {
    it("is classified missed — never tapped — with or without an explicit kind", () => {
        const line = missedLine("Mod", "onResponseBody", "https://a.test/", "document", MISSED_REASONS.helperDown);
        expect(line).toBe(`[Mod] onResponseBody never ran for https://a.test/ (document) — ${MISSED_REASONS.helperDown}`);
        expect(interventionKind("warn", line)).toBe("missed");
        expect(interventionKind("warn", line, "missed")).toBe("missed");
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
        expect(bodyTappedSince("s1", "https://a.test/x", t0)).toBe(false);
        logTapped(-1, "S", "onResponseBody", "https://a.test/x", "s1");
        expect(bodyTappedSince("s1", "https://a.test/x", t0)).toBe(true);
        expect(bodyTappedSince("s2", "https://a.test/x", t0)).toBe(false);
        expect(bodyTappedSince("s1", "https://a.test/x", Date.now() + 1000)).toBe(false);
    });

    it("onRequest header taps don't count; terminal onRequest results do", () => {
        const t0 = Date.now() - 10;
        logTapped(3, "S", "onRequest", "https://a.test/h", "s1");
        log(3, "[S] onRequest → request headers (set x) https://a.test/h", "info", "s1");
        expect(bodyTappedSince("s1", "https://a.test/h", t0)).toBe(false);
        log(3, "[S] onRequest → block https://a.test/h", "info", "s1");
        expect(bodyTappedSince("s1", "https://a.test/h", t0)).toBe(true);
    });

    it("a script error counts (it ran), the missed line itself doesn't", () => {
        const t0 = Date.now() - 10;
        log(3, "[S] onResponseBody never ran for https://a.test/m (document) — x", "warn", "s1", "missed", "https://a.test/m");
        expect(bodyTappedSince("s1", "https://a.test/m", t0)).toBe(false);
        log(3, "[S] onResponseBody threw: boom", "error", "s1");
        expect(bodyTappedSince("s1", "https://a.test/m", t0)).toBe(true);
    });
});
