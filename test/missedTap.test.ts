/** "modifyResponse never ran": reason selection, throttle, and the tap registry. */
import { describe, it, expect, beforeEach } from "vitest";
import { makeMissedThrottle, missedReason, missedWhat, routeProblem, MISSED_REASONS, type MissedCase } from "../src/shared/missedTap";
import { interventionKind, missedLine } from "../src/shared/netTypes";
import { __resetTaps, bodyTappedSince, log, logTapped } from "../src/background/engine/logs";

const base: MissedCase = { strategy: "cdp", type: "main_frame", firefox: false, mv3: false, fromCache: false, helperActive: false, cdpWarned: false };
const reason = (over: Partial<MissedCase>) => missedReason({ ...base, ...over });

describe("missedReason", () => {
    it("routes whose strategy can't run here were already warned at load", () => {
        expect(reason({ strategy: "process", firefox: true })).toBeNull();
        expect(reason({ strategy: "cdp", firefox: true })).toBeNull();
        expect(reason({ strategy: "webrequest", mv3: true })).toBeNull();
        // Chromium webrequest can't read bodies: routeProblem covers it
        expect(reason({ strategy: "webrequest" })).toBeNull();
    });

    it("hook: silent for fetch/XHR (the page may never read it), explains other loads", () => {
        expect(reason({ strategy: "hook", type: "xmlhttprequest" })).toBeNull();
        expect(reason({ strategy: "hook", type: "script" })).toBe(MISSED_REASONS.hookNotFetch);
        expect(reason({ strategy: "hook" })).toBe(MISSED_REASONS.hookNotFetch);
    });

    it("process with the helper down", () => {
        expect(reason({ strategy: "process" })).toBe(MISSED_REASONS.helperDown);
        expect(reason({ strategy: "process", helperActive: true })).toBe(MISSED_REASONS.fallback);
    });

    it("cache, the existing debugger warning, and the fallback", () => {
        expect(reason({ fromCache: true })).toBe(MISSED_REASONS.cache);
        expect(reason({ cdpWarned: true })).toBeNull();
        expect(reason({})).toBe(MISSED_REASONS.fallback);
        expect(reason({ mv3: true })).toBe(MISSED_REASONS.fallback);
    });

    it("Firefox: the webrequest tier streams every body", () => {
        expect(reason({ strategy: "webrequest", firefox: true })).toBe(MISSED_REASONS.fallback);
        expect(reason({ strategy: "webrequest", firefox: true, fromCache: true })).toBe(MISSED_REASONS.cache);
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
    const p = (kind: any, strategy: any, env = chrome, types?: string[]) => routeProblem({ kind, strategy, types }, env);

    it("unavailable strategies", () => {
        expect(p("onRequest", "process", { firefox: true, mv3: false })).toMatch(/not available in Firefox/);
        expect(p("onRequest", "cdp", { firefox: true, mv3: false })).toMatch(/not available in Firefox/);
        expect(p("onRequest", "webrequest", { firefox: false, mv3: true })).toMatch(/MV3/);
        expect(p("onRequest", "webrequest", chrome)).toBeNull();
        expect(p("onRequest", "process", chrome)).toBeNull(); // helper down is reported by the tier
    });

    it("Chromium webrequest can't read bodies; Firefox can", () => {
        expect(p("modifyResponse", "webrequest")).toMatch(/can't read response bodies/);
        expect(p("replaceResponse", "webrequest")).toBeNull();
        expect(p("modifyResponse", "webrequest", { firefox: true, mv3: false })).toBeNull();
    });

    it("hook: no response headers, and types must include xmlhttprequest", () => {
        expect(p("onResponseHeaders", "hook")).toMatch(/onResponseHeaders never runs/);
        expect(p("modifyResponse", "hook", chrome, ["script"])).toMatch(/excludes "xmlhttprequest"/);
        expect(p("modifyResponse", "hook", chrome, ["xmlhttprequest", "script"])).toBeNull();
        expect(p("modifyResponse", "hook")).toBeNull();
    });
});

describe("missed warning line", () => {
    it("is classified missed — never tapped — with or without an explicit kind", () => {
        const line = missedLine("Mod", "modifyResponse", "https://a.test/", "document", MISSED_REASONS.helperDown);
        expect(line).toBe(`[Mod] modifyResponse never ran for https://a.test/ (document) — ${MISSED_REASONS.helperDown}`);
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
        logTapped(-1, "S", "modifyResponse", "https://a.test/x", "s1");
        expect(bodyTappedSince("s1", "https://a.test/x", t0)).toBe(true);
        expect(bodyTappedSince("s2", "https://a.test/x", t0)).toBe(false);
        expect(bodyTappedSince("s1", "https://a.test/x", Date.now() + 1000)).toBe(false);
    });

    it("onRequest header taps don't count; terminal onRequest results do", () => {
        const t0 = Date.now() - 10;
        logTapped(3, "S", "onRequest", "https://a.test/h", "s1");
        log(3, "[S] onRequest → request headers (set x) https://a.test/h", "info", "s1");
        expect(bodyTappedSince("s1", "https://a.test/h", t0)).toBe(false);
        log(3, "[S] onRequest → cancel https://a.test/h", "info", "s1");
        expect(bodyTappedSince("s1", "https://a.test/h", t0)).toBe(true);
    });

    it("a script error counts (it ran), the missed line itself doesn't", () => {
        const t0 = Date.now() - 10;
        log(3, "[S] modifyResponse never ran for https://a.test/m (document) — x", "warn", "s1", "missed", "https://a.test/m");
        expect(bodyTappedSince("s1", "https://a.test/m", t0)).toBe(false);
        log(3, "[S] modifyResponse threw: boom", "error", "s1");
        expect(bodyTappedSince("s1", "https://a.test/m", t0)).toBe(true);
    });
});
