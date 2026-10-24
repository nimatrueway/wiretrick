/**
 * Debugger strategy: chrome.debugger + the CDP Fetch domain. Runs
 * the handler routes whose strategy is "debugger" — any request the tab (or its
 * workers) makes, in place, with real status codes. Chrome shows a
 * "started debugging this browser" banner while attached.
 *
 * MV2 attaches when a cdp route matches the page or a request (and
 * detaches when the page settles); MV3 keeps matching tabs attached.
 * Handlers run through the shared body ops (bodyOps.runOp) — locally on
 * MV2, in the sandbox page on MV3 — so chain semantics match every strategy.
 */
import { urlGlobOf } from "../../../shared/matcher";
import { runOp, type BodyOp, type OpScript } from "../../../shared/bodyOps";
import { routeMatches, type RouteKind } from "../../../shared/route";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { dlog, dlogLevel } from "../../../shared/debugLog";
import { debuggerAttach, debuggerSend, debuggerDetach, debuggerGetTargets, type Debuggee } from "../../../shared/chromeApi";
import { runBodyOp } from "../../compileHost";
import { winnerOf } from "../../../shared/precedence";
import { reportSkipped } from "../skipped";
import { recordNetBody } from "../../network";
import { compileMv2, ownedRoutes, ownsAny, type OwnedRoute } from "./strategyScripts";

/** webRequest resource type → CDP Fetch resource types */
const CDP_TYPES: Record<string, string[]> = {
    main_frame: ["Document"], sub_frame: ["Document"], stylesheet: ["Stylesheet"], script: ["Script"], image: ["Image"],
    font: ["Font"], object: ["Other"], xmlhttprequest: ["XHR", "Fetch", "EventSource"], ping: ["Ping"],
    csp_report: ["CSPViolationReport"], media: ["Media", "TextTrack"], websocket: ["WebSocket"], other: ["Other", "Manifest", "Prefetch", "SignedExchange"],
};

/** CDP resource type → webRequest-style name handlers see as ctx.resourceType */
export function webRequestTypeOf(cdpType: string | undefined): string {
    const m: Record<string, string> = {
        Document: "main_frame", Script: "script", Stylesheet: "stylesheet", Image: "image", Media: "media", TextTrack: "media",
        Font: "font", XHR: "xmlhttprequest", Fetch: "xmlhttprequest", EventSource: "xmlhttprequest", WebSocket: "websocket", Ping: "ping",
        CSPViolationReport: "csp_report",
    };
    return (cdpType && m[cdpType]) || "other";
}

type FetchPattern = { urlPattern: string; resourceType?: string; requestStage: "Request" | "Response" };

/** request stage: the request can end here (a replacement is served without the network) */
const REQUEST_KINDS: RouteKind[] = ["onRequest", "replaceResponse"];

/** Fetch.enable patterns for the owned routes (a coarse glob; handlers re-filter exactly) */
export function fetchPatternsOf(owned: OwnedRoute[]): FetchPattern[] {
    const out = new Map<string, FetchPattern>();
    for (const { route } of owned) {
        const requestStage = REQUEST_KINDS.includes(route.kind) ? "Request" : "Response";
        const types = route.resourceTypes ? [...new Set(route.resourceTypes.flatMap((t) => CDP_TYPES[t] || ["Other"]))] : [undefined];
        for (const m of route.url) {
            const urlPattern = urlGlobOf(m);
            for (const resourceType of types) {
                out.set(`${urlPattern}|${resourceType ?? "*"}|${requestStage}`, resourceType ? { urlPattern, resourceType, requestStage } : { urlPattern, requestStage });
            }
        }
    }
    return [...out.values()];
}

interface Mv3Plain {
    id: string;
    name: string;
    code: string;
    updatedAt: number;
    enabled: boolean;
}

