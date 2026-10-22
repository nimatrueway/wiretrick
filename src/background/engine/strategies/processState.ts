/**
 * Tier availability. Every handler route is owned by exactly one strategy
 * (route.strategy, else settings.strategy — see shared/route.ts); a tier
 * runs only the handlers it owns, so nothing runs twice. When the owning
 * tier can't run here (helper down, debugger missing in Firefox, blocking
 * webRequest on MV3) the handler doesn't run — the pipeline warns once.
 */
import type { Strategy } from "../../../shared/route";
import { strategyUnsupported } from "../../../shared/strategyInfo";

export const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" && typeof (globalThis as any).browser?.webRequest?.filterResponseData === "function";

let active = false;
const listeners = new Set<() => void>();

export function processActive(): boolean {
    return active;
}

export function setProcessActive(v: boolean): void {
    if (v === active) return;
    active = v;
    for (const fn of listeners) fn();
}

/** called when the active flag flips (the pipeline reloads all tiers) */
export function onProcessActiveChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** why `s` can't run right now, or null when its tier is live */
export function tierUnavailable(s: Strategy): string | null {
    const why = strategyUnsupported(s, { firefox: IS_FIREFOX, mv3: __MV3__ });
    if (why) return why;
    if (s === "process" && !active) return "the local helper isn't connected (Settings → Local helper)";
    if (s === "cdp" && typeof chrome !== "undefined" && !chrome.debugger) return "chrome.debugger is unavailable";
    return null;
}
