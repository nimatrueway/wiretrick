/** Which strategies this build/browser can run. Keep in sync with docs/strategies.md#compatibility. */
import type { Strategy } from "./route";

function hasDnr(): boolean {
    const g = globalThis as any;
    return !!(g.chrome?.declarativeNetRequest || g.browser?.declarativeNetRequest);
}

/** why a strategy can't run in this build/browser, or null when it can */
export function strategyUnsupported(s: Strategy, env: { firefox: boolean; mv3: boolean; dnr?: boolean }): string | null {
    if (s === "rules") return (env.dnr ?? hasDnr()) ? null : "not available in this browser (no declarativeNetRequest)";
    if (env.firefox && (s === "helper" || s === "debugger")) return "not available in Firefox";
    if (!env.firefox && env.mv3 && s === "extension") return "not available in Chrome MV3 (blocking webRequest, which it relies on, was removed)";
    return null;
}
