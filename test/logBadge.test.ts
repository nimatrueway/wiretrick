import { describe, expect, it } from "vitest";
import { badgeCount, LogBadge } from "../src/ui/logBadge";

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

    it("caps the shown count", () => {
        expect(badgeCount(7)).toBe("7");
        expect(badgeCount(100)).toBe("99+");
    });
});
