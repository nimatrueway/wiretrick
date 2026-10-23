import { describe, expect, it } from "vitest";
import { badgeCount, LogBadge, NetBadge } from "../src/ui/logBadge";

describe("Log view count", () => {
    it("counts errors and warnings in the buffer until cleared", () => {
        const b = new LogBadge();
        for (const lv of ["info", "error", "warn", "debug", "error"]) b.note(lv);
        expect([b.errors, b.warnings, b.empty]).toEqual([2, 1, false]);
        expect(b.title).toBe("2 errors, 1 warning in the Log");
        b.drop("error"); // fell out of the buffer
        b.drop("info");
        expect([b.errors, b.warnings]).toEqual([1, 1]);
        b.reset();
        expect(b.empty).toBe(true);
        b.drop("warn"); // never below zero
        b.note("warn");
        expect(b.title).toBe("1 warning in the Log");
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

describe("Network view count", () => {
    it("mirrors the recorded rows' observed / modified counts", () => {
        const b = new NetBadge();
        expect(b.empty).toBe(true);
        b.set({ modified: 1, observed: 2 });
        expect(b.counts).toEqual([["modified", 1], ["observed", 2]]);
        expect(b.title).toBe("1 modified, 2 observed in Network");
        b.set({ modified: 2, observed: 0 });
        expect(b.title).toBe("2 modified in Network");
        b.reset();
        expect(b.empty).toBe(true);
    });
});
