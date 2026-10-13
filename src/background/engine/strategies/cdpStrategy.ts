/**
 * Tier C: chrome.debugger + CDP Fetch domain. Opt-in per script
 * (@strategy cdp) — used for main-frame HTML transforms and anything the
 * hook/proxy tiers cannot see. Attaches lazily, only while body-modifying
 * requests are in flight for a matching script.
 */
import { matchAny } from "../../../shared/matcher";
import { parseStrategyList } from "../../../shared/metaParser";
import { compileScript, makeScriptOverrides, isThenable, isAsyncFn, type HandlerFn } from "../../../shared/compile";
import { storageGet, storageSet } from "../../../shared/chromeApi";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { dlog } from "../../../shared/debugLog";
import { debuggerAttach, debuggerSend, debuggerDetach } from "../../../shared/chromeApi";

interface CdpScript {
    scriptId: string;
    name: string;
    match: string[];
    transform: HandlerFn;
    /** async onRequest handler (redirect/cancel honored at Request stage) */
    onRequest?: HandlerFn;
    /** async onResponseHeaders handler (merged at Response stage) */
    onResponseHeaders?: HandlerFn;
    /** async replaceResponse handler (fulfills the body) */
    replaceResponse?: HandlerFn;
}

/**
 * Tier C participation rule: the debugger is used ONLY when the script's
 * strategy list explicitly contains "cdp", or is exactly ["auto"]
 * (auto's documented default is hook → cdp).
 */
function usesCdp(strategyRaw: string): boolean {
    const list = parseStrategyList(strategyRaw);
    if (list.includes("cdp")) return true;
    return list.length === 1 && list[0] === "auto";
}

const LEARN_KEY = "resCdpLearn";
const XHR_TYPES = new Set(["xmlhttprequest", "websocket"]);
const MIN_OBSERVATIONS = 3;

export class CdpStrategy {
    /** tabId → attached */
    private attached = new Set<number>();
    private scripts: CdpScript[] = [];
    /** scriptId → resource types it has matched (banner-minimization learning) */
    private learn: { [scriptId: string]: { [type: string]: number } } = {};
    /** tabId → timer for idle auto-detach */
    private idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
    /** tabId → in-flight ensureAttached promise (dedup concurrent calls) */
    private attachInFlight = new Map<number, Promise<void>>();
    /** requestId → stashed async request-header changes from onRequest */
    private pendingAsyncHeaders = new Map<string, Promise<any[]>>();

