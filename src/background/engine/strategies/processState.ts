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
