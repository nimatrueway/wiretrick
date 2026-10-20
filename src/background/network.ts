/**
 * Network-tab recorder. Like browser devtools it records only while
 * someone is watching: webRequest listeners (observe-only, non-blocking)
 * are attached while at least one manager holds a "network" port and
 * removed when the last one closes — zero cost otherwise.
 *
 * Script actions are attached to the request they touched via
 * annotateFromLog (every script-attributed engine log line that ends in
 * the request URL); bodies via recordNetBody from the strategies that
 * handle them (the browser exposes no response bodies to webRequest).
 */
import type { NetBody, NetEntry, NetPortMsg } from "../shared/netTypes";

const MAX_ENTRIES = 1000;
/** per-body capture cap (chars of text) */
export const MAX_BODY = 256 * 1024;
const FLUSH_MS = 120;
const MATCH_WINDOW_MS = 120_000;

const entries = new Map<string, NetEntry>();
const ports = new Set<chrome.runtime.Port>();
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let syntheticSeq = 0;

const ownOrigin = (() => {
    try {
        return chrome.runtime.getURL("").replace(/\/$/, "");
    } catch {
        return "chrome-extension://";
    }
})();

function ignored(d: { url: string; initiator?: string; originUrl?: string }): boolean {
    if (!/^(https?|wss?):/.test(d.url)) return true;
    const from = d.initiator || d.originUrl || "";
    return from.startsWith(ownOrigin); // the extension's own fetches
}

function post(msg: NetPortMsg): void {
    for (const p of ports) {
        try {
            p.postMessage(msg);
        } catch {}
    }
}

function touch(id: string): void {
    dirty.add(id);
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            const changed = [...dirty].map((k) => entries.get(k)).filter((e): e is NetEntry => !!e);
            dirty.clear();
            if (changed.length) post({ type: "netUpdate", entries: changed });
        }, FLUSH_MS);
    }
}

function add(e: NetEntry): void {
    entries.set(e.id, e);
    if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
    }
    touch(e.id);
}

const headerPairs = (h?: chrome.webRequest.HttpHeader[]): [string, string][] | undefined =>
    h?.map((x) => [x.name, x.value ?? ""] as [string, string]);

function headerValue(h: chrome.webRequest.HttpHeader[] | undefined, name: string): string | undefined {
    return h?.find((x) => x.name.toLowerCase() === name)?.value;
}

function looksBinaryBytes(b: Uint8Array): boolean {
    const n = Math.min(b.length, 1024);
    for (let i = 0; i < n; i++) if (b[i] === 0) return true;
    return false;
}

/** text/bytes → a capped NetBody (null/undefined → undefined) */
export function toNetBody(v: string | Uint8Array | ArrayBuffer | null | undefined): NetBody | undefined {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== "string") {
        const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
        if (looksBinaryBytes(bytes)) return { text: "", size: bytes.byteLength, truncated: false, binary: true };
        const text = new TextDecoder().decode(bytes.byteLength > MAX_BODY * 4 ? bytes.subarray(0, MAX_BODY * 4) : bytes);
        return { text: text.slice(0, MAX_BODY), size: bytes.byteLength, truncated: text.length > MAX_BODY || bytes.byteLength > MAX_BODY * 4, binary: false };
    }
    const size = new TextEncoder().encode(v).byteLength;
    return { text: v.slice(0, MAX_BODY), size, truncated: v.length > MAX_BODY, binary: false };
}

