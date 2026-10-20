/**
 * Network-tab recorder. Like browser devtools it records only while
 * someone is watching: webRequest listeners (observe-only, non-blocking)
 * are attached while at least one manager holds a "network" port and
 * removed when the last one closes — zero cost otherwise.
 *
 * Script actions are attached to the request they touched via
 * annotateFromLog (every script-attributed engine log line that ends in
 * the request URL).
 */
import type { NetEntry, NetPortMsg } from "../shared/netTypes";

const MAX_ENTRIES = 1000;
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
    wr.onBeforeRequest.addListener(L.before, FILTER);
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
 * Attach a script-attributed log line ("[name] modifyResponse applied
 * (…) https://…") to the request it describes. A line with no matching
 * recorded request (e.g. the hook answered a fetch itself, so nothing
 * hit the network) becomes a synthetic entry.
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
    let target: NetEntry | undefined;
    for (const e of [...entries.values()].reverse()) {
        if (e.url !== url || e.redirectTo) continue;
        if (tabId >= 0 && e.tabId >= 0 && e.tabId !== tabId) continue;
        if (now - e.startedAt > MATCH_WINDOW_MS) break;
        target = e;
        break;
    }
    if (!target) {
        target = {
            id: `syn:${syntheticSeq++}`,
            tabId,
            url,
            method: "GET",
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
