/**
 * Ties a strategy's handling of a request to its webRequest requestId — the
 * key of the Network tab's rows and of the "never ran" check. The extension
 * strategy has that id; the others see a request by another id (the helper's
 * message id, the debugger's Fetch id) or none (the page hook), so they CLAIM
 * the oldest request with the same method + URL (+ tab) they haven't claimed
 * yet. A request Chrome serves from its cache never reaches the helper or the
 * debugger, so it stays unclaimed and keeps its own row and "never ran" reason.
 *
 * FIFO is a heuristic: two concurrent same-URL requests whose pauses arrive
 * out of order swap ids. With no claim (no webRequest event yet, tabId -1 for
 * the debugger…) callers fall back to URL matching.
 */
export interface TrackedRequest {
    requestId: string;
    tabId: number;
    method: string;
    url: string;
    type: string;
    tabUrl: string;
    at: number;
    doneAt?: number;
    fromCache?: boolean;
    /** strategies that claimed it */
    claimedBy: Set<string>;
}

export interface ClaimOpts {
    /** ≥ 0: only requests of that tab */
    tabId?: number;
    /** skip completed requests (a request paused by the helper/debugger can't have completed) */
    pendingOnly?: boolean;
}

/** a request's pauses/messages all arrive within this */
export const CORRELATE_TTL_MS = 60_000;
/** kept this long after completion (outlasts the "never ran" check's delay) */
export const DONE_TTL_MS = 10_000;
const MAX_TRACKED = 5000;

const stripHash = (url: string): string => {
    const i = url.indexOf("#");
    return i < 0 ? url : url.slice(0, i);
};
const keyOf = (method: string, url: string): string => `${(method || "GET").toUpperCase()} ${stripHash(url)}`;

export class RequestCorrelator {
    private queues = new Map<string, TrackedRequest[]>();
    private byId = new Map<string, TrackedRequest>();
    private tabUrls = new Map<number, string>();
    private lastPrune = 0;
    now: () => number = () => Date.now();

    /** webRequest onBeforeRequest (again for each redirect hop: same requestId, new URL) */
    noteRequest(d: { requestId: string; tabId: number; method: string; url: string; type?: string; documentUrl?: string; initiator?: string; originUrl?: string }): void {
        if (!/^(https?|wss?):/.test(d.url)) return;
        const now = this.now();
        if (d.type === "main_frame" && d.tabId >= 0) this.tabUrls.set(d.tabId, d.url);
        const key = keyOf(d.method, d.url);
        const old = this.byId.get(d.requestId);
        if (old) {
            if (keyOf(old.method, old.url) === key) return;
            this.unlink(old);
        }
        const tabUrl = d.type === "main_frame" ? d.url : this.tabUrls.get(d.tabId) || d.documentUrl || d.initiator || d.originUrl || "";
        const r: TrackedRequest = { requestId: d.requestId, tabId: d.tabId, method: (d.method || "GET").toUpperCase(), url: stripHash(d.url), type: d.type || "", tabUrl, at: now, claimedBy: new Set() };
        this.byId.set(r.requestId, r);
        const q = this.queues.get(key);
        if (q) q.push(r);
        else this.queues.set(key, [r]);
        this.prune(now);
    }

    /** webRequest onCompleted / onErrorOccurred */
    noteDone(requestId: string, fromCache?: boolean): void {
        const r = this.byId.get(requestId);
        if (r) {
            r.doneAt = this.now();
            r.fromCache = !!fromCache;
        }
        this.prune(this.now());
    }

    /** the oldest matching request `who` hasn't claimed yet (and now has) */
    claim(who: string, method: string, url: string, opts: ClaimOpts = {}): TrackedRequest | undefined {
        this.prune(this.now());
        const q = this.queues.get(keyOf(method, url));
        if (!q) return undefined;
        for (const r of q) {
            if (r.claimedBy.has(who)) continue;
            if (opts.tabId !== undefined && opts.tabId >= 0 && r.tabId !== opts.tabId) continue;
            if (opts.pendingOnly && r.doneAt !== undefined) continue;
            r.claimedBy.add(who);
            return r;
        }
        return undefined;
    }

    /** `who` won't claim this request (e.g. the helper answered it before its response pause) */
    mark(requestId: string, who: string): void {
        this.byId.get(requestId)?.claimedBy.add(who);
    }

    /** the newest request for method + url (context only: tab, type, page) */
    latest(method: string, url: string): TrackedRequest | undefined {
        const q = this.queues.get(keyOf(method, url));
        return q?.[q.length - 1];
    }

    get(requestId: string): TrackedRequest | undefined {
        return this.byId.get(requestId);
    }

    forgetTab(tabId: number): void {
        this.tabUrls.delete(tabId);
    }

    reset(): void {
        this.queues.clear();
        this.byId.clear();
        this.tabUrls.clear();
        this.lastPrune = 0;
    }

    /** observe-only webRequest listeners (http/https/ws only) */
    attach(wr: typeof chrome.webRequest | undefined): void {
        const filter = { urls: ["<all_urls>"] };
        try {
            wr?.onBeforeRequest?.addListener((d: any) => void this.noteRequest(d), filter);
            wr?.onCompleted?.addListener((d: any) => void this.noteDone(d.requestId, d.fromCache), filter);
            wr?.onErrorOccurred?.addListener((d: any) => void this.noteDone(d.requestId), filter);
        } catch {
            /* no webRequest: every caller falls back to URL matching */
        }
    }

    private unlink(r: TrackedRequest): void {
        this.byId.delete(r.requestId);
        const key = keyOf(r.method, r.url);
        const q = this.queues.get(key);
        if (!q) return;
        const i = q.indexOf(r);
        if (i >= 0) q.splice(i, 1);
        if (!q.length) this.queues.delete(key);
    }

    private prune(now: number): void {
        if (now - this.lastPrune < 1000 && this.byId.size <= MAX_TRACKED) return;
        this.lastPrune = now;
        for (const r of this.byId.values()) {
            if (now - r.at > CORRELATE_TTL_MS || (r.doneAt !== undefined && now - r.doneAt > DONE_TTL_MS)) this.unlink(r);
        }
        for (const r of this.byId.values()) {
            if (this.byId.size <= MAX_TRACKED) break;
            this.unlink(r);
        }
    }
}

/**
 * A claim that sticks to one strategy-side request (a helper message, the
 * debugger's paused request): every lookup for it sees the same requestId.
 * Only successful claims are kept, so a stage that ran before the webRequest
 * event can claim on a later one.
 */
export class ClaimCache<K> {
    private claims = new Map<K, TrackedRequest>();

    constructor(
        private correlator: RequestCorrelator,
        private who: string,
        private cap = 2000,
    ) {}

    claim(key: K, method: string, url: string, opts?: ClaimOpts): TrackedRequest | undefined {
        const had = this.claims.get(key);
        if (had) return had;
        const r = this.correlator.claim(this.who, method, url, opts);
        if (!r) return undefined;
        this.claims.set(key, r);
        if (this.claims.size > this.cap) this.claims.delete(this.claims.keys().next().value!);
        return r;
    }

    forget(key: K): void {
        this.claims.delete(key);
    }

    get size(): number {
        return this.claims.size;
    }
}

/** the background's one correlator (listeners attached by createPipeline) */
export const correlator = new RequestCorrelator();
