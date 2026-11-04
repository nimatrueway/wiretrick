import { describe, it, expect, vi, afterEach } from "vitest";
import { createBusyIndicator } from "../src/background/busyIcon";
import { beginBusy, onBusyChange, whileBusy } from "../src/background/engine/busy";

afterEach(() => vi.useRealTimers());

describe("busy state", () => {
    it("reports busy while any work is in flight, once per change", async () => {
        const seen: boolean[] = [];
        const off = onBusyChange((b) => seen.push(b));
        const a = beginBusy();
        const b = beginBusy();
        a();
        a(); // ending twice doesn't count twice
        expect(seen).toEqual([true]);
        b();
        expect(seen).toEqual([true, false]);
        await whileBusy(async () => expect(seen).toEqual([true, false, true]));
        expect(seen).toEqual([true, false, true, false]);
        await expect(whileBusy(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
        expect(seen[seen.length - 1]).toBe(false);
        off();
    });
});

describe("busy icon", () => {
    const setup = () => {
        vi.useFakeTimers();
        const log: string[] = [];
        const set = createBusyIndicator({ show: (f) => log.push(`show${f}`), hide: () => log.push("hide") }, { showAfter: 150, minShown: 600, frameMs: 100 });
        return { log, set };
    };

    it("shows nothing for quick work", () => {
        const { log, set } = setup();
        set(true);
        vi.advanceTimersByTime(100);
        set(false);
        vi.advanceTimersByTime(2000);
        expect(log).toEqual([]);
    });

    it("animates while busy and stays up a minimum time", () => {
        const { log, set } = setup();
        set(true);
        vi.advanceTimersByTime(150);
        expect(log).toEqual(["show0"]);
        vi.advanceTimersByTime(200);
        expect(log).toEqual(["show0", "show1", "show2"]);
        set(false);
        vi.advanceTimersByTime(200);
        expect(log).not.toContain("hide");
        vi.advanceTimersByTime(300);
        expect(log[log.length - 1]).toBe("hide");
        const n = log.length;
        vi.advanceTimersByTime(1000);
        expect(log.length).toBe(n); // stopped animating
    });

    it("doesn't flicker when work resumes right after it ended (save → reload)", () => {
        const { log, set } = setup();
        set(true);
        vi.advanceTimersByTime(800);
        set(false);
        vi.advanceTimersByTime(50);
        set(true);
        vi.advanceTimersByTime(500);
        expect(log).not.toContain("hide");
        set(false);
        vi.advanceTimersByTime(100);
        expect(log[log.length - 1]).toBe("hide");
        expect(log.filter((l) => l === "show0")).toHaveLength(1);
    });
});
