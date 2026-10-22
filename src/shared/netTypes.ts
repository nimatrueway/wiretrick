/** Network-tab records shared by the background recorder and the manager UI. */

/**
 * What a script did to a request: "seen" — a handler ran but changed
 * nothing (returned undefined, the same body, or threw); "altered" — it
 * changed the body, headers, status, or cancelled/redirected/answered it.
 */
export type NetKind = "seen" | "altered";

export interface NetIntervention {
    scriptId: string;
    scriptName: string;
    /** e.g. "modifyResponse applied (120b → 140b)" */
    action: string;
    level: "debug" | "info" | "warn" | "error";
    kind: NetKind;
    at: number;
}

const SEEN_MARK = "→ seen (no change)";

/** DEBUG log line for a handler that ran without changing anything (ends with the URL, so it annotates the request). */
export function seenLine(scriptName: string, handler: string, url: string): string {
    return `[${scriptName}] ${handler} ${SEEN_MARK} ${url}`;
}

/**
 * Seen vs altered for a script-attributed log line. Engine code passes the
 * kind explicitly; relayed lines without one fall back to: errors, debug
 * lines, "seen (no change)" lines and the script's own console/wt.log
 * output → seen; anything else (the engine's INFO action lines) → altered.
 */
export function interventionKind(level: string, message: string, explicit?: NetKind): NetKind {
    if (explicit === "seen" || explicit === "altered") return explicit;
    if (level === "debug" || level === "error" || message.includes(SEEN_MARK)) return "seen";
    if (/^\[[^\]]*\] (wt\.log|console\.\w+):/.test(message)) return "seen";
    return "altered";
}

/** A captured request/response body (text, capped; binary as a placeholder). */
export interface NetBody {
    text: string;
    /** full size in bytes (UTF-8 for text) */
    size: number;
    truncated: boolean;
    binary: boolean;
}

export interface NetEntry {
    id: string;
    tabId: number;
    url: string;
    method: string;
    /** webRequest resource type: main_frame, script, xmlhttprequest… */
    type: string;
    status: number | null;
    statusText: string;
    mime: string;
    /** bytes, from content-length when known */
    size: number | null;
    fromCache: boolean;
    startedAt: number;
    endedAt: number | null;
    state: "pending" | "done" | "failed";
    error?: string;
    redirectTo?: string;
    initiator?: string;
    ip?: string;
    requestHeaders?: [string, string][];
    responseHeaders?: [string, string][];
    /** request payload (onBeforeRequest requestBody) */
    requestBody?: NetBody;
    /** the body the page received — known only when Wiretrick handled the response */
    responseBody?: NetBody;
    /** the upstream body before a script modified it */
    originalResponseBody?: NetBody;
    /** recorded only from a script action (hook-tier respond/replace never hits the network) */
    synthetic?: boolean;
    interventions: NetIntervention[];
}

/** background → UI port messages on the "network" port */
export type NetPortMsg = { type: "netSnapshot"; entries: NetEntry[] } | { type: "netUpdate"; entries: NetEntry[] } | { type: "netCleared" } | { type: "netRemoved"; ids: string[] };
