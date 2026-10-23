/** Network-tab records shared by the background recorder and the manager UI. */

/**
 * What a script did to a request: "tapped" — a handler ran but changed
 * nothing (returned undefined, the same body, or threw); "modified" — it
 * changed the body, headers, status, or blocked/redirected/answered it.
 */
export type NetKind = "tapped" | "modified";
/** "missed": a body handler should have run for this request but no tier ran it (a warning — neither tapped nor modified). */
export type InterventionKind = NetKind | "missed";

export interface NetIntervention {
    scriptId: string;
    scriptName: string;
    /** e.g. "onResponseBody applied (120b → 140b)" */
    action: string;
    level: "debug" | "info" | "warn" | "error";
    kind: InterventionKind;
    at: number;
}

const TAPPED_MARK = "→ observed (no change)";
const MISSED_MARK = " never ran for ";

/** WARN line for a body handler no tier ran: `[Name] onResponseBody never ran for <url> (document) — reason`. */
export function missedLine(scriptName: string, handler: string, url: string, what: string, reason: string): string {
    return `[${scriptName}] ${handler}${MISSED_MARK}${url} (${what}) — ${reason}`;
}

/** DEBUG log line for a handler that ran without changing anything (ends with the URL, so it annotates the request). */
export function tappedLine(scriptName: string, handler: string, url: string): string {
    return `[${scriptName}] ${handler} ${TAPPED_MARK} ${url}`;
}

/**
 * Tapped vs modified for a script-attributed log line. Engine code passes the
 * kind explicitly; relayed lines without one fall back to: errors, debug
 * lines, "tapped (no change)" lines and the script's own console/wt.log
 * output → tapped; "… never ran for …" warnings → missed; anything else (the
 * engine's INFO action lines) → modified.
 */
export function interventionKind(level: string, message: string, explicit?: InterventionKind): InterventionKind {
    if (explicit === "tapped" || explicit === "modified" || explicit === "missed") return explicit;
    if (level === "warn" && message.includes(MISSED_MARK)) return "missed";
    if (level === "debug" || level === "error" || message.includes(TAPPED_MARK)) return "tapped";
    if (/^\[[^\]]*\] (wt\.log|console\.\w+):/.test(message)) return "tapped";
    return "modified";
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
    /** recorded only from a script action (a page-strategy replacement never hits the network) */
    synthetic?: boolean;
    interventions: NetIntervention[];
}

/** background → UI port messages on the "network" port */
export type NetPortMsg = { type: "netSnapshot"; entries: NetEntry[] } | { type: "netUpdate"; entries: NetEntry[] } | { type: "netCleared" } | { type: "netRemoved"; ids: string[] };
