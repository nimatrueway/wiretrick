/** Network-tab records shared by the background recorder and the manager UI. */

export interface NetIntervention {
    scriptId: string;
    scriptName: string;
    /** e.g. "modifyResponse applied (120b → 140b)" */
    action: string;
    level: "debug" | "info" | "warn" | "error";
    at: number;
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
export type NetPortMsg = { type: "netSnapshot"; entries: NetEntry[] } | { type: "netUpdate"; entries: NetEntry[] } | { type: "netCleared" };
