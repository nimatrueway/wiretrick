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
    /** the local helper (process tier) is connected and routing */
    helperActive: boolean;
    /** the debugger tier's own "was NOT intercepted" warning already covers this load */
    cdpWarned: boolean;
}

export const MISSED_REASONS = {
    hookNotFetch: `the "page" strategy only sees the page's own fetch/XHR — set strategy: "debugger" or "helper" on the route for other loads`,
    cache: "served from the browser cache — reload with cache disabled / hard reload",
    helperDown: "the local helper isn't running",
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
    if (c.strategy === "webRequest" && !c.firefox) return null;
    if (c.strategy === "page") {
        // the hook reads fetch/XHR bodies lazily — the page may simply never read it
        return c.type === "xmlhttprequest" ? null : MISSED_REASONS.hookNotFetch;
    }
    if (c.strategy === "helper" && !c.helperActive) return MISSED_REASONS.helperDown;
    if (c.fromCache) return MISSED_REASONS.cache;
    if (c.strategy === "debugger" && c.cdpWarned) return null;
    return MISSED_REASONS.fallback;
}

/**
 * Up-front warning when scripts load: a handler route that can never run
 * with its strategy in this browser (there is no fallback). null when fine.
 * The helper being down is reported by the process tier itself.
 */
export function routeProblem(r: { kind: RouteKind; strategy: Strategy; resourceTypes?: string[] }, env: { firefox: boolean; mv3: boolean }): string | null {
    const why = strategyUnsupported(r.strategy, env);
    if (why) return `strategy "${r.strategy}" is ${why} — this handler doesn't run. Set another strategy in Settings → Strategy or on the route`;
    if (r.strategy === "webRequest" && r.kind === "onResponseBody" && !env.firefox) {
        return `onResponseBody never runs with strategy "webRequest" on Chromium — its webRequest API can't read response bodies. Use "page" (page fetch/XHR, no banner), "debugger" (any resource, debugger banner) or "helper" (local helper)`;
    }
    if (r.strategy === "page" && r.kind === "onResponseHeaders") {
        return `onResponseHeaders never runs with strategy "page" — the page can't change response headers before the browser enforces them. Use "debugger", "helper" or "webRequest"`;
    }
    if (r.strategy === "page" && r.resourceTypes && !r.resourceTypes.includes("xmlhttprequest")) {
        return `strategy "page" only sees the page's fetch/XHR, but resourceTypes [${r.resourceTypes.join(", ")}] excludes "xmlhttprequest" — this handler never runs`;
    }
    return null;
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
