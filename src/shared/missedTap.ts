/**
 * "modifyResponse never ran" — why a body handler a script declared for a
 * URL didn't run on a completed request. Pure, so it is unit-tested; the
 * pipeline gathers the inputs (see pipeline.ts, onCompleted).
 */

export interface MissedCase {
    /** the script's parsed strategy list */
    tiers: string[];
    /** webRequest resource type (main_frame, script, stylesheet…) */
    type: string;
    firefox: boolean;
    mv3: boolean;
    fromCache: boolean;
    /** the local helper (process tier) is connected and routing */
    helperActive: boolean;
    /** the script has replaceResponse but no modifyResponse */
    replaceOnly: boolean;
    /** the debugger tier's own "was NOT intercepted" warning already covers this load */
    cdpWarned: boolean;
}

export const MISSED_REASONS = {
    chromiumNoBody: `Chromium's webRequest can't read response bodies and the hook only sees fetch/XHR — add "cdp" or "process" to the script's strategy`,
    chromiumNoBodyXhr: `Chromium's webRequest can't read response bodies — add "hook" (page fetch/XHR, no banner), "cdp" or "process" to the script's strategy`,
    cache: "served from the browser cache — reload with cache disabled / hard reload",
    helperDown: "the local helper isn't running",
    fallback: "no tier tapped it — check the Log at debug level",
} as const;

/** Types never checked: sockets and fire-and-forget pings. */
export const MISSED_SKIP_TYPES = new Set(["websocket", "ping", "beacon", "csp_report", "webbundle", "webtransport"]);

/** May the page hook run this script (MV3 runs "webrequest" there too)? */
function hookCapable(tiers: string[], mv3: boolean): boolean {
    return tiers.some((t) => t === "hook" || t === "auto" || (mv3 && t === "webrequest"));
}

/** The reason to warn with, or null when no warning is due. */
export function missedReason(c: MissedCase): string | null {
    if (MISSED_SKIP_TYPES.has(c.type)) return null;
    if (c.type === "xmlhttprequest") {
        // the hook reads fetch/XHR bodies lazily — the page may simply never read it
        if (hookCapable(c.tiers, c.mv3)) return null;
        if (!c.firefox && !c.tiers.includes("cdp") && !(c.tiers.includes("process") && c.helperActive) && !(!c.mv3 && c.replaceOnly && c.tiers.includes("webrequest"))) {
            return c.tiers.includes("process") ? MISSED_REASONS.helperDown : MISSED_REASONS.chromiumNoBodyXhr;
        }
    }
    // Firefox: the webrequest tier streams every body (filterResponseData)
    if (c.firefox) return c.fromCache ? MISSED_REASONS.cache : MISSED_REASONS.fallback;
    // MV2 runs "auto" on the debugger for non-fetch loads; MV3 only an explicit "cdp"
    const cdp = c.tiers.includes("cdp") || (!c.mv3 && c.tiers.includes("auto"));
    const process = c.tiers.includes("process");
    // MV2 webrequest can still answer a sync replaceResponse (by redirect)
    const webReplace = !c.mv3 && c.replaceOnly && c.tiers.includes("webrequest");
    if (!cdp && !(process && c.helperActive) && !webReplace) {
        return process ? MISSED_REASONS.helperDown : MISSED_REASONS.chromiumNoBody;
    }
    if (c.fromCache) return MISSED_REASONS.cache;
    if (cdp && c.cdpWarned) return null;
    return MISSED_REASONS.fallback;
}

/**
 * Up-front warning when a script is loaded: on Chromium MV2 a modifyResponse
 * whose strategy list names no body-capable tier ("hook", "auto", "cdp",
 * "process") can never run anywhere. null when nothing to say.
 */
export function bodyTierGap(tiers: string[], firefox: boolean, mv3: boolean, modify: boolean): string | null {
    if (!modify || firefox || mv3) return null;
    if (tiers.some((t) => t === "hook" || t === "auto" || t === "cdp" || t === "process")) return null;
    return `modifyResponse will never run with strategy [${tiers.map((t) => `"${t}"`).join(", ")}] on Chromium — its webRequest API can't read response bodies. Add "hook" (page fetch/XHR, no banner), "cdp" (any resource, debugger banner) or "process" (local helper)`;
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
