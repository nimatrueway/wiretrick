/**
 * `wt.fetch(url, { bypass: true })`: a short-lived registry of requests no
 * script's handlers may touch. The fetch registers its method + URL before
 * it starts; each strategy asks `bypassed()` when it sees a request, which
 * takes the entry and remembers the strategy's request id so the later
 * stages of the same request (headers, response) are skipped too. The
 * `rules` strategy can't ask: a top-priority allow rule covers the URL
 * while the fetch runs (`bypassRule`).
 */
import { log } from "./logs";

const TTL_MS = 10_000;
/** how long a taken request's id stays bypassed (its later stages) */
const ID_TTL_MS = 60_000;
/** DNR session rule ids from here up are bypass rules (rulesStrategy leaves them alone) */
export const BYPASS_RULE_BASE = 900_000;

interface Entry {
    method: string;
    url: string;
    /** -1: any tab (a background fetch has none) */
    tabId: number;
    scriptId: string;
    scriptName: string;
    expires: number;
}

let entries: Entry[] = [];
const ids = new Map<string, number>();

const norm = (url: string): string => {
    try {
        const u = new URL(url);
        u.hash = "";
        return u.href;
    } catch {
        return url;
    }
};

function prune(now: number): void {
    if (entries.some((e) => e.expires <= now)) entries = entries.filter((e) => e.expires > now);
    for (const [id, at] of ids) if (at <= now) ids.delete(id);
}

/** register a bypassed request; returns its removal (call it when the fetch settles) */
export function addBypass(req: { method: string; url: string; tabId?: number; scriptId: string; scriptName: string }, ttlMs = TTL_MS): () => void {
    const e: Entry = { method: req.method.toUpperCase(), url: norm(req.url), tabId: req.tabId ?? -1, scriptId: req.scriptId, scriptName: req.scriptName, expires: Date.now() + ttlMs };
    entries.push(e);
    return () => {
        entries = entries.filter((x) => x !== e);
    };
}

/**
 * Is this request a bypassed `wt.fetch`? `id` is the strategy's own id for
 * the request (e.g. `"wr:" + requestId`): a later stage with the same id
 * is bypassed without an entry. The first match is logged.
 */
export function bypassed(req: { method: string; url: string; tabId?: number }, id?: string): boolean {
    if (!entries.length && !ids.size) return false;
    const now = Date.now();
    prune(now);
    if (id && ids.has(id)) {
        ids.set(id, now + ID_TTL_MS);
        return true;
    }
    const method = req.method.toUpperCase();
    const url = norm(req.url);
    const tabId = req.tabId ?? -1;
    const i = entries.findIndex((e) => e.method === method && e.url === url && (e.tabId === -1 || e.tabId === tabId));
    if (i < 0) return false;
    const [e] = entries.splice(i, 1);
    if (id) ids.set(id, now + ID_TTL_MS);
    log(tabId, `[${e.scriptName}] wt.fetch bypass: ${method} ${req.url} — no script's handlers run for it`, "info", e.scriptId, "observed", req.url);
    return true;
}

/** forget everything (tests) */
export function resetBypass(): void {
    entries = [];
    ids.clear();
}

// ---- rules strategy: a session allow rule per bypassed fetch ----

let nextRuleId = BYPASS_RULE_BASE;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the declarativeNetRequest rule that lets one request past every other session rule */
export function bypassRule(id: number, method: string, url: string): any {
    return {
        id,
        priority: 2 ** 31 - 1,
        action: { type: "allow" },
        condition: { regexFilter: `^${escapeRe(norm(url))}(#.*)?$`, requestMethods: [method.toLowerCase()], tabIds: [-1] },
    };
}

/** updateSessionRules, never rejecting: promise (Firefox `browser`) or callback (Chromium) */
function updateSessionRules(opts: any): Promise<boolean> {
    const g = globalThis as any;
    return new Promise((resolve) => {
        try {
            if (g.browser?.declarativeNetRequest?.updateSessionRules) return void g.browser.declarativeNetRequest.updateSessionRules(opts).then(() => resolve(true), () => resolve(false));
            const api = g.chrome?.declarativeNetRequest;
            if (typeof api?.updateSessionRules !== "function") return resolve(false);
            api.updateSessionRules(opts, () => resolve(!g.chrome.runtime.lastError));
        } catch {
            resolve(false);
        }
    });
}

/**
 * Add a bypass allow rule while `run` runs (a no-op without
 * declarativeNetRequest session rules). A rule the browser rejects (e.g. a
 * regex too long) doesn't stop the fetch.
 */
export async function withBypassRule<T>(method: string, url: string, run: () => Promise<T>): Promise<T> {
    const id = nextRuleId++;
    if (nextRuleId > BYPASS_RULE_BASE + 99_999) nextRuleId = BYPASS_RULE_BASE;
    const added = await updateSessionRules({ removeRuleIds: [id], addRules: [bypassRule(id, method, url)] });
    try {
        return await run();
    } finally {
        if (added) void updateSessionRules({ removeRuleIds: [id] });
    }
}
