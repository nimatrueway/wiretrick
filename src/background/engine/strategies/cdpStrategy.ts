/**
 * Tier C: chrome.debugger + CDP Fetch domain. Opt-in per script
 * (declareScript strategy: ["cdp"]) — used for main-frame HTML transforms and anything the
 * hook/proxy tiers cannot see. Attaches lazily, only while body-modifying
 * requests are in flight for a matching script.
 */
import { matchAny } from "../../../shared/matcher";
import { parseStrategyList } from "../../../shared/metaParser";
import { compileScript, makeScriptOverrides, makeModuleResolver, isThenable, isAsyncFn, type HandlerFn } from "../../../shared/compile";
import { storageGet, storageSet } from "../../../shared/chromeApi";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { dlogLevel } from "../../../shared/debugLog";
import { debuggerAttach, debuggerSend, debuggerDetach, debuggerGetTargets, type Debuggee } from "../../../shared/chromeApi";

interface CdpScript {
    scriptId: string;
    name: string;
    match: string[];
    /** the script's raw strategy list (comma-separated) */
    strategyRaw: string;
    /** async modifyResponse transforms (compose in order) */
    transform: HandlerFn[];
    /** async onRequest handlers (first terminal result wins at Request stage) */
    onRequest?: HandlerFn[];
    /** async onResponseHeaders handlers (merged at Response stage) */
    onResponseHeaders?: HandlerFn[];
    /** async replaceResponse handlers (first non-null fulfills the body) */
    replaceResponse?: HandlerFn[];
}

