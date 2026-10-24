/**
 * "onResponseBody never ran" — why a body handler whose route matched a
 * URL didn't run on a completed request, and the up-front warning for a
 * handler route that can never run where it is. Pure, so it is
 * unit-tested; the pipeline gathers the inputs (see pipeline.ts).
 */
import type { RouteKind, Strategy } from "./route";
import { strategyUnsupported } from "./strategyInfo";

export interface MissedCase {
    /** the handler route's effective strategy */
    strategy: Strategy;
    /** webRequest resource type (main_frame, script, stylesheet…) */
    type: string;
    firefox: boolean;
    mv3: boolean;
    fromCache: boolean;
    /** the local helper (helper strategy) is connected and routing */
    helperActive: boolean;
    /** the debugger strategy's own "was NOT intercepted" warning already covers this load */
    cdpWarned: boolean;
    /** page strategy: false when the request's frame has no page hook (the tab was open before Wiretrick started) */
    hookLoaded?: boolean;
    /** the request went to localhost / 127.x / [::1] (see isLoopbackUrl) */
    loopback?: boolean;
}

export const MISSED_REASONS = {
    hookNotFetch: `the "page" strategy only sees the page's own fetch/XHR — set strategy: "debugger" or "helper" on the route for other loads`,
    hookNotLoaded: `the page hook isn't loaded in this tab (it was open before Wiretrick started or updated) — reload the tab`,
    cache: "served from the browser cache — reload with cache disabled / hard reload",
    helperDown: "the local helper isn't running",
    helperLoopback: `the helper can't see localhost — Chrome never sends loopback requests through a proxy; set strategy: "page" or "debugger" on the route for these URLs`,
    fallback: "no strategy observed it — check the Log view at debug level",
} as const;

/** Types never checked: sockets and fire-and-forget pings. */
export const MISSED_SKIP_TYPES = new Set(["websocket", "ping", "beacon", "csp_report", "webbundle", "webtransport"]);

/** The reason to warn with, or null when no warning is due. */
export function missedReason(c: MissedCase): string | null {
    if (MISSED_SKIP_TYPES.has(c.type)) return null;
    // the browser applies rules itself; body handlers on rules are errors at load
    if (c.strategy === "rules") return null;
    // can never run here: routeProblem already warned once at load
    if (strategyUnsupported(c.strategy, c)) return null;
    if (c.strategy === "extension" && !c.firefox) return null;
    if (c.strategy === "page") {
        if (c.type !== "xmlhttprequest") return MISSED_REASONS.hookNotFetch;
        if (c.hookLoaded === false) return MISSED_REASONS.hookNotLoaded;
        // the hook reads fetch/XHR bodies lazily — the page may simply never read it
        return null;
    }
    if (c.strategy === "helper" && c.loopback) return MISSED_REASONS.helperLoopback;
    if (c.strategy === "helper" && !c.helperActive) return MISSED_REASONS.helperDown;
    if (c.fromCache) return MISSED_REASONS.cache;
    if (c.strategy === "debugger" && c.cdpWarned) return null;
    return MISSED_REASONS.fallback;
}

/**
 * Up-front warning when scripts load: a handler route that can never run
 * with its strategy in this browser (there is no fallback). null when fine.
 * The helper being down is reported by the helper strategy itself.
 */
export function routeProblem(r: { kind: RouteKind; strategy: Strategy; resourceTypes?: string[] }, env: { firefox: boolean; mv3: boolean }): string | null {
    const why = strategyUnsupported(r.strategy, env);
    if (why) return `strategy "${r.strategy}" is ${why} — this handler doesn't run. Set another strategy in Settings → Strategy or on the route`;
    if (r.strategy === "extension" && r.kind === "onResponseBody" && !env.firefox) {
        return `onResponseBody never runs with strategy "extension" on Chromium — its webRequest API can't read response bodies. Use "page" (page fetch/XHR, no banner), "debugger" (any resource, debugger banner) or "helper" (local helper)`;
    }
    if (r.strategy === "page" && r.kind === "onResponseHeaders") {
        return `onResponseHeaders never runs with strategy "page" — the page can't change response headers before the browser enforces them. Use "debugger", "helper" or "extension"`;
    }
    if (r.strategy === "page" && r.resourceTypes && !r.resourceTypes.includes("xmlhttprequest")) {
        return `strategy "page" only sees the page's fetch/XHR, but resourceTypes [${r.resourceTypes.join(", ")}] excludes "xmlhttprequest" — this handler never runs`;
    }
    return null;
}

/** localhost, *.localhost, 127.0.0.0/8 or [::1]: hosts Chrome never proxies */
export function isLoopbackUrl(url: string): boolean {
    let h: string;
    try {
        h = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Display name of a request type in the warning: "(document)", "(script)"… */
export function missedWhat(type: string): string {
    if (type === "main_frame") return "document";
    if (type === "sub_frame") return "frame";
    return type;
}

/**
 * Flood control: one warning per (script, url) per `perKeyMs`, at most
 * `perMinute` warnings in any rolling minute.
 */
export function makeMissedThrottle(perKeyMs = 60000, perMinute = 20): (key: string, now?: number) => boolean {
    const lastByKey = new Map<string, number>();
    const recent: number[] = [];
    return (key, now = Date.now()) => {
        const last = lastByKey.get(key);
        if (last !== undefined && now - last < perKeyMs) return false;
        while (recent.length && now - recent[0] >= 60000) recent.shift();
        if (recent.length >= perMinute) return false;
        recent.push(now);
        lastByKey.set(key, now);
        if (lastByKey.size > 1000) {
            for (const [k, t] of lastByKey) if (now - t >= perKeyMs) lastByKey.delete(k);
        }
        return true;
    };
}

/**
 * Does the frame answer the bridge's "hookPing"? A tab loaded before
 * Wiretrick started has no bridge (no receiver). No reply in time (a busy
 * page) counts as loaded — only a definite "no receiver" warns.
 */
export function frameHasHook(tabs: { sendMessage: (...a: any[]) => void }, lastError: () => unknown, tabId: number, frameId = 0, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), timeoutMs);
        try {
            tabs.sendMessage(tabId, { type: "hookPing" }, { frameId }, (resp: any) => {
                clearTimeout(timer);
                resolve(!lastError() && !!resp?.ok);
            });
        } catch {
            clearTimeout(timer);
            resolve(false);
        }
    });
}
