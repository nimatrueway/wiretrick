/**
 * Tier C: chrome.debugger + CDP Fetch domain. Opt-in per script
 * (declareScript strategy: ["cdp"]) — used for main-frame HTML transforms and anything the
 * hook tier cannot see. Attaches lazily, only while body-modifying
 * requests are in flight for a matching script.
 */
import { matchAny } from "../../../shared/matcher";
import { parseStrategyList } from "../../../shared/metaParser";
import { compileScript, makeScriptOverrides, makeModuleResolver, isThenable, isAsyncFn, type HandlerFn } from "../../../shared/compile";
import { scriptLogLine } from "../../../shared/scriptLog";
import { formatScriptError } from "../../../shared/scriptError";
import { storageGet, storageSet } from "../../../shared/chromeApi";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { dlog, dlogLevel } from "../../../shared/debugLog";
import { debuggerAttach, debuggerSend, debuggerDetach, debuggerGetTargets, type Debuggee } from "../../../shared/chromeApi";
import { analyzeScripts, runBodyOp } from "../../compileHost";
import { recordNetBody } from "../../network";
import { isProcessOwned, listsProcess } from "./processState";

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

/**
 * MV3 participation: explicit opt-in only ("cdp"). "auto"/"hook" scripts
 * stay banner-free on the hook tier.
 */
function usesDebuggerMv3(strategyRaw: string): boolean {
    const list = parseStrategyList(strategyRaw);
    return list.includes("cdp");
}

/**
 * MV3 pauses only what the hook tier cannot see: page fetch/XHR stay on
 * the hook (pausing them too would run transforms twice).
 */
const MV3_CDP_TYPES = ["Document", "Script", "Stylesheet", "Image", "Media", "Font", "Other"];
const MV3_PAGE_FETCH_TYPES = ["XHR", "Fetch"];

/** CDP resource type → webRequest-style name handlers see as ctx.resourceType */
function webRequestTypeOf(cdpType: string | undefined): string {
    const m: Record<string, string> = {
        Document: "main_frame", Script: "script", Stylesheet: "stylesheet", Image: "image", Media: "media",
        Font: "font", XHR: "xmlhttprequest", Fetch: "xmlhttprequest", WebSocket: "websocket", Ping: "ping",
    };
    return (cdpType && m[cdpType]) || "other";
}