/**
 * Tier C participation rule: the debugger PRE-ATTACHES only for scripts
 * whose strategy list explicitly contains "cdp" (or the single default
 * "auto"). ALL body scripts are still LOADED into this strategy — when the
 * hook tier is unavailable (page CSP blocked it, cold start), an explicit
 * needsCdp dispatch from the pipeline may route their transforms here.
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
    /** attached sessions, keyed "tab:<id>" or "tgt:<targetId>" */
    private attached = new Set<string>();
    private scripts: CdpScript[] = [];
    /** scriptId → resource types it has matched (banner-minimization learning) */
    private learn: { [scriptId: string]: { [type: string]: number } } = {};
    /** tabId → timer for idle auto-detach */
    private idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
    /** tabId → in-flight ensureAttached promise (dedup concurrent calls) */
    private attachInFlight = new Map<number, Promise<void>>();
    /** requestId → stashed async request-header changes from onRequest */
    private pendingAsyncHeaders = new Map<string, Promise<any[]>>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        // module registry: scripts import each other by name ("./utils")
        let resolveSpec: (spec: string) => any = (spec) => {
            throw new Error(`cannot import "${spec}" before the module registry is ready`);
        };
        const overridesFor = (s: { id: string; name: string; code: string }) =>
            makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, msg) => log(-1, `[${s.name}] res.log: ${msg}`, "info", id), (id, level, msg) => log(-1, `[${s.name}] console.log: ${msg}`, level, id), paramValues?.[s.id], (spec) => resolveSpec(spec));
        resolveSpec = makeModuleResolver(
            scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
            overridesFor
        ).resolve;
        this.scripts = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            const c = compileScript(s.code, overridesFor({ id: s.id, name: s.meta.name, code: s.code }));
            if (!c.meta.declared) continue; // library module: inert, importable
            // CDP is the fallback tier for everything the hook cannot do
            // (main frames, script tags, worker fetches, cold starts) — any
            // handler loads here, sync or async. Sync onRequest handlers
            // matter for respond-with-status at the Request stage.
            const wantsCdp =
                c.handlers.modifyResponse.length > 0 ||
                c.handlers.replaceResponse.length > 0 ||
                c.handlers.onRequest.length > 0 ||
                c.handlers.onResponseHeaders.length > 0;
            if (!wantsCdp) continue;
            this.scripts.push({
                scriptId: s.id,
                name: s.meta.name,
                match: s.meta.match,
                strategyRaw: s.meta.strategy,
                transform: c.handlers.modifyResponse,
                onRequest: c.handlers.onRequest.some(isAsyncFn) ? c.handlers.onRequest : undefined,
                onResponseHeaders: c.handlers.onResponseHeaders.some(isAsyncFn) ? c.handlers.onResponseHeaders : undefined,
                replaceResponse: c.handlers.replaceResponse.some(isAsyncFn) ? c.handlers.replaceResponse : undefined,
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
    /** Scripts that justify a PRE-ATTACH: cdp-listed and not hook-learned. */
    cdpRelevantScripts(url: string): CdpScript[] {
        return this.matchingScripts(url).filter((s) => usesCdp(s.strategyRaw) && !this.isXhrOnly(s.scriptId));
    }

    /** True when any script matching the url has cdp in its strategy list. */
    hasCdpListedScripts(url: string): boolean {
        return this.matchingScripts(url).some((s) => usesCdp(s.strategyRaw));
    }

    /** Forget per-tab state on tab close. */
    forgetTab(tabId: number): void {
        const key = `tab:${tabId}`;
        const t = this.idleTimers.get(key as any);
        if (t) clearTimeout(t);
        this.idleTimers.delete(key as any);
        this.attached.delete(key);
    }

    private keyOf(d: Debuggee): string {
        return "tabId" in d ? `tab:${d.tabId}` : `tgt:${d.targetId}`;
    }

    private debuggeeOf(key: string): Debuggee {
        return key.startsWith("tab:") ? { tabId: Number(key.slice(4)) } : { targetId: key.slice(4) };
    }

    private async detachByKey(key: string): Promise<void> {
        this.attached.delete(key);
        try {
            if (key.startsWith("tab:")) await debuggerDetach({ tabId: Number(key.slice(4)) });
            else await debuggerDetach({ targetId: key.slice(4) });
        } catch {}
    }

    /**
     * Worker/service-worker initiated requests (tabId −1): the hook can
     * never see them, so CDP attaches to the WORKER targets whose origin
     * matches — the only status-honoring respond path for those.
     */
    async ensureWorkerAttached(url: string): Promise<void> {
        let origin = "";
        try { origin = new URL(url).origin; } catch { return; }
        // workers spawn during page load — sweep a few times so they get
        // attached as they appear
        for (let round = 0; round < 5; round++) {
            const targets = await debuggerGetTargets();
            let pending = 0;
            for (const t of targets) {
                if (!t.url.startsWith(origin)) continue;
                const key = `tgt:${t.targetId}`;
                if (this.attached.has(key)) continue;
                pending++;
                try {
                    await debuggerAttach({ targetId: t.targetId });
                    await debuggerSend({ targetId: t.targetId }, "Fetch.enable", {
                        patterns: [{ requestStage: "Request" }, { requestStage: "Response" }],
                    });
                    this.attached.add(key);
                    dlogLevel("cdp", "info", "worker target attached", { url: t.url.slice(0, 80) });
                } catch (e: any) {
                    dlogLevel("cdp", "warn", "worker attach failed", { target: t.url.slice(0, 60), error: e.message || e });
                }
            }
            if (pending === 0) break;
            await new Promise((r) => setTimeout(r, 400));
        }
    }

    /** Detach when the page settled — the banner disappears while the user browses. */
    scheduleIdleDetach(key: string, graceMs = 8000): void {
        const prev = this.idleTimers.get(key as any);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
            this.idleTimers.delete(key as any);
            if (this.attached.has(key)) {
                void this.detachByKey(key);
                dlogLevel("cdp", "debug", "idle detach (banner cleared)", { key });
            }
        }, graceMs);
        this.idleTimers.set(key as any, t);
    }

    /** Cancel a scheduled idle detach (a new body transform came in). */
    cancelIdleDetach(key: string): void {
        const t = this.idleTimers.get(key as any);
        if (t) {
            clearTimeout(t);
            this.idleTimers.delete(key as any);
        }
    }

    /**
     * Pre-attach only when a script that plausibly needs the debugger
     * matches this url (not ones learned to be hook-only).
     */
    private shouldAttach(url: string): boolean {
        return this.cdpRelevantScripts(url).length > 0;
    }

    /**
     * FORCED attach: the pipeline explicitly routed a request here
     * (needsCdp — e.g. a respond-with-status the hook cannot serve), so
     * the strategy-list gate does not apply.
     */
    async ensureAttachedForced(tabId: number, mainFrameUrl: string | null): Promise<void> {
        const key = `tab:${tabId}`;
        if (!mainFrameUrl || this.attached.has(key)) return;
        const inFlight = this.attachInFlight.get(key as any);
        if (inFlight) return inFlight;
        const p = this.doEnsureAttached(tabId, mainFrameUrl).finally(() => this.attachInFlight.delete(key as any));
        this.attachInFlight.set(key as any, p);
        return p;
    }

    /** Wire up a tab when a CDP-strategy script matches it. Concurrent calls dedup. */
    async ensureAttached(tabId: number, mainFrameUrl: string | null): Promise<void> {
        const key = `tab:${tabId}`;
        if (!mainFrameUrl || this.attached.has(key)) return;
        if (!this.shouldAttach(mainFrameUrl)) return;
        const inFlight = this.attachInFlight.get(key as any);
        if (inFlight) return inFlight;
        const p = this.doEnsureAttached(tabId, mainFrameUrl).finally(() => this.attachInFlight.delete(key as any));
        this.attachInFlight.set(tabId, p);
        return p;
    }

    private async doEnsureAttached(tabId: number, mainFrameUrl: string): Promise<void> {
        const key = `tab:${tabId}`;
        dlogLevel("cdp", "debug", "ensureAttached", { tabId, mainFrameUrl, scripts: this.scripts.map((s) => s.name) });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                try {
                    await debuggerAttach({ tabId });
                } catch (e: any) {
                    if (/already attached/i.test(e.message || "") && this.attached.has(key)) return;
                    throw e;
                }
                try {
                    await debuggerSend(this.debuggeeOf(key), "Fetch.enable", {
                        patterns: [{ requestStage: "Request" }, { requestStage: "Response" }],
                    });
                } catch (e: any) {
                    // enable failed while attached (evicted mid-flight) —
                    // detach so we never leave an orphan debugger attached
                    await debuggerDetach({ tabId }).catch(() => {});
                    throw e;
                }
                this.attached.add(key);
                dlogLevel("cdp", "info", "attached + Fetch.enabled", { tabId, attempt });
                log(tabId, "[Tier C] debugger attached (CDP body interception active)", "warn");
                return;
            } catch (e: any) {
                dlogLevel("cdp", "warn", `attach attempt ${attempt} failed`, { tabId, error: e.message || e });
                if (attempt === 1) {
                    dlogLevel("cdp", "error", "ATTACH FAILED", { tabId, error: e.message || e });
                    log(tabId, `[Tier C] debugger attach failed: ${e.message || e}`, "error");
                    return;
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
    }

    async handlePaused(key: string, params: any): Promise<void> {
        const tabId: number = key.startsWith("tab:") ? Number(key.slice(4)) : -1;
        const { requestId, request } = params;
        const url: string = request.url;

        // ---- Request stage: async onRequest (redirect / cancel) ----
        if (!params.responseStatusCode) {
            if (this.isClaimed(url)) {
                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
                return;
            }
            const requestScripts = this.matchingScripts(url).filter((s) => s.onRequest);
            if (requestScripts.length === 0) {
                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
                return;
            }
            // run every matching script's onRequest handlers in order;
            // the first TERMINAL result (respond/cancel/redirect) wins and
            // stops the chain — non-terminal headers accumulate
            const headerPromises: Promise<any>[] = [];
            let terminal = false;
            for (const s of requestScripts) {
                for (const handler of s.onRequest!) {
                    let resolved: any;
                    try {
                        const result = handler({ url, method: request.method, tabUrl: url, resourceType: params.resourceType || "other", requestHeaders: {} });
                        resolved = isThenable(result) ? await result : result;
                    } catch (e: any) {
                        log(tabId, `[${s.name}] async onRequest threw: ${e.message || e}`, "error", s.scriptId);
                        continue;
                    }
                    if (!resolved) continue;

                    if (resolved.respond) {
                        // synthesize the response at the Request stage —
                        // the network is never contacted
                        const r = resolved.respond;
                        const body = typeof r.body === "string"
                            ? bytesToBase64(new TextEncoder().encode(r.body))
                            : r.body instanceof Uint8Array
                                ? bytesToBase64(r.body)
                                : bytesToBase64(new TextEncoder().encode(JSON.stringify(r.body)));
                        const headers = [
                            { name: "content-type", value: r.mime || "application/json" },
                            ...Object.entries(r.headers?.set || {}).map(([name, value]) => ({ name, value: String(value) })),
                        ];
                        dlogLevel("cdp", "info", "async onRequest → respond", { url, script: s.name });
                        log(tabId, `[${s.name}] onRequest → respond ${r.status || 200} ${r.mime || "application/json"} (debugger tier) ${url}`, "info", s.scriptId);
                        await debuggerSend(this.debuggeeOf(key), "Fetch.fulfillRequest", {
                            requestId,
                            responseCode: r.status || 200,
                            responseHeaders: headers,
                            body,
                        });
                        return;
                    }
                    if (resolved.cancel) {
                        dlogLevel("cdp", "info", "async onRequest → cancel", { url, script: s.name });
                        log(tabId, `[${s.name}] onRequest → cancel ${url}`, "info", s.scriptId);
                        await debuggerSend(this.debuggeeOf(key), "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                        return;
                    }
                    if (resolved.redirect) {
                        dlogLevel("cdp", "info", "async onRequest → redirect", { url, to: resolved.redirect, script: s.name });
                        log(tabId, `[${s.name}] onRequest → redirect → ${resolved.redirect} ${url}`, "info", s.scriptId);
                        await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId, url: resolved.redirect });
                        return;
                    }
                    if (resolved.headers && (resolved.headers.set || resolved.headers.remove)) {
                        headerPromises.push(Promise.resolve(resolved.headers));
                    }
                }
                void terminal;
            }
            if (headerPromises.length) this.pendingAsyncHeaders.set(requestId, Promise.all(headerPromises));
            await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
            return;
        }

        // ---- Response stage ----
        const cdpScripts = this.matchingScripts(url);
        dlogLevel("cdp", "debug", "handlePaused decision", { url, matching: cdpScripts.length, claimed: this.isClaimed(url), scripts: this.scripts.map((x) => `${x.name}=${x.match.join(",")}`) });
        const hasReplace = cdpScripts.some((s) => s.replaceResponse);
        if ((cdpScripts.length === 0 || this.isClaimed(url)) && !cdpScripts.some((s) => s.onResponseHeaders)) {
            // not ours, or the page hook already transformed it
            await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
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
                for (const handler of s.onResponseHeaders) {
                    try {
                        const r = await handler({ url, method: request.method, tabUrl: url, resourceType: params.resourceType || "other", requestHeaders: {}, statusLine: "", responseHeaders: params.responseHeaders || [] });
                        if (r && r.headers) headerChanges.push(r.headers);
                    } catch (e: any) {
                        log(tabId, `[${s.name}] async onResponseHeaders threw: ${e.message || e}`, "error", s.scriptId);
                    }
                }
            }
            let responseHeaders = params.responseHeaders;
            if (headerChanges.length) {
                responseHeaders = mergeHeaderChanges(params.responseHeaders || [], headerChanges);
            }

            const bodyResp: any = await debuggerSend(this.debuggeeOf(key), "Fetch.getResponseBody", { requestId });
            dlogLevel("cdp", "debug", "got body", { url, base64: bodyResp.base64Encoded, len: bodyResp.body ? bodyResp.body.length : 0 });
            let bytes = bodyResp.base64Encoded ? base64ToBytes(bodyResp.body) : new TextEncoder().encode(bodyResp.body);
            // textual bodies are handed to transforms as strings — most
            // transforms are string-oriented; binary stays bytes
            let body: string | Uint8Array = looksTextual(bytes) ? new TextDecoder().decode(bytes) : bytes;

            // async replaceResponse: first non-null result fulfills the body
            replaceOuter: for (const s of cdpScripts) {
                if (!s.replaceResponse) continue;
                for (const handler of s.replaceResponse) {
                    try {
                        const out = await handler({ url, method: request.method, tabUrl: url, resourceType: params.resourceType || "other", requestHeaders: {}, status: params.responseStatusCode, contentType: headerContentType(responseHeaders) });
                        if (out !== undefined && out !== null) {
                            body = typeof out === "string" || out instanceof Uint8Array ? out : JSON.stringify(out);
                            const outLen = typeof body === "string" ? body.length : body.byteLength;
                            dlogLevel("cdp", "info", `replaceResponse ${s.name} applied`, { outLen });
                            log(tabId, `[${s.name}] replaceResponse → (${outLen}b) ${url}`, "info", s.scriptId);
                            break replaceOuter;
                        }
                    } catch (e: any) {
                        dlogLevel("cdp", "error", `replaceResponse ${s.name} THREW: ${e.message || e}`);
                        log(tabId, `[${s.name}] async replaceResponse threw: ${e.message || e}`, "error", s.scriptId);
                    }
                }
            }
            const headers: { [n: string]: string } = {};
            for (const h of params.responseHeaders || []) {
                headers[h.name.toLowerCase()] = h.value || "";
            }

            for (const s of cdpScripts) {
                if (!s.transform) continue;
                const ctx = {
                    url,
                    method: request.method,
                    tabUrl: url,
                    resourceType: params.resourceType || "main_frame",
                    requestHeaders: {},
                    status: params.responseStatusCode,
                    contentType: headers["content-type"],
                };
                for (const handler of s.transform) {
                    try {
                        const before = typeof body === "string" ? body.length : body.byteLength;
                        const prevBody = body;
                        const out = await handler(ctx, body);
                        if (out !== undefined && out !== null) {
                            body = out;
                            const len = typeof body === "string" ? body.length : body.byteLength;
                            dlogLevel("cdp", "info", `transform ${s.name} applied`, { outLen: len });
                            // unchanged output = do-nothing, don't log it
                            if (out !== prevBody) {
                                log(tabId, `[${s.name}] modifyResponse applied (${before}b → ${len}b) ${url}`, "info", s.scriptId);
                            }
                        }
                    } catch (e: any) {
                        dlogLevel("cdp", "error", `transform ${s.name} THREW: ${e.message || e}`);
                        log(tabId, `[${s.name}] modifyResponse (cdp) threw: ${e.message || e}`, "error", s.scriptId);
                    }
                }
            }

            const outBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
            dlogLevel("cdp", "debug", "fulfilling", { url, outLen: outBytes.length });
            await debuggerSend(this.debuggeeOf(key), "Fetch.fulfillRequest", {
                requestId,
                responseCode: params.responseStatusCode,
                responseHeaders,
                body: bytesToBase64(outBytes),
            });
        } catch (e: any) {
            log(tabId, `[Tier C] body interception failed: ${e.message || e}`, "error");
            try {
                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
            } catch {
                /* detach race */
            }
        }
    }

    async handleDetach(key: string): Promise<void> {
        this.attached.delete(key);
    }

    async detach(tabId: number): Promise<void> {
        const key = `tab:${tabId}`;
        if (this.attached.has(key)) {
            this.attached.delete(key);
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