function requestBodyOf(rb: chrome.webRequest.WebRequestBody | null | undefined): NetBody | undefined {
    if (!rb) return undefined;
    if (rb.formData) {
        const text = Object.entries(rb.formData)
            .flatMap(([k, vs]) => (vs as any[]).map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`))
            .join("&");
        return toNetBody(text);
    }
    if (rb.raw?.length) {
        const parts = rb.raw.filter((p) => p.bytes).map((p) => new Uint8Array(p.bytes as ArrayBuffer));
        if (!parts.length) return rb.raw.some((p) => p.file) ? { text: "(file upload)", size: 0, truncated: false, binary: true } : undefined;
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const all = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
            all.set(p, at);
            at += p.byteLength;
        }
        return toNetBody(all);
    }
    return undefined;
}

/** a redirect reuses the requestId: archive the hop under its own id */
function archiveRedirect(e: NetEntry, d: chrome.webRequest.WebRedirectionResponseDetails): void {
    const hop: NetEntry = {
        ...e,
        id: `${e.id}:r${syntheticSeq++}`,
        status: d.statusCode,
        statusText: d.statusLine?.replace(/^HTTP\/\S+\s+\d+\s*/, "") || "",
        redirectTo: d.redirectUrl,
        responseHeaders: headerPairs(d.responseHeaders) ?? e.responseHeaders,
        endedAt: d.timeStamp,
        state: "done",
        ip: d.ip,
    };
    entries.delete(e.id);
    add(hop);
    add({
        ...e,
        url: d.redirectUrl,
        startedAt: d.timeStamp,
        status: null,
        statusText: "",
        responseHeaders: undefined,
        responseBody: undefined,
        originalResponseBody: undefined,
        interventions: [],
    });
}

const L = {
    before(d: chrome.webRequest.WebRequestBodyDetails): void {
        if (ignored(d as any)) return;
        add({
            id: d.requestId,
            tabId: d.tabId,
            url: d.url,
            method: d.method,
            type: d.type,
            status: null,
            statusText: "",
            mime: "",
            size: null,
            fromCache: false,
            startedAt: d.timeStamp,
            endedAt: null,
            state: "pending",
            initiator: d.initiator || (d as any).originUrl,
            requestBody: requestBodyOf(d.requestBody),
            interventions: [],
        });
    },
    sendHeaders(d: chrome.webRequest.WebRequestHeadersDetails): void {
        const e = entries.get(d.requestId);
        if (!e) return;
        e.requestHeaders = headerPairs(d.requestHeaders);
        touch(e.id);
    },
    headersReceived(d: chrome.webRequest.WebResponseHeadersDetails): void {
        const e = entries.get(d.requestId);
        if (!e) return;
        e.status = d.statusCode;
        e.statusText = d.statusLine?.replace(/^HTTP\/\S+\s+\d+\s*/, "") || "";
        e.responseHeaders = headerPairs(d.responseHeaders);
        e.mime = (headerValue(d.responseHeaders, "content-type") || "").split(";")[0].trim();
        const len = Number(headerValue(d.responseHeaders, "content-length"));
        e.size = Number.isFinite(len) && headerValue(d.responseHeaders, "content-length") !== undefined ? len : null;
        touch(e.id);
    },
    redirect(d: chrome.webRequest.WebRedirectionResponseDetails): void {
        const e = entries.get(d.requestId);
        if (e) archiveRedirect(e, d);
    },
    completed(d: chrome.webRequest.WebResponseCacheDetails): void {
        const e = entries.get(d.requestId);
        if (!e) return;
        e.status = d.statusCode;
        e.fromCache = d.fromCache;
        e.ip = d.ip;
        e.endedAt = d.timeStamp;
        e.state = "done";
        if (!e.responseHeaders) e.responseHeaders = headerPairs(d.responseHeaders);
        touch(e.id);
    },
    error(d: chrome.webRequest.WebResponseErrorDetails): void {
        const e = entries.get(d.requestId);
        if (!e) return;
        e.endedAt = d.timeStamp;
        e.state = "failed";
        e.error = d.error;
        touch(e.id);
    },
};

let attached = false;
const FILTER: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

function addWithFallback(ev: any, fn: any, specs: string[]): void {
    try {
        ev.addListener(fn, FILTER, specs);
    } catch {
        // Firefox rejects "extraHeaders"
        ev.addListener(fn, FILTER, specs.filter((s) => s !== "extraHeaders"));
    }
}

function attach(): void {
    if (attached || !chrome.webRequest) return;
    attached = true;
    const wr = chrome.webRequest;
    addWithFallback(wr.onBeforeRequest, L.before, ["requestBody"]);
    addWithFallback(wr.onSendHeaders, L.sendHeaders, ["requestHeaders", "extraHeaders"]);
    addWithFallback(wr.onHeadersReceived, L.headersReceived, ["responseHeaders", "extraHeaders"]);
    wr.onBeforeRedirect.addListener(L.redirect, FILTER, ["responseHeaders"]);
    wr.onCompleted.addListener(L.completed, FILTER, ["responseHeaders"]);
    wr.onErrorOccurred.addListener(L.error, FILTER);
}

function detach(): void {
    if (!attached) return;
    attached = false;
    const wr = chrome.webRequest;
    wr.onBeforeRequest.removeListener(L.before);
    wr.onSendHeaders.removeListener(L.sendHeaders);
    wr.onHeadersReceived.removeListener(L.headersReceived);
    wr.onBeforeRedirect.removeListener(L.redirect);
    wr.onCompleted.removeListener(L.completed);
    wr.onErrorOccurred.removeListener(L.error);
}

export function isRecording(): boolean {
    return ports.size > 0;
}

export function clearNetwork(): void {
    entries.clear();
    dirty.clear();
    post({ type: "netCleared" });
}

export function addNetworkPort(port: chrome.runtime.Port): void {
    ports.add(port);
    attach();
    port.postMessage({ type: "netSnapshot", entries: [...entries.values()] } satisfies NetPortMsg);
    port.onMessage.addListener((m: any) => {
        if (m?.type === "netClear") clearNetwork();
    });
    port.onDisconnect.addListener(() => {
        ports.delete(port);
        if (!ports.size) {
            detach();
            entries.clear(); // devtools semantics: nothing kept while nobody watches
        }
    });
}

const URL_AT_END = /\s((?:https?|wss?):\/\/\S+)\s*$/;
const NAME_PREFIX = /^\[([^\]]+)\]\s*/;

/**
 * The recorded request a script action/body belongs to: the newest same-URL
 * entry (any tab when the caller doesn't know it), else a synthetic entry —
 * e.g. the hook answered a fetch itself so nothing hit the network. An
 * entry learns its tab from whichever caller knows it.
 */
function entryFor(tabId: number, url: string, method?: string): NetEntry {
    const now = Date.now();
    let target: NetEntry | undefined;
    for (const e of [...entries.values()].reverse()) {
        if (now - e.startedAt > MATCH_WINDOW_MS) break;
        if (e.url !== url || e.redirectTo) continue;
        if (method && !e.synthetic && e.method !== method) continue;
        if (tabId >= 0 && e.tabId >= 0 && e.tabId !== tabId) continue;
        target = e;
        break;
    }
    if (!target) {
        target = {
            id: `syn:${syntheticSeq++}`,
            tabId,
            url,
            method: method || "GET",
            type: "other",
            status: null,
            statusText: "",
            mime: "",
            size: null,
            fromCache: false,
            startedAt: now,
            endedAt: now,
            state: "done",
            synthetic: true,
            interventions: [],
        };
        add(target);
    }
    if (target.tabId < 0 && tabId >= 0) target.tabId = tabId;
    if (target.synthetic && method) target.method = method;
    return target;
}

export interface NetBodyRecord {
    /** -1 when unknown */
    tabId: number;
    url: string;
    method?: string;
    /** the upstream body (or the body when nothing modified it) */
    original?: string | Uint8Array | null;
    /** the body served to the page after a script changed/replaced it */
    modified?: string | Uint8Array | null;
    /** content type of a script-served body */
    mime?: string;
    status?: number;
}

/** Attach a body Wiretrick handled to its request (no-op unless recording). */
export function recordNetBody(r: NetBodyRecord): void {
    if (!ports.size) return;
    try {
        const e = entryFor(r.tabId, r.url, r.method);
        if (r.modified !== undefined && r.modified !== null) {
            e.responseBody = toNetBody(r.modified);
            e.originalResponseBody = toNetBody(r.original);
        } else if (r.original !== undefined && r.original !== null) {
            e.responseBody = toNetBody(r.original);
            e.originalResponseBody = undefined;
        }
        if (e.synthetic) {
            if (r.mime) e.mime = r.mime;
            if (r.status) e.status = r.status;
            if (e.responseBody && e.size === null) e.size = e.responseBody.size;
        }
        touch(e.id);
    } catch {
        /* recording must never break interception */
    }
}

/**
 * Attach a script-attributed log line ("[name] modifyResponse applied
 * (…) https://…") to the request it describes. A line with no matching
 * recorded request becomes a synthetic entry (see entryFor).
 */
export function annotateFromLog(tabId: number, scriptId: string, message: string, level: NetEntry["interventions"][number]["level"]): void {
    if (!ports.size) return;
    const m = URL_AT_END.exec(message);
    if (!m) return;
    const url = m[1];
    const nameMatch = NAME_PREFIX.exec(message);
    const scriptName = nameMatch ? nameMatch[1] : scriptId;
    const action = message.slice(nameMatch ? nameMatch[0].length : 0, m.index).trim();
    const now = Date.now();
    const target = entryFor(tabId, url);
    target.interventions.push({ scriptId, scriptName, action, level, at: now });
    touch(target.id);
}

/** test seam */
export const __test = {
    L,
    entries,
    reset: () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        entries.clear();
        dirty.clear();
        ports.clear();
        attached = false;
    },
};
