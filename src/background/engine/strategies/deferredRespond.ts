/**
 * An onRequest `respond` the blocking webRequest tier decided but can't
 * serve in place (a status other than 200, or a script that prefers the
 * debugger tier so the URL is kept): the debugger tier fulfills it at the
 * Request stage from here instead of running the handler a second time.
 */
export interface DeferredRespond {
    scriptId: string;
    scriptName: string;
    respond: { status?: number; mime?: string; body?: any; headers?: { set?: Record<string, string> } };
    at: number;
}

const MAX_AGE_MS = 30_000;
const stash = new Map<string, DeferredRespond>();
const keyOf = (tabId: number, method: string, url: string) => `${tabId}|${method}|${url}`;

export function deferRespond(tabId: number, method: string, url: string, d: Omit<DeferredRespond, "at">): void {
    const now = Date.now();
    for (const [k, v] of stash) if (now - v.at > MAX_AGE_MS) stash.delete(k);
    stash.set(keyOf(tabId, method, url), { ...d, at: now });
}

/** the deferred respond for this request, consumed */
export function takeDeferredRespond(tabId: number, method: string, url: string): DeferredRespond | undefined {
    const k = keyOf(tabId, method, url);
    const v = stash.get(k);
    if (!v) return undefined;
    stash.delete(k);
    return Date.now() - v.at <= MAX_AGE_MS ? v : undefined;
}