export class DebuggerStrategy {
    /** attached sessions, keyed "tab:<id>" or "tgt:<targetId>" */
    private attached = new Set<string>();
    /** cdp-owned handler routes */
    private owned: OwnedRoute[] = [];
    /** MV2: compiled scripts owning cdp routes */
    private ops: OpScript[] = [];
    /** tabId → timer for idle auto-detach */
    private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** tab key → in-flight ensureAttached promise (dedup concurrent calls) */
    private attachInFlight = new Map<string, Promise<void>>();
    /** MV3: every enabled script (utilities included — imports resolve in the sandbox) */
    private mv3Plain: Mv3Plain[] = [];
    private mv3Params: { [scriptId: string]: Record<string, any> } = {};
    /** Fetch.enable patterns derived from the owned routes */
    private patterns: FetchPattern[] = [];
    /** resolves once attached tabs were resynced to the current routes */
    private ready: Promise<void> = Promise.resolve();
    private summary = "";
    /** "<tabId>|<url>" of recently paused loads (race-warning bookkeeping) */
    private recentlyPaused = new Set<string>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        const owned = ownedRoutes(scripts, "debugger");
        this.owned = owned;
        this.patterns = fetchPatternsOf(owned);
        if (__MV3__) {
            this.mv3Plain = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true }));
            this.mv3Params = paramValues || {};
        } else {
            this.ops = compileMv2(scripts, paramValues, (s) => ownsAny(s, "debugger")).map((c) => ({ id: c.id, name: c.name, handlers: c.compiled.handlers }));
        }
        // announce only when the owning set changes (reloads are frequent)
        const names = [...new Set(owned.map((o) => o.name))];
        const summary = JSON.stringify(names);
        if (summary !== this.summary && names.length) {
            log(-1, `[debugger] debugger strategy active for ${names.map((n) => `"${n}"`).join(", ")} — Chrome shows a "started debugging this browser" banner while attached`, "info");
        }
        this.summary = summary;
        dlog("debugger", "debugger strategy reloaded", { scripts: names, patterns: this.patterns.length });
        if (__MV3__) {
            this.ready = this.resyncAttachedMv3().catch((e: any) => {
                dlogLevel("debugger", "error", `debugger strategy resync failed: ${e?.message || e}`);
            });
        } else {
            for (const key of [...this.attached]) if (!this.owned.length) void this.detachByKey(key);
        }
    }

    /** does any enabled script own a cdp route? */
    hasOwners(): boolean {
        return this.owned.length > 0;
    }

    /** MV3: re-apply patterns to attached tabs and attach to already-open matching tabs. */
    private async resyncAttachedMv3(): Promise<void> {
        for (const key of [...this.attached]) {
            if (!key.startsWith("tab:")) continue;
            const tabId = Number(key.slice(4));
            let url: string | undefined;
            try { url = (await chrome.tabs.get(tabId))?.url; } catch { /* tab gone */ }
            if (!url || !this.shouldAttach(url)) {
                await this.detachByKey(key);
                continue;
            }
            try {
                await debuggerSend({ tabId }, "Fetch.enable", { patterns: this.patterns });
            } catch (e: any) {
                dlogLevel("debugger", "warn", "Fetch.enable refresh failed", { tabId, error: e?.message || e });
            }
        }
        if (!this.owned.length) return;
        try {
            for (const t of await chrome.tabs.query({})) {
                if (t.id !== undefined && t.url) await this.syncTabNow(t.id, t.url);
            }
        } catch {}
    }

    /**
     * MV3 tab lifecycle: attach while cdp routes exist and the tab is a web
     * page (kept attached — lazily loaded chunks arrive long after load);
     * detach once it navigates away.
     */
    async syncTab(tabId: number, url: string): Promise<void> {
        await this.ready;
        await this.syncTabNow(tabId, url);
    }

    /** syncTab without the ready gate (called from inside the resync itself) */
    private async syncTabNow(tabId: number, url: string): Promise<void> {
        const key = `tab:${tabId}`;
        if (this.shouldAttach(url)) {
            await this.ensureAttached(tabId, url);
        } else if (this.attached.has(key)) {
            dlogLevel("debugger", "debug", "tab left matching pages → detach", { tabId, url });
            await this.detachByKey(key);
        }
    }

    /** is this tab's debugger session live (Fetch enabled)? */
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
            dlogLevel("debugger", "warn", "re-navigation failed", { tabId, url, error: e?.message || e });
            return false;
        }
    }

    /** did a load of url on tabId reach the debugger recently? */
    wasPaused(tabId: number, url: string): boolean {
        return this.recentlyPaused.has(`${tabId}|${url}`);
    }

    /** names of scripts with a cdp route matching `url` (optionally a request's method/type) */
    debuggerScriptsFor(url: string, method?: string, type?: string): string[] {
        return [...new Set(this.owned.filter((o) => routeMatches(o.route, url, method, type)).map((o) => o.name))];
    }

    /** MV2: does this request need the debugger (a cdp route matches it)? */
    needs(details: { url: string; method: string; type: string }): boolean {
        return this.owned.some((o) => routeMatches(o.route, details.url, details.method, details.type));
    }

    private wants(url: string, method: string, type: string, kinds: RouteKind[]): boolean {
        return this.owned.some((o) => kinds.includes(o.route.kind) && routeMatches(o.route, url, method, type));
    }

    /** Forget per-tab state on tab close. */
    forgetTab(tabId: number): void {
        const key = `tab:${tabId}`;
        const t = this.idleTimers.get(key);
        if (t) clearTimeout(t);
        this.idleTimers.delete(key);
        this.attached.delete(key);
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
     * Worker/service-worker initiated requests (tabId −1): attach to the
     * WORKER targets whose origin matches.
     */
    async ensureWorkerAttached(url: string): Promise<void> {
        if (!this.owned.length) return;
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
                    await debuggerSend({ targetId: t.targetId }, "Fetch.enable", { patterns: this.patterns });
                    this.attached.add(key);
                    dlogLevel("debugger", "info", "worker target attached", { url: t.url.slice(0, 80) });
                } catch (e: any) {
                    dlogLevel("debugger", "warn", "worker attach failed", { target: t.url.slice(0, 60), error: e.message || e });
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
        const prev = this.idleTimers.get(key);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
            this.idleTimers.delete(key);
            if (this.attached.has(key)) {
                void this.detachByKey(key);
                dlogLevel("debugger", "debug", "idle detach (banner cleared)", { key });
            }
        }, graceMs);
        this.idleTimers.set(key, t);
    }

    /** Cancel a scheduled idle detach (a new request needs the debugger). */
    cancelIdleDetach(key: string): void {
        const t = this.idleTimers.get(key);
        if (t) {
            clearTimeout(t);
            this.idleTimers.delete(key);
        }
    }

    /**
     * Pre-attach for a page url. MV3: any web tab while cdp routes exist —
     * resources (CDN scripts…) rarely match the PAGE url; the Fetch patterns
     * keep non-matching loads un-paused. MV2: a cdp route matches the page.
     */
    shouldAttach(url: string): boolean {
        if (!this.owned.length || !this.patterns.length) return false;
        if (__MV3__) return /^(https?|file):/i.test(url);
        return this.owned.some((o) => routeMatches(o.route, url));
    }

    /** FORCED attach: a request explicitly needs the debugger (MV2 needsCdp). */
    async ensureAttachedForced(tabId: number, mainFrameUrl: string | null): Promise<void> {
        const key = `tab:${tabId}`;
        if (!mainFrameUrl || this.attached.has(key)) return;
        const inFlight = this.attachInFlight.get(key);
        if (inFlight) return inFlight;
        const p = this.doEnsureAttached(tabId, mainFrameUrl).finally(() => this.attachInFlight.delete(key));
        this.attachInFlight.set(key, p);
        return p;
    }

    /** Wire up a tab when a cdp route matches it. Concurrent calls dedup. */
    async ensureAttached(tabId: number, mainFrameUrl: string | null): Promise<void> {
        if (!mainFrameUrl || !this.shouldAttach(mainFrameUrl)) return;
        return this.ensureAttachedForced(tabId, mainFrameUrl);
    }

    private async doEnsureAttached(tabId: number, mainFrameUrl: string): Promise<void> {
        const key = `tab:${tabId}`;
        dlogLevel("debugger", "debug", "ensureAttached", { tabId, mainFrameUrl, scripts: this.debuggerScriptsFor(mainFrameUrl) });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                try {
                    await debuggerAttach({ tabId });
                } catch (e: any) {
                    if (/already attached/i.test(e.message || "") && this.attached.has(key)) return;
                    throw e;
                }
                try {
                    await debuggerSend(this.debuggeeOf(key), "Fetch.enable", { patterns: this.patterns });
                } catch (e: any) {
                    // enable failed while attached (evicted mid-flight) —
                    // detach so we never leave an orphan debugger attached
                    await debuggerDetach({ tabId }).catch(() => {});
                    throw e;
                }
                this.attached.add(key);
                dlogLevel("debugger", "info", "attached + Fetch.enabled", { tabId, attempt });
                log(tabId, "[debugger] debugger attached — debugger routes active in this tab", "info");
                return;
            } catch (e: any) {
                dlogLevel("debugger", "warn", `attach attempt ${attempt} failed`, { tabId, error: e.message || e });
                if (attempt === 1) {
                    dlogLevel("debugger", "error", "debugger attach failed after all retries", { tabId, error: e.message || e });
                    log(tabId, `[debugger] debugger attach failed: ${e.message || e}`, "error");
                    return;
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
    }

    /** run a body op over the cdp-owned handlers (locally on MV2, in the sandbox on MV3) */
    private run(op: BodyOp, args: Record<string, any>, tabId: number): Promise<any> {
        const a = { ...args, tabId, tier: "debugger" };
        if (__MV3__) return runBodyOp(this.mv3Plain as any, this.mv3Params, op, a);
        return runOp(this.ops, op, a, {
            log: (scriptId, level, msg, kind) => log(tabId, msg, level, scriptId, kind),
            debug: (msg) => dlogLevel("debugger", "debug", msg),
        });
    }

    /**
     * A paused request: run the cdp-owned handlers for its stage. Any
     * failure continues the request unmodified — and says so in the log.
     */
    async handlePaused(key: string, params: any): Promise<void> {
        const tabId: number = key.startsWith("tab:") ? Number(key.slice(4)) : -1;
        const { requestId, request } = params;
        const url: string = request.url;
        const pausedKey = `${tabId}|${url}`;
        this.recentlyPaused.add(pausedKey);
        setTimeout(() => this.recentlyPaused.delete(pausedKey), 120000);
        const d = this.debuggeeOf(key);
        const method: string = request.method;
        const resourceType = webRequestTypeOf(params.resourceType);
        const requestHeaders: Record<string, string> = request.headers || {};
        const cont = () => debuggerSend(d, "Fetch.continueRequest", { requestId }).catch(() => {});
        await this.ready;
        const isRequestStage = params.responseStatusCode === undefined && params.responseErrorReason === undefined;
        const base = { url, method, resourceType, requestHeaders };
        try {
            if (isRequestStage) {
                const wantsDecision = this.wants(url, method, resourceType, ["onRequest"]);
                const wantsReplace = this.wants(url, method, resourceType, ["replaceResponse"]);
                if (!wantsDecision && !wantsReplace) return void (await cont());
                const req = { url, method, type: resourceType };
                const decision = wantsDecision ? await this.run("requestDecision", base, tabId) : null;
                dlogLevel("debugger", "debug", "request decision", { url, resourceType, kind: decision?.kind ?? "none" });
                if (decision?.kind === "respond") {
                    reportSkipped(tabId, req, winnerOf(decision, "debugger"));
                    return void (await this.fulfill(d, requestId, tabId, url, method, decision.status || 200, decision.mime, decision.content ?? "", decision.headers, cont, `[${decision.scriptName}] onRequest → replaceResponse ${decision.status || 200}`, decision.scriptId));
                }
                if (decision?.kind === "cancel") {
                    reportSkipped(tabId, req, winnerOf(decision, "debugger"));
                    await debuggerSend(d, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                    return;
                }
                if (decision?.kind === "redirect") {
                    reportSkipped(tabId, req, winnerOf(decision, "debugger"));
                    await debuggerSend(d, "Fetch.continueRequest", { requestId, url: decision.url });
                    return;
                }
                // replaceResponse: after onRequest, before the network — the request is never sent
                const replaced = wantsReplace ? await this.run("replace", base, tabId) : null;
                if (replaced) {
                    reportSkipped(tabId, req, winnerOf(replaced, "debugger"));
                    return void (await this.fulfill(d, requestId, tabId, url, method, 200, replaced.mime, replaced.content, undefined, cont, `[${replaced.who?.scriptName ?? "?"}] replaceResponse`, replaced.who?.scriptId ?? null));
                }
                if (decision?.kind === "headers") {
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
            const wantsHeaders = this.wants(url, method, resourceType, ["onResponseHeaders"]);
            const wantsBody = this.wants(url, method, resourceType, ["onResponseBody"]);
            if (!wantsHeaders && !wantsBody) return void (await cont());
            const originalHeaders: { name: string; value: string }[] = params.responseHeaders || [];
            const headerMods = wantsHeaders
                ? await this.run("responseHeaders", { ...base, status, responseHeaders: originalHeaders }, tabId)
                : null;
            const baseHeaders = headerMods
                ? mergeHeaderChanges(originalHeaders, [headerMods]).filter((h): h is { name: string; value: string } => typeof h.value === "string")
                : originalHeaders;
            // headers only: keep streaming the original body
            const continueWithHeaders = async () => {
                if (!headerMods) return void (await cont());
                await debuggerSend(d, "Fetch.continueResponse", { requestId, responseCode: status || 200, responseHeaders: baseHeaders });
                dlogLevel("debugger", "info", "response headers modified", { url, resourceType });
            };
            if (!wantsBody) return void (await continueWithHeaders());
            const contentType = headerContentType(baseHeaders);
            let body: string | Uint8Array | null = null;
            let input: string | Uint8Array | null = null;
            const got: any = await debuggerSend(d, "Fetch.getResponseBody", { requestId });
            const bytes = got.base64Encoded ? base64ToBytes(got.body) : new TextEncoder().encode(got.body);
            // textual bodies are handed to transforms as strings; binary
            // stays bytes on MV2 (the MV3 sandbox gets text only)
            if (looksTextual(bytes)) input = new TextDecoder().decode(bytes);
            else if (!__MV3__) input = bytes;
            else dlogLevel("debugger", "debug", "binary body — onResponseBody skipped", { url, len: bytes.length });
            body = input;
            if (input !== null) {
                const out = await this.run("transform", { ...base, body: input, contentType, status, raw: typeof input !== "string" }, tabId);
                if (out !== null && out !== undefined) body = out;
            }
            recordNetBody({ tabId, url, method, original: input, modified: body === input ? null : body });
            if (body === null || body === input) {
                dlogLevel("debugger", "debug", "no handler changed the body → continue", { url });
                return void (await continueWithHeaders());
            }
            // the body handed back is decoded — drop the original encoding/length
            const responseHeaders = baseHeaders.filter((h: any) => !/^(content-encoding|content-length)$/i.test(h.name));
            const outBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
            await debuggerSend(d, "Fetch.fulfillRequest", {
                requestId,
                responseCode: status || 200,
                responseHeaders,
                body: bytesToBase64(outBytes),
            });
            dlogLevel("debugger", "info", "served modified body", { url, resourceType, len: outBytes.length });
        } catch (e: any) {
            log(tabId, `[debugger] debugger interception failed for ${url}: ${e?.message || e} — the load continues UNMODIFIED`, "error");
            await cont();
        }
    }

    /** serve a response without the network; on failure the request continues unmodified */
    private async fulfill(d: any, requestId: string, tabId: number, url: string, method: string, status: number, mime: string | undefined, content: string, headers: Record<string, any> | undefined, cont: () => Promise<unknown>, what: string, scriptId: string | null): Promise<void> {
        recordNetBody({ tabId, url, method, modified: content, mime, status });
        const responseHeaders = [
            { name: "content-type", value: mime || "application/octet-stream" },
            ...Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) })),
        ];
        try {
            await debuggerSend(d, "Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders, body: bytesToBase64(new TextEncoder().encode(content)) });
        } catch (e: any) {
            log(tabId, `${what} failed: ${e?.message || e} — the request continues UNMODIFIED ${url}`, "error", scriptId);
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
