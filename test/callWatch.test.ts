import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCall } from "../src/shared/callWatch";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function watch() {
    const ask = vi.fn();
    const onLost = vi.fn();
    const w = watchCall({ checkMs: 15000, graceMs: 5000, ask, onLost });
    return { w, ask, onLost };
}

describe("watchCall", () => {
    it("asks the next hop after checkMs of quiet and keeps waiting while it answers", () => {
        const { w, ask, onLost } = watch();
        vi.advanceTimersByTime(14999);
        expect(ask).not.toHaveBeenCalled();
        // a handler waiting for the user: ten minutes, answered every time
        vi.advanceTimersByTime(1);
        for (let i = 1; i <= 40; i++) {
            expect(ask).toHaveBeenCalledTimes(i);
            vi.advanceTimersByTime(4999);
            w.alive();
            vi.advanceTimersByTime(15000);
        }
        expect(onLost).not.toHaveBeenCalled();
    });

    it("gives up graceMs after an unanswered ask, once", () => {
        const { w, ask, onLost } = watch();
        vi.advanceTimersByTime(15000);
        expect(ask).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(4999);
        expect(onLost).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onLost).toHaveBeenCalledTimes(1);
        w.alive(); // a late answer doesn't revive it
        vi.advanceTimersByTime(60000);
        expect(onLost).toHaveBeenCalledTimes(1);
        expect(ask).toHaveBeenCalledTimes(1);
    });

    it("stop() ends it without asking or giving up", () => {
        const { w, ask, onLost } = watch();
        vi.advanceTimersByTime(10000);
        w.stop();
        vi.advanceTimersByTime(60000);
        expect(ask).not.toHaveBeenCalled();
        expect(onLost).not.toHaveBeenCalled();
    });

    it("an ask that throws counts as unanswered", () => {
        const onLost = vi.fn();
        watchCall({ checkMs: 1000, graceMs: 500, ask: () => { throw new Error("gone"); }, onLost });
        vi.advanceTimersByTime(1500);
        expect(onLost).toHaveBeenCalledTimes(1);
    });
});
