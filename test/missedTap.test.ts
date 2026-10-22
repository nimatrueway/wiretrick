/** "modifyResponse never ran": reason selection, throttle, and the tap registry. */
import { describe, it, expect, beforeEach } from "vitest";
import { bodyTierGap, makeMissedThrottle, missedReason, missedWhat, MISSED_REASONS, type MissedCase } from "../src/shared/missedTap";
import { interventionKind, missedLine } from "../src/shared/netTypes";
import { __resetTaps, bodyTappedSince, log, logTapped } from "../src/background/engine/logs";

const base: MissedCase = { tiers: ["auto"], type: "main_frame", firefox: false, mv3: false, fromCache: false, helperActive: false, replaceOnly: false, cdpWarned: false };
const reason = (over: Partial<MissedCase>) => missedReason({ ...base, ...over });

describe("missedReason", () => {
    it("Chromium: webrequest/hook-only tiers can't touch a document/script body", () => {
        expect(reason({ tiers: ["webrequest"] })).toBe(MISSED_REASONS.chromiumNoBody);
        expect(reason({ tiers: ["hook"], type: "script" })).toBe(MISSED_REASONS.chromiumNoBody);
        expect(reason({ tiers: ["webrequest"], mv3: true, type: "stylesheet" })).toBe(MISSED_REASONS.chromiumNoBody);
        // MV3 "auto" stays on the hook — no debugger
        expect(reason({ tiers: ["auto"], mv3: true })).toBe(MISSED_REASONS.chromiumNoBody);
        // even a cached load: the tiers are the real problem
        expect(reason({ tiers: ["webrequest"], fromCache: true })).toBe(MISSED_REASONS.chromiumNoBody);
    });

    it("MV2 webrequest can still serve a replaceResponse-only script (redirect)", () => {
        expect(reason({ tiers: ["webrequest"], replaceOnly: true })).toBe(MISSED_REASONS.fallback);
        expect(reason({ tiers: ["webrequest"], replaceOnly: true, mv3: true })).toBe(MISSED_REASONS.chromiumNoBody);
    });

    it("process listed but the helper is down", () => {
        expect(reason({ tiers: ["process"] })).toBe(MISSED_REASONS.helperDown);
        expect(reason({ tiers: ["hook", "process"] })).toBe(MISSED_REASONS.helperDown);
        expect(reason({ tiers: ["process"], helperActive: true })).toBe(MISSED_REASONS.fallback);
        // falls through to cdp
        expect(reason({ tiers: ["process", "cdp"] })).toBe(MISSED_REASONS.fallback);
    });

    it("cache, the existing debugger warning, and the fallback", () => {
        expect(reason({ tiers: ["cdp"], fromCache: true })).toBe(MISSED_REASONS.cache);
        expect(reason({ tiers: ["cdp"], cdpWarned: true })).toBeNull();
        expect(reason({ tiers: ["auto"], cdpWarned: true })).toBeNull();
        expect(reason({ tiers: ["cdp"] })).toBe(MISSED_REASONS.fallback);
        expect(reason({ tiers: ["cdp"], mv3: true })).toBe(MISSED_REASONS.fallback);
    });

    it("Firefox: the webrequest tier streams every body", () => {
        expect(reason({ tiers: ["webrequest"], firefox: true })).toBe(MISSED_REASONS.fallback);
        expect(reason({ tiers: ["webrequest"], firefox: true, fromCache: true })).toBe(MISSED_REASONS.cache);
    });

    it("skips sockets and pings", () => {
        for (const type of ["websocket", "ping", "csp_report"]) expect(reason({ tiers: ["webrequest"], type })).toBeNull();
    });

    it("fetch/XHR: silent when the hook may run it, warns when nothing can", () => {
        const xhr = { type: "xmlhttprequest" };
        for (const tiers of [["hook"], ["auto"], ["webrequest", "hook"]]) expect(reason({ ...xhr, tiers })).toBeNull();
        expect(reason({ ...xhr, tiers: ["webrequest"], mv3: true })).toBeNull(); // MV3: webrequest → hook
        expect(reason({ ...xhr, tiers: ["webrequest"] })).toBe(MISSED_REASONS.chromiumNoBodyXhr);
        expect(reason({ ...xhr, tiers: ["process"] })).toBe(MISSED_REASONS.helperDown);
        expect(reason({ ...xhr, tiers: ["webrequest"], replaceOnly: true })).toBe(MISSED_REASONS.fallback);
        expect(reason({ ...xhr, tiers: ["cdp"] })).toBe(MISSED_REASONS.fallback);
        expect(reason({ ...xhr, tiers: ["webrequest"], firefox: true })).toBe(MISSED_REASONS.fallback);
    });

    it("names the request type", () => {
        expect(missedWhat("main_frame")).toBe("document");
        expect(missedWhat("script")).toBe("script");
    });
});

describe("bodyTierGap (up-front warning)", () => {
    it("only Chromium MV2 modifyResponse with no body-capable tier", () => {
        expect(bodyTierGap(["webrequest"], false, false, true)).toMatch(/never run with strategy \["webrequest"\]/);
        for (const t of ["hook", "auto", "cdp", "process"]) expect(bodyTierGap(["webrequest", t], false, false, true)).toBeNull();
        expect(bodyTierGap(["webrequest"], true, false, true)).toBeNull(); // Firefox streams bodies
        expect(bodyTierGap(["webrequest"], false, true, true)).toBeNull(); // MV3: falls back to the hook
        expect(bodyTierGap(["webrequest"], false, false, false)).toBeNull(); // replaceResponse only: redirect works
    });
});

describe("missed warning line", () => {
    it("is classified missed — never tapped — with or without an explicit kind", () => {
        const line = missedLine("Mod", "modifyResponse", "https://a.test/", "document", MISSED_REASONS.chromiumNoBody);
        expect(line).toBe(`[Mod] modifyResponse never ran for https://a.test/ (document) — ${MISSED_REASONS.chromiumNoBody}`);
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