    reload(scripts: Script[]): void {
        this.scripts = [];
        // Only scripts whose strategy list admits CDP participate — an
        // explicit "hook"/"webrequest" list never touches the debugger.
        for (const s of scripts) {
            if (!s.enabled) continue;
            if (!usesCdp(s.meta.strategy)) continue;
            const c = compileScript(s.code, makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, msg) => log(-1, `res.log: ${msg}`, "info", id), (id, level, msg) => log(-1, `script.console: ${msg}`, level, id)));
            // async-only for onRequest/onResponseHeaders/replaceResponse —
            // sync handlers are served by the blocking webRequest tier
            const wantsCdp =
                !!c.handlers.modifyResponse ||
                isAsyncFn(c.handlers.onRequest) ||
                isAsyncFn(c.handlers.onResponseHeaders) ||
                isAsyncFn(c.handlers.replaceResponse);
            if (!wantsCdp) continue;
            this.scripts.push({
                scriptId: s.id,
                name: s.meta.name,
                match: s.meta.match,
                transform: c.handlers.modifyResponse as HandlerFn,
                onRequest: isAsyncFn(c.handlers.onRequest) ? c.handlers.onRequest! : undefined,
                onResponseHeaders: isAsyncFn(c.handlers.onResponseHeaders) ? c.handlers.onResponseHeaders! : undefined,
                replaceResponse: isAsyncFn(c.handlers.replaceResponse) ? c.handlers.replaceResponse! : undefined,
            });
        }
    }

    private matchingScripts(url: string): CdpScript[] {
        return this.scripts.filter((s) => matchAny(s.match, url));
    }

    /** Injected by background: are hook-claimed URLs skipped? */
    isClaimed: (url: string) => boolean = () => false;

    /** Learn what resource types each script actually matches. */
    noteResourceType(scriptIds: string[], type: string): void {
        let changed = false;
        for (const id of scriptIds) {
            const entry = this.learn[id] || (this.learn[id] = {});
            entry[type] = (entry[type] || 0) + 1;
            changed = true;
        }
        if (changed) void storageSet({ [LEARN_KEY]: this.learn });
    }

    /**
     * A script that has only ever matched fetch/XHR resources is handled
     * banner-free by the page hook — don't let it trigger the debugger.
     */
    private isXhrOnly(scriptId: string): boolean {
        const entry = this.learn[scriptId];
        if (!entry) return false;
        const total = Object.values(entry).reduce((a, b) => a + b, 0);
        if (total < MIN_OBSERVATIONS) return false;
        return Object.keys(entry).every((t) => XHR_TYPES.has(t));
    }

    /** Scripts matching url that still legitimately need the debugger. */
    cdpRelevantScripts(url: string): CdpScript[] {
        return this.matchingScripts(url).filter((s) => !this.isXhrOnly(s.scriptId));
    }

    /** Forget per-tab state on tab close. */
    forgetTab(tabId: number): void {
        const t = this.idleTimers.get(tabId);
        if (t) clearTimeout(t);
        this.idleTimers.delete(tabId);
    }

    /** Detach when the page settled — the banner disappears while the user browses. */
    scheduleIdleDetach(tabId: number, graceMs = 8000): void {
        const prev = this.idleTimers.get(tabId);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
            this.idleTimers.delete(tabId);
            if (this.attached.has(tabId)) {
                void this.detach(tabId);
                dlog("cdp", "idle detach (banner cleared)", { tabId });
            }
        }, graceMs);
        this.idleTimers.set(tabId, t);
    }

    /** Cancel a scheduled idle detach (a new body transform came in). */
    cancelIdleDetach(tabId: number): void {
        const t = this.idleTimers.get(tabId);
        if (t) {
            clearTimeout(t);
            this.idleTimers.delete(tabId);
        }
    }

    /**
     * Pre-attach only when a script that plausibly needs the debugger
     * matches this url (not ones learned to be hook-only).
     */
    private shouldAttach(url: string): boolean {
        return this.cdpRelevantScripts(url).length > 0;
    }

    /** Wire up a tab when a CDP-strategy script matches it. Concurrent calls dedup. */
    async ensureAttached(tabId: number, mainFrameUrl: string | null): Promise<void> {
        if (!mainFrameUrl || this.attached.has(tabId)) return;
        if (!this.shouldAttach(mainFrameUrl)) return;
        const inFlight = this.attachInFlight.get(tabId);
        if (inFlight) return inFlight;
        const p = this.doEnsureAttached(tabId, mainFrameUrl).finally(() => this.attachInFlight.delete(tabId));
        this.attachInFlight.set(tabId, p);
        return p;
    }

    private async doEnsureAttached(tabId: number, mainFrameUrl: string): Promise<void> {
        dlog("cdp", "ensureAttached", { tabId, mainFrameUrl, scripts: this.scripts.map((s) => s.name) });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                try {
                    await debuggerAttach(tabId);
                } catch (e: any) {
                    // our own concurrent attach won the race — it enabled
                    // Fetch below and marked the tab attached
                    if (/already attached/i.test(e.message || "")) {
                        if (this.attached.has(tabId)) return;
                        throw e;
                    }
                    throw e;
                }
                try {
                    await debuggerSend(tabId, "Fetch.enable", {
                patterns: [{ requestStage: "Request" }, { requestStage: "Response" }],
            });
                } catch (e: any) {
                    // enable failed while attached (evicted mid-flight) —
                    // detach so we never leave an orphan debugger attached
                    await debuggerDetach(tabId).catch(() => {});
                    throw e;
                }
                this.attached.add(tabId);
                dlog("cdp", "attached + Fetch.enabled", { tabId, attempt });
                log(tabId, "[Tier C] debugger attached (CDP body interception active)", "warn");
                return;
            } catch (e: any) {
                dlog("cdp", `attach attempt ${attempt} failed`, { tabId, error: e.message || e });
                if (attempt === 1) {
                    dlog("cdp", "ATTACH FAILED", { tabId, error: e.message || e });
                    log(tabId, `[Tier C] debugger attach failed: ${e.message || e}`, "error");
                    return;
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
    }

    async handlePaused(tabId: number, params: any): Promise<void> {
        const { requestId, request } = params;
        const url: string = request.url;

        // ---- Request stage: async onRequest (redirect / cancel) ----
        if (!params.responseStatusCode) {
            if (this.isClaimed(url)) {
                await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
                return;
            }
            const requestScripts = this.matchingScripts(url).filter((s) => s.onRequest);
            if (requestScripts.length === 0) {
                await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
                return;
            }
            // stash async onResponseHeaders promises for the response stage
            const headerPromises: Promise<any>[] = [];
            for (const s of requestScripts) {
                try {
                    const result = s.onRequest!({ url, method: request.method, tabUrl: url, resourceType: params.resourceType || "other", requestHeaders: {} });
                    const resolved = isThenable(result) ? await result : result;
                    if (!resolved) continue;
                    if (resolved.cancel) {
                        dlog("cdp", "async onRequest → cancel", { url, script: s.name });
                        await debuggerSend(tabId, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                        return;
                    }
                    if (resolved.redirect) {
                        dlog("cdp", "async onRequest → redirect", { url, to: resolved.redirect, script: s.name });
                        await debuggerSend(tabId, "Fetch.continueRequest", { requestId, url: resolved.redirect });
                        return;
                    }
                    if (resolved.headers) headerPromises.push(Promise.resolve(resolved.headers));
                } catch (e: any) {
                    log(tabId, `[${s.name}] async onRequest threw: ${e.message || e}`, "error", s.scriptId);
                }
            }
            if (headerPromises.length) this.pendingAsyncHeaders.set(requestId, Promise.all(headerPromises));
            await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
            return;
        }

        // ---- Response stage ----
        const cdpScripts = this.matchingScripts(url);
        dlog("cdp", "handlePaused decision", { url, matching: cdpScripts.length, claimed: this.isClaimed(url), scripts: this.scripts.map((x) => `${x.name}=${x.match.join(",")}`) });
        const hasReplace = cdpScripts.some((s) => s.replaceResponse);
        if ((cdpScripts.length === 0 || this.isClaimed(url)) && !cdpScripts.some((s) => s.onResponseHeaders)) {
            // not ours, or the page hook already transformed it
            await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
            return;
        }

        try {
            // async response-header handlers + stashed request-stage headers
            let headerChanges: any[] = [];
            const pending = this.pendingAsyncHeaders.get(requestId);
            if (pending) {
                this.pendingAsyncHeaders.delete(requestId);
                headerChanges.push(...(await pending));
            }
            for (const s of cdpScripts) {
                if (!s.onResponseHeaders) continue;
                try {
                    const r = await s.onResponseHeaders({ url, method: request.method, tabUrl: url, resourceType: params.resourceType || "other", requestHeaders: {}, statusLine: "", responseHeaders: params.responseHeaders || [] });
                    if (r && r.headers) headerChanges.push(r.headers);
                } catch (e: any) {
                    log(tabId, `[${s.name}] async onResponseHeaders threw: ${e.message || e}`, "error", s.scriptId);
                }
            }
            let responseHeaders = params.responseHeaders;
            if (headerChanges.length) {
                responseHeaders = mergeHeaderChanges(params.responseHeaders || [], headerChanges);
            }

            const bodyResp: any = await debuggerSend(tabId, "Fetch.getResponseBody", { requestId });
            dlog("cdp", "got body", { url, base64: bodyResp.base64Encoded, len: bodyResp.body ? bodyResp.body.length : 0 });
            let bytes = bodyResp.base64Encoded ? base64ToBytes(bodyResp.body) : new TextEncoder().encode(bodyResp.body);
            // textual bodies are handed to transforms as strings — most
            // transforms are string-oriented; binary stays bytes
            let body: string | Uint8Array = looksTextual(bytes) ? new TextDecoder().decode(bytes) : bytes;

            // async replaceResponse: first non-null result fulfills the body
            for (const s of cdpScripts) {
                if (!s.replaceResponse) continue;
                try {
                    const out = await s.replaceResponse({ url, method: request.method, tabUrl: url, resourceType: params.resourceType || "other", requestHeaders: {}, status: params.responseStatusCode, contentType: headerContentType(responseHeaders) });
                    if (out !== undefined && out !== null) {
                        body = typeof out === "string" || out instanceof Uint8Array ? out : JSON.stringify(out);
                        dlog("cdp", `replaceResponse ${s.name} applied`, { outLen: typeof body === "string" ? body.length : body.length });
                        break;
                    }
                } catch (e: any) {
                    dlog("cdp", `replaceResponse ${s.name} THREW: ${e.message || e}`);
                    log(tabId, `[${s.name}] async replaceResponse threw: ${e.message || e}`, "error", s.scriptId);
                }
            }

            const headers: { [n: string]: string } = {};
            for (const h of params.responseHeaders || []) {
                headers[h.name.toLowerCase()] = h.value || "";
            }

            for (const s of cdpScripts) {
                const ctx = {
                    url,
                    method: request.method,
                    tabUrl: url,
                    resourceType: params.resourceType || "main_frame",
                    requestHeaders: {},
                    status: params.responseStatusCode,
                    contentType: headers["content-type"],
                };
                try {
                    const out = await s.transform(ctx, body);
                    if (out !== undefined && out !== null) body = out;
                    const before = typeof body === "string" ? body.length : body.length;
                    dlog("cdp", `transform ${s.name} applied`, { outLen: before });
                } catch (e: any) {
                    dlog("cdp", `transform ${s.name} THREW: ${e.message || e}`);
                    log(tabId, `[${s.name}] modifyResponse (cdp) threw: ${e.message || e}`, "error", s.scriptId);
                }
            }

            const outBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
            dlog("cdp", "fulfilling", { url, outLen: outBytes.length });
            await debuggerSend(tabId, "Fetch.fulfillRequest", {
                requestId,
                responseCode: params.responseStatusCode,
                responseHeaders,
                body: bytesToBase64(outBytes),
            });
        } catch (e: any) {
            log(tabId, `[Tier C] body interception failed: ${e.message || e}`, "error");
            try {
                await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
            } catch {
                /* detach race */
            }
        }
    }

    async handleDetach(tabId: number): Promise<void> {
        this.attached.delete(tabId);
    }

    async detach(tabId: number): Promise<void> {
        if (this.attached.has(tabId)) {
            this.attached.delete(tabId);
            try {
                await chrome.debugger.detach({ tabId });
            } catch {
                /* already gone */
            }
        }
    }
}

function headerContentType(headers: { name: string; value?: string }[]): string | undefined {
    const h = headers.find((x) => x.name.toLowerCase() === "content-type");
    return h?.value;
}

function mergeHeaderChanges(
    headers: { name: string; value?: string }[],
    changes: any[]
): { name: string; value?: string }[] {
    const removeSet = new Set<string>();
    const setMap = new Map<string, { name: string; value: string }>();
    for (const c of changes) {
        for (const [n, v] of Object.entries(c.set || {})) setMap.set(n.toLowerCase(), { name: n, value: String(v) });
        for (const n of c.remove || []) removeSet.add(n.toLowerCase());
    }
    const out: { name: string; value?: string }[] = [];
    for (const h of headers) {
        const lower = h.name.toLowerCase();
        if (removeSet.has(lower) || setMap.has(lower)) {
            const repl = setMap.get(lower);
            if (repl) out.push({ name: h.name, value: repl.value });
            setMap.delete(lower);
            continue;
        }
        out.push(h);
    }
    for (const repl of setMap.values()) out.push(repl);
    return out;
}

function looksTextual(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 512);
    for (let i = 0; i < n; i++) {
        if (bytes[i] === 0) return false;
    }
    return true;
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
