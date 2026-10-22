/**
 * Shared ownership rule for the "process" tier (external helper proxy).
 *
 * A script is process-owned when its strategy list names "process" with
 * only "hook" tiers before it AND the helper is connected with routing
 * active. The webrequest / chromeBody / cdp tiers skip process-owned
 * scripts so no handler runs twice; when the helper is unavailable the
 * list falls through as usual (["process","cdp"] → cdp).
 */
import { parseStrategyList } from "../../../shared/metaParser";

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

/** strategy list chooses "process" (preceded only by "hook") — helper state aside */
export function listsProcess(strategyRaw: string | string[] | undefined): boolean {
    for (const t of parseStrategyList(strategyRaw as any)) {
        if (t === "process") return true;
        if (t !== "hook") return false;
    }
    return false;
}

export function isProcessOwned(strategyRaw: string | string[] | undefined): boolean {
    return active && listsProcess(strategyRaw);
}

/**
 * May the page hook (fetch/XHR patch) run this script? Only when its list
 * names "hook" or "auto" (MV3 also: "webrequest", which falls back to the
 * hook there) and the helper doesn't own it. cdp/process-only scripts are
 * left to their network-level tier, so handlers never run twice.
 */
export function hookEligible(strategyRaw: string | string[] | undefined): boolean {
    if (isProcessOwned(strategyRaw)) return false;
    return parseStrategyList(strategyRaw as any).some((t) => t === "hook" || t === "auto" || (__MV3__ && t === "webrequest"));
}

/**
 * Chromium MV2: does the blocking webRequest tier serve this script's
 * replaceResponse / status-200 respond itself? It can only do so by
 * redirecting — to a data: URL, or for page loads to the extension's
 * serve.html (the address bar then shows the extension URL and the page
 * loses its origin). Otherwise the debugger tier fulfills it in place.
 * - "webrequest" listed before "cdp"/"auto": redirect.
 * - "cdp" first: the debugger tier, for every request.
 * - "auto" first: the debugger tier for page and frame loads (where a
 *   redirect shows); subresources keep the data: URL — invisible to the
 *   user, served from the first request on, and no debugger needed.
 * - neither listed (["hook"], or ["process"] with the helper down): the
 *   redirect stays the fallback.
 * `type` is the webRequest resource type; omitted = a page load.
 */
export function webRequestServesBody(strategyRaw: string | string[] | undefined, type = "main_frame"): boolean {
    for (const t of parseStrategyList(strategyRaw as any)) {
        if (t === "webrequest") return true;
        if (t === "cdp") return false;
        if (t === "auto") return type !== "main_frame" && type !== "sub_frame";
    }
    return true;
}