interface Mv3Plain {
    id: string;
    name: string;
    code: string;
    updatedAt: number;
    enabled: boolean;
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
    /** MV3: every script (libraries included — imports resolve in the sandbox) */
    private mv3Plain: Mv3Plain[] = [];
    private mv3Params: { [scriptId: string]: Record<string, any> } = {};
    /** MV3: Fetch.enable patterns derived from the participating scripts */
    private mv3Patterns: { urlPattern: string; resourceType: string; requestStage: "Request" | "Response" }[] = [];
    /** MV3: resolves once the current script set is analyzed (a cold SW must not miss a navigation) */
    private ready: Promise<void> = Promise.resolve();
    private mv3Summary = "";
    /** MV3: "<tabId>|<url>" of recently paused loads (race-warning bookkeeping) */
    private recentlyPaused = new Set<string>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        if (__MV3__) {
            this.ready = this.reloadMv3(scripts, paramValues || {}).catch((e: any) => {
                dlogLevel("cdp", "error", `MV3 debugger tier reload failed: ${e?.message || e}`);
            });
            return;
        }
        // module registry: scripts import each other by name ("./utils")
        let resolveSpec: (spec: string) => any = (spec) => {
            throw new Error(`cannot import "${spec}" before the module registry is ready`);
        };
        const overridesFor = (s: { id: string; name: string; code: string }) =>
            makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, level, source, text) => log(-1, scriptLogLine(s.name, source, text), level, id), paramValues?.[s.id], (spec) => resolveSpec(spec));
        resolveSpec = makeModuleResolver(
            scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
            overridesFor
        ).resolve;
        this.scripts = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            const c = compileScript(s.code, overridesFor({ id: s.id, name: s.meta.name, code: s.code }));
            if (!c.meta.declared) continue; // library module: inert, importable
            if (isProcessOwned(s.meta.strategy)) continue; // the helper tier owns it
            // CDP is the fallback tier for everything the hook cannot do
            // (main frames, script tags, worker fetches, cold starts) — any
            // handler loads here, sync or async. Sync onRequest handlers
            // matter for respond-with-status at the Request stage: the
            // blocking webRequest tier applies their other results itself
            // and defers ONLY non-200 responds here (handlePaused skips
            // re-applying anything else a sync handler produced).
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
                onRequest: c.handlers.onRequest.length ? c.handlers.onRequest : undefined,
                onResponseHeaders: c.handlers.onResponseHeaders.some(isAsyncFn) ? c.handlers.onResponseHeaders : undefined,
                replaceResponse: c.handlers.replaceResponse.some(isAsyncFn) ? c.handlers.replaceResponse : undefined,
            });
        }
    }

    /**
     * MV3: handlers execute in the sandbox (runBodyOp — the only
     * eval-permitted context); this tier only pauses requests via CDP and
     * relays decisions. CdpScript entries carry empty marker handler lists.
     */
    private async reloadMv3(scripts: Script[], paramValues: { [scriptId: string]: Record<string, any> }): Promise<void> {
        this.mv3Plain = scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: s.enabled }));
        this.mv3Params = paramValues;
        const enabled = scripts.filter((s) => s.enabled && s.meta.declared);
        const analyzed = enabled.length ? await analyzeScripts(scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt }))) : new Map();
        const next: CdpScript[] = [];
        const patterns = new Map<string, { urlPattern: string; resourceType: string; requestStage: "Request" | "Response" }>();
        const autoBody: string[] = [];
        for (const s of enabled) {
            const a = analyzed.get(s.id);
            const h = a?.handlers ?? { onRequest: 1, modifyResponse: 1, replaceResponse: 1, onResponseHeaders: 1 };
            const wantsRequest = h.onRequest > 0;
            const wantsBody = h.modifyResponse > 0 || h.replaceResponse > 0;
            const wantsHeaders = h.onResponseHeaders > 0;
            const wantsResponse = wantsBody || wantsHeaders;
            if (!wantsRequest && !wantsResponse) continue;
            if (isProcessOwned(s.meta.strategy)) continue; // the helper tier owns it
            if (!usesDebuggerMv3(s.meta.strategy)) {
                // process-listed scripts: the helper tier reports its own state
                // (and isn't connected yet during startup reloads)
                if (!listsProcess(s.meta.strategy)) autoBody.push(s.meta.name);
                continue;
            }
            next.push({
                scriptId: s.id,
                name: s.meta.name,
                match: s.meta.match,
                strategyRaw: s.meta.strategy,
                transform: [],
                onRequest: wantsRequest ? [] : undefined,
                replaceResponse: wantsBody ? [] : undefined,
                onResponseHeaders: wantsHeaders ? [] : undefined,
            });
            for (const m of s.meta.match) {
                // match patterns are valid CDP globs ('*' wildcard); the handler re-filters exactly
                const urlPattern = m === "<all_urls>" ? "*" : m;
                for (const resourceType of MV3_CDP_TYPES) {
                    if (wantsRequest) patterns.set(`${urlPattern}|${resourceType}|Request`, { urlPattern, resourceType, requestStage: "Request" });
                    if (wantsResponse) patterns.set(`${urlPattern}|${resourceType}|Response`, { urlPattern, resourceType, requestStage: "Response" });
                }
                // page fetch/XHR bodies belong to the hook, but response headers
                // (CORS, CSP…) are enforced before the page sees them
                if (wantsHeaders) {
                    for (const resourceType of MV3_PAGE_FETCH_TYPES) {
                        patterns.set(`${urlPattern}|${resourceType}|Response`, { urlPattern, resourceType, requestStage: "Response" });
                    }
                }
            }
        }
        this.scripts = next;
        this.mv3Patterns = [...patterns.values()];
        // announce only when the participating set changes (reloads are frequent)
        const summary = JSON.stringify([next.map((s) => s.name), autoBody]);
        const changed = summary !== this.mv3Summary;
        this.mv3Summary = summary;
        if (changed && next.length) {
            log(-1, `[cdp] MV3 debugger tier active for ${next.map((s) => `"${s.name}"`).join(", ")} — <script>/<img>/css/document loads are intercepted via chrome.debugger (Chrome shows a "started debugging this browser" banner while attached)`, "info");
        }
        if (changed && autoBody.length) {
            log(-1, `MV3: ${autoBody.map((n) => `"${n}"`).join(", ")} intercept page fetch/XHR only (hook tier). To also intercept <script>/<img>/css/document loads, add "cdp" to the script's strategy list (e.g. strategy: ["hook", "cdp"])`, "warn");
        }
        dlog("cdp", "MV3 debugger tier reloaded", { scripts: next.map((s) => s.name), patterns: this.mv3Patterns.length });
        await this.resyncAttachedMv3();
    }

    /** MV3: re-apply patterns to attached tabs and attach to already-open matching tabs. */
    private async resyncAttachedMv3(): Promise<void> {
        for (const key of [...this.attached]) {
            if (!key.startsWith("tab:")) continue;
            const tabId = Number(key.slice(4));
            let url: string | undefined;
            try { url = (await chrome.tabs.get(tabId))?.url; } catch { /* tab gone */ }
            if (!url || !this.shouldAttach(url) || !this.mv3Patterns.length) {
                await this.detachByKey(key);
                continue;
            }
            try {
                await debuggerSend({ tabId }, "Fetch.enable", { patterns: this.mv3Patterns });
            } catch (e: any) {
                dlogLevel("cdp", "warn", "Fetch.enable refresh failed", { tabId, error: e?.message || e });
            }
        }
        if (!this.scripts.length) return;
        try {
            for (const t of await chrome.tabs.query({})) {
                if (t.id !== undefined && t.url) await this.syncTabNow(t.id, t.url);
            }
        } catch {}
    }

    /**
     * MV3 tab lifecycle: attach while the tab's page matches a participating
     * script (kept attached — lazily loaded chunks arrive long after load,
     * so the MV2 idle-detach would miss them); detach once it navigates away.
     */
    async syncTab(tabId: number, url: string): Promise<void> {
        await this.ready;
        await this.syncTabNow(tabId, url);
    }

    /** syncTab without the ready gate (called from inside reloadMv3 itself) */
    private async syncTabNow(tabId: number, url: string): Promise<void> {
        const key = `tab:${tabId}`;
        if (this.shouldAttach(url)) {
            await this.ensureAttached(tabId, url);
        } else if (this.attached.has(key)) {
            dlogLevel("cdp", "debug", "tab left matching pages → detach", { tabId, url });
            await this.detachByKey(key);
        }
    }

    /** MV3: is this tab's debugger session live (Fetch enabled)? */
    isTabAttached(tabId: number): boolean {
        return this.attached.has(`tab:${tabId}`);
    }

    /** restart a navigation on an attached tab so it passes through Fetch */
    async renavigate(tabId: number, url: string): Promise<boolean> {
        if (!this.attached.has(`tab:${tabId}`)) return false;
        try {
            await debuggerSend({ tabId }, "Page.navigate", { url });
            return true;
        } catch (e: any) {
            dlogLevel("cdp", "warn", "re-navigation failed", { tabId, url, error: e?.message || e });
            return false;
        }
    }

    /** did a load of url on tabId reach the debugger recently? */
    wasPaused(tabId: number, url: string): boolean {
        return this.recentlyPaused.has(`${tabId}|${url}`);
    }

    /**
     * Names of scripts that needed the debugger for a resource url. MV2:
     * only cdp-listed ones with async/body handlers — sync onRequest work is
     * already done by blocking webRequest without the debugger.
     */
    debuggerScriptsFor(url: string): string[] {
        if (__MV3__) return this.matchingScripts(url).map((s) => s.name);
        return this.cdpRelevantScripts(url)
            .filter((s) => s.transform.length || s.replaceResponse?.length || s.onResponseHeaders?.length || s.onRequest?.length)
            .map((s) => s.name);
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
        if (__MV3__) return this.matchingScripts(url);
        return this.matchingScripts(url).filter((s) => usesCdp(s.strategyRaw) && !this.isXhrOnly(s.scriptId));
    }

    /** True when any script matching the url has cdp in its strategy list. */
    hasCdpListedScripts(url: string): boolean {
        if (__MV3__) return this.matchingScripts(url).length > 0;
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
        // MV3 keeps the tab attached while it matches (see syncTab)
        if (__MV3__) return;
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
        // MV3: the RESOURCE (e.g. a CDN script) rarely matches the PAGE url —
        // attach to any web tab while debugger-tier scripts exist; the
        // Fetch.enable url patterns keep non-matching loads un-paused
        if (__MV3__) return this.scripts.length > 0 && this.mv3Patterns.length > 0 && /^(https?|file):/i.test(url);
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
                        patterns: __MV3__ ? this.mv3Patterns : [{ requestStage: "Request" }, { requestStage: "Response" }],
                    });
                } catch (e: any) {
                    // enable failed while attached (evicted mid-flight) —
                    // detach so we never leave an orphan debugger attached
                    await debuggerDetach({ tabId }).catch(() => {});
                    throw e;
                }
                this.attached.add(key);
                dlogLevel("cdp", "info", "attached + Fetch.enabled", { tabId, attempt });
                log(tabId, "[cdp] debugger attached — body interception active in this tab", "info");
                return;
            } catch (e: any) {
                dlogLevel("cdp", "warn", `attach attempt ${attempt} failed`, { tabId, error: e.message || e });
                if (attempt === 1) {
                    dlogLevel("cdp", "error", "debugger attach failed after all retries", { tabId, error: e.message || e });
                    log(tabId, `[cdp] debugger attach failed: ${e.message || e}`, "error");
                    return;
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
    }

    async handlePaused(key: string, params: any): Promise<void> {
        const pausedKey = `${key.startsWith("tab:") ? Number(key.slice(4)) : -1}|${params.request?.url}`;
        this.recentlyPaused.add(pausedKey);
        setTimeout(() => this.recentlyPaused.delete(pausedKey), 120000);
        if (__MV3__) return this.handlePausedMv3(key, params);
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
                        log(tabId, formatScriptError(s.name, e, "onRequest"), "error", s.scriptId);
                        continue;
                    }
                    if (!resolved) continue;

                    // Sync handlers already ran in the blocking webRequest
                    // tier, which applies everything they return EXCEPT a
                    // non-200 respond (data-URL redirects can't carry a
                    // status — that one case was deferred here). Skip
                    // anything else a sync handler produced so redirect /
                    // cancel / headers / 200-respond are never applied twice.
                    if (!isAsyncFn(handler)) {
                        const r = resolved.respond;
                        if (!r || r.status === undefined || r.status === 200) continue;
                    }

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
                        dlogLevel("cdp", "info", "onRequest → respond", { url, script: s.name });
                        try {
                            await debuggerSend(this.debuggeeOf(key), "Fetch.fulfillRequest", {
                                requestId,
                                responseCode: r.status || 200,
                                responseHeaders: headers,
                                body,
                            });
                            log(tabId, `[${s.name}] onRequest → respond ${r.status || 200} ${r.mime || "application/json"} (debugger tier) ${url}`, "info", s.scriptId);
                            recordNetBody({ tabId, url, method: request.method, modified: base64ToBytes(body), mime: r.mime || "application/json", status: r.status || 200 });
                        } catch (e: any) {
                            log(tabId, `[${s.name}] onRequest → respond ${r.status || 200} FAILED: ${e.message || e} — request continues unmodified`, "error", s.scriptId);
                            try {
                                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
                            } catch {
                                /* detach race */
                            }
                        }
                        return;
                    }
                    if (resolved.cancel) {
                        dlogLevel("cdp", "info", "onRequest → cancel", { url, script: s.name });
                        try {
                            await debuggerSend(this.debuggeeOf(key), "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                            log(tabId, `[${s.name}] onRequest → cancel ${url}`, "info", s.scriptId);
                        } catch (e: any) {
                            log(tabId, `[${s.name}] onRequest → cancel FAILED: ${e.message || e}`, "error", s.scriptId);
                            try {
                                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
                            } catch {
                                /* detach race */
                            }
                        }
                        return;
                    }
                    if (resolved.redirect) {
                        dlogLevel("cdp", "info", "onRequest → redirect", { url, to: resolved.redirect, script: s.name });
                        try {
                            await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId, url: resolved.redirect });
                            log(tabId, `[${s.name}] onRequest → redirect → ${resolved.redirect} ${url}`, "info", s.scriptId);
                        } catch (e: any) {
                            log(tabId, `[${s.name}] onRequest → redirect FAILED: ${e.message || e}`, "error", s.scriptId);
                            try {
                                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
                            } catch {
                                /* detach race */
                            }
                        }
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
                        log(tabId, formatScriptError(s.name, e, "async onResponseHeaders"), "error", s.scriptId);
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
            const originalBody = body;

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
                        dlogLevel("cdp", "debug", `replaceResponse of "${s.name}" threw: ${e.message || e}`);
                        log(tabId, formatScriptError(s.name, e, "async replaceResponse"), "error", s.scriptId);
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
                        dlogLevel("cdp", "debug", `modifyResponse of "${s.name}" threw: ${e.message || e}`);
                        log(tabId, formatScriptError(s.name, e, "modifyResponse (cdp)"), "error", s.scriptId);
                    }
                }
            }

            const outBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
            dlogLevel("cdp", "debug", "fulfilling", { url, outLen: outBytes.length });
            recordNetBody({ tabId, url, method: request.method, original: originalBody, modified: body === originalBody ? null : body });
            await debuggerSend(this.debuggeeOf(key), "Fetch.fulfillRequest", {
                requestId,
                responseCode: params.responseStatusCode,
                responseHeaders,
                body: bytesToBase64(outBytes),
            });
        } catch (e: any) {
            log(tabId, `[cdp] body interception failed: ${e.message || e}`, "error");
            try {
                await debuggerSend(this.debuggeeOf(key), "Fetch.continueRequest", { requestId });
            } catch {
                /* detach race */
            }
        }
    }

    /**
     * MV3 pause handler: decisions come from the sandbox via the same body
     * ops the hook tier uses (requestDecision / replace / transform), so
     * chain semantics match exactly. Any failure continues the request
     * unmodified — and says so in the log.
     */
    private async handlePausedMv3(key: string, params: any): Promise<void> {
        const tabId: number = key.startsWith("tab:") ? Number(key.slice(4)) : -1;
        const d = this.debuggeeOf(key);
        const { requestId, request } = params;
        const url: string = request.url;
        const method: string = request.method;
        const resourceType = webRequestTypeOf(params.resourceType);
        const requestHeaders: Record<string, string> = request.headers || {};
        const cont = () => debuggerSend(d, "Fetch.continueRequest", { requestId }).catch(() => {});
        await this.ready;
        const isRequestStage = params.responseStatusCode === undefined && params.responseErrorReason === undefined;
        try {
            if (isRequestStage) {
                const scripts = this.matchingScripts(url).filter((s) => s.onRequest);
                if (!scripts.length) return void (await cont());
                const onlyIds = scripts.map((s) => s.scriptId);
                const decision = await runBodyOp(this.mv3Plain as any, this.mv3Params, "requestDecision", { url, method, resourceType, requestHeaders, onlyIds, tabId });
                dlogLevel("cdp", "debug", "MV3 request decision", { url, resourceType, kind: decision?.kind ?? "none" });
                if (!decision) return void (await cont());
                if (decision.kind === "respond") {
                    recordNetBody({ tabId, url, method, modified: decision.content ?? "", mime: decision.mime, status: decision.status || 200 });
                    const headers = [
                        { name: "content-type", value: decision.mime || "application/octet-stream" },
                        ...Object.entries(decision.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
                    ];
                    await debuggerSend(d, "Fetch.fulfillRequest", {
                        requestId,
                        responseCode: decision.status || 200,
                        responseHeaders: headers,
                        body: bytesToBase64(new TextEncoder().encode(decision.content ?? "")),
                    });
                    return;
                }
                if (decision.kind === "cancel") {
                    await debuggerSend(d, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                    return;
                }
                if (decision.kind === "redirect") {
                    await debuggerSend(d, "Fetch.continueRequest", { requestId, url: decision.url });
                    return;
                }
                if (decision.kind === "headers") {
                    const set: Record<string, string> = decision.changes?.set || {};
                    const remove = new Set<string>([...(decision.changes?.remove || []), ...Object.keys(set)].map((n: string) => n.toLowerCase()));
                    const headers = Object.entries(requestHeaders)
                        .filter(([n]) => !remove.has(n.toLowerCase()))
                        .map(([name, value]) => ({ name, value: String(value) }));
                    for (const [name, value] of Object.entries(set)) headers.push({ name, value: String(value) });
                    await debuggerSend(d, "Fetch.continueRequest", { requestId, headers });
                    return;
                }
                return void (await cont());
            }

            // ---- Response stage ----
            const status: number = params.responseStatusCode ?? 0;
            if (params.responseErrorReason || (status >= 300 && status < 400)) return void (await cont());
            const matched = this.matchingScripts(url);
            // page fetch/XHR are paused only for headers — their bodies are the hook's
            const pageFetch = MV3_PAGE_FETCH_TYPES.includes(params.resourceType);
            const scripts = pageFetch ? [] : matched.filter((s) => s.replaceResponse);
            const headerScripts = matched.filter((s) => s.onResponseHeaders);
            if (!scripts.length && !headerScripts.length) return void (await cont());
            const originalHeaders: { name: string; value: string }[] = params.responseHeaders || [];
            const headerMods = headerScripts.length
                ? await runBodyOp(this.mv3Plain as any, this.mv3Params, "responseHeaders", {
                      url,
                      method,
                      resourceType,
                      requestHeaders,
                      status,
                      responseHeaders: originalHeaders,
                      onlyIds: headerScripts.map((s) => s.scriptId),
                      tabId,
                  })
                : null;
            const baseHeaders = headerMods
                ? mergeHeaderChanges(originalHeaders, [headerMods]).filter((h): h is { name: string; value: string } => typeof h.value === "string")
                : originalHeaders;
            // headers only: keep streaming the original body
            const continueWithHeaders = async () => {
                if (!headerMods) return void (await cont());
                await debuggerSend(d, "Fetch.continueResponse", { requestId, responseCode: status || 200, responseHeaders: baseHeaders });
                dlogLevel("cdp", "info", "MV3: response headers modified", { url, resourceType });
            };
            if (!scripts.length) return void (await continueWithHeaders());
            // only debugger-tier scripts: hook-only ones must not touch <script> loads
            const onlyIds = scripts.map((s) => s.scriptId);
            const contentType = headerContentType(baseHeaders);
            let body: string | null = null;
            let mime: string | undefined;
            const replaced = await runBodyOp(this.mv3Plain as any, this.mv3Params, "replace", { url, method, resourceType, requestHeaders, onlyIds, tabId });
            if (replaced) {
                body = replaced.content;
                mime = replaced.mime;
            }
            let input = body;
            if (input === null) {
                const got: any = await debuggerSend(d, "Fetch.getResponseBody", { requestId });
                const bytes = got.base64Encoded ? base64ToBytes(got.body) : new TextEncoder().encode(got.body);
                if (looksTextual(bytes)) input = new TextDecoder().decode(bytes);
                else dlogLevel("cdp", "debug", "MV3: binary body — modifyResponse skipped", { url, len: bytes.length });
            }
            if (input !== null) {
                const out = await runBodyOp(this.mv3Plain as any, this.mv3Params, "transform", { url, method, resourceType, requestHeaders, body: input, contentType, status, onlyIds, tabId });
                if (out !== null && out !== undefined) body = out;
            }
            recordNetBody({ tabId, url, method, original: replaced ? null : input, modified: body === input && !replaced ? null : body, mime });
            if (body === null || (body === input && !replaced)) {
                dlogLevel("cdp", "debug", "MV3: no handler changed the body → continue", { url });
                return void (await continueWithHeaders());
            }
            // the body handed back is decoded — drop the original encoding/length
            const responseHeaders = baseHeaders.filter(
                (h: any) => !/^(content-encoding|content-length)$/i.test(h.name) && !(mime && /^content-type$/i.test(h.name))
            );
            if (mime) responseHeaders.push({ name: "content-type", value: mime });
            await debuggerSend(d, "Fetch.fulfillRequest", {
                requestId,
                responseCode: status || 200,
                responseHeaders,
                body: bytesToBase64(new TextEncoder().encode(body)),
            });
            dlogLevel("cdp", "info", "MV3: served modified body", { url, resourceType, len: body.length });
        } catch (e: any) {
            log(tabId, `[cdp] debugger interception failed for ${url}: ${e?.message || e} — the load continues UNMODIFIED`, "error");
            await cont();
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
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any);
    return btoa(bin);
}
