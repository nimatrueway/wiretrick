/**
 * Strategy availability. Every handler route is owned by exactly one strategy
 * (route.strategy, else settings.defaultStrategy — see shared/route.ts); a strategy
 * runs only the handlers it owns, so nothing runs twice. When the owning
 * strategy can't run here (helper down, debugger missing in Firefox, blocking
 * webRequest on MV3) the handler doesn't run — the pipeline warns once.
 */
import type { Strategy } from "../../../shared/route";
import { strategyUnsupported } from "../../../shared/strategyInfo";

export const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" && typeof (globalThis as any).browser?.webRequest?.filterResponseData === "function";

let active = false;
const listeners = new Set<() => void>();

export function helperActive(): boolean {
    return active;
}

export function setHelperActive(v: boolean): void {
    if (v === active) return;
    active = v;
    for (const fn of listeners) fn();
}

/** called when the active flag flips (the pipeline reloads all strategies) */
export function onHelperActiveChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** why `s` can't run right now, or null when its strategy is live */
export function strategyUnavailable(s: Strategy): string | null {
    const why = strategyUnsupported(s, { firefox: IS_FIREFOX, mv3: __MV3__ });
    if (why) return why;
    if (s === "helper" && !active) return "the local helper isn't connected (Settings → Local helper)";
    if (s === "debugger" && typeof chrome !== "undefined" && !chrome.debugger) return "chrome.debugger is unavailable";
    return null;
}
