import { describe, expect, it } from "vitest";
import { badgeCount, LogBadge, NetBadge } from "../src/ui/logBadge";

describe("Log tab badge", () => {
    it("counts only errors and warnings until reset", () => {
        const b = new LogBadge();
        for (const lv of ["info", "error", "warn", "debug", "error"]) b.note(lv);
        expect([b.errors, b.warnings, b.empty]).toEqual([2, 1, false]);
        expect(b.title).toBe("2 errors, 1 warning since you last looked at the Log");
        b.reset();
        expect(b.empty).toBe(true);
        b.note("warn");
        expect(b.title).toBe("1 warning since you last looked at the Log");
    });

    it("exposes its pills in display order", () => {
        const b = new LogBadge();
        b.note("warn");
        expect(b.counts).toEqual([["error", 0], ["warn", 1]]);
    });

    it("caps the shown count", () => {
        expect(badgeCount(7)).toBe("7");
        expect(badgeCount(100)).toBe("99+");
    });
});

describe("Network tab badge", () => {
    it("counts requests that became seen / altered while out of view, each once", () => {
        const b = new NetBadge();
        b.note("1", "seen", true);
        b.note("1", "seen", true); // later update, same state: not recounted
        b.note("2", "altered", true);
        b.note("3", "none", true);
        expect([b.altered, b.seen]).toEqual([1, 1]);
        expect(b.counts).toEqual([["altered", 1], ["seen", 1]]);
        expect(b.title).toBe("1 altered, 1 seen since you last looked at Network");
        // seen → altered moves the request to the altered pill
        b.note("1", "altered", true);
        expect([b.altered, b.seen]).toEqual([2, 0]);
        expect(b.title).toBe("2 altered since you last looked at Network");
    });

    it("ignores what happened in view, but counts a later upgrade", () => {
        const b = new NetBadge();
        b.note("1", "seen", false);
        b.note("2", "seen", true);
        b.reset();
        expect(b.empty).toBe(true);
        b.note("2", "seen", true); // already known: no recount after looking
        expect(b.empty).toBe(true);
        b.note("1", "altered", true);
        expect([b.altered, b.seen]).toEqual([1, 0]);
    });

    it("treats redirect hops as the same request; forgets removed rows; clearAll", () => {
        const b = new NetBadge();
        b.note("7", "seen", true);
        b.note("7:r1", "seen", true);
        expect(b.seen).toBe(1);
        b.note("syn:1", "altered", true);
        b.forget(["syn:1"]); // folded into the real row, which reports it again
        b.note("8", "altered", true);
        expect([b.altered, b.seen]).toEqual([1, 1]);
        b.clearAll();
        expect(b.empty).toBe(true);
        b.note("7", "seen", true);
        expect(b.seen).toBe(1);
    });
});
