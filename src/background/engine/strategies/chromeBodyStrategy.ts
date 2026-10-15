/**
 * Chrome-class body strategy. Chrome's webRequest cannot touch response
 * bodies, so body modification is layered:
 *
 *  Tier A (hook):      a MAIN-world content script overrides fetch/XHR and
 *                      streams page-initiated bodies through the user's
 *                      transform. Banner-free. Claims requests so the
 *                      background skips them.
 *  Tier B (proxy):     non-JS resources (script/img/css/font/media) are
 *                      redirected to chrome-extension://<id>/__resproxy,
 *                      where a service worker on the extension origin fetches
 *                      the original, transforms it, and serves it with the
 *                      right Content-Type. Banner-free.
 *  Tier C (cdp):       chrome.debugger + Fetch domain, opt-in via
 *                      @strategy cdp or "strict interception". Handles
 *                      main-frame HTML and anything A/B cannot see.
 */
import { matchAny } from "../../../shared/matcher";
import { compileScript, makeScriptOverrides } from "../../../shared/compile";
import type { BodyScriptInfo, HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";

function guessMimeFromUrl(url: string): string {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
    const m: Record<string, string> = { js: "application/javascript", json: "application/json", css: "text/css", html: "text/html", xml: "application/xml" };
    return m[ext] || "application/json";
}

function serializeRespondBody(body: any): string {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    return JSON.stringify(body);
}
import { dlog } from "../../../shared/debugLog";

const PROXY_PATH = "__resproxy?p=";

interface BodyScriptEntry {
    scriptId: string;
    name: string;
    match: string[];
    /** compiled onRequest handlers (stacked; first terminal result wins) */
    onRequest: ((ctx: any) => any)[];
    /** compiled modifyResponse transforms (compose in order) */
    transform: ((ctx: any, body: any) => any)[];
    /** compiled replaceResponse handlers (first non-null wins) */
    replace: ((ctx: any) => any)[];
    /** comma-separated strategy priority list, e.g. "hook,cdp" */
    strategy: string;
}

export class ChromeBodyStrategy implements InterceptionStrategy {
    readonly name = "chromebody";

    private bodyScripts: BodyScriptEntry[] = [];
    private claimedUrls = new Map<string, number>();
    /** tabs where the page hook confirmed its bundle arrived */
    private hookReadyTabs = new Set<number>();
    /** tabs where page CSP blocked hook compilation — CDP fallback required */
    private hookBrokenTabs = new Set<number>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        this.bodyScripts = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            if (!/res\s*\.\s*(modifyResponse|replaceResponse|onRequest)/.test(s.code)) continue;
            const compiled = compileScript(
                s.code,
                makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, msg) => log(-1, `[${s.meta.name}] res.log: ${msg}`, "info", id), (id, level, msg) => log(-1, `[${s.meta.name}] console.log: ${msg}`, level, id), paramValues?.[s.id])
            );
            if (!compiled.handlers.modifyResponse && !compiled.handlers.onRequest && !compiled.handlers.replaceResponse) continue;
            this.bodyScripts.push({
                scriptId: s.id,
                name: s.meta.name,
                match: s.meta.match,
                onRequest: compiled.handlers.onRequest,
                transform: compiled.handlers.modifyResponse,
                replace: compiled.handlers.replaceResponse,
                strategy: s.meta.strategy,
            });
        }
    }

    /**
     * Hook tier: runs the matching scripts' onRequest handlers ONCE and
     * returns the first terminal decision (respond | redirect | cancel) or
     * merged headers. Null = no terminal decision (normal flow proceeds).
     */
    async runRequestDecision(
        url: string,
        method: string
    ): Promise<{ kind: "respond"; mime: string; content: string; status?: number; headers?: any } | { kind: "redirect"; url: string } | { kind: "cancel" } | { kind: "headers"; changes: any } | null> {
        let headerMods: any = null;
        for (const s of this.matchingBodyScripts(url)) {
            for (const onRequest of s.onRequest) {
            try {
                const result = await onRequest({ url, method, tabUrl: url, resourceType: "xmlhttprequest", requestHeaders: {} });
                if (!result) continue;
                if ((result as any).respond) {
                    const r = (result as any).respond;
                    const mime = r.mime || guessMimeFromUrl(url);
                    const content = serializeRespondBody(r.body);
                    log(-1, `[${s.name}] onRequest → respond ${r.status || 200} ${mime} (${content.length}b) ${url}`, "info", s.scriptId);
                    return {
                        kind: "respond",
                        mime,
                        content,
                        status: r.status,
                        headers: r.headers?.set,
                    };
                }
                if (result.redirect) {
                    log(-1, `[${s.name}] onRequest → redirect → ${result.redirect}`, "info", s.scriptId);
                    return { kind: "redirect", url: result.redirect };
                }
                if (result.cancel) {
                    log(-1, `[${s.name}] onRequest → cancel ${url}`, "info", s.scriptId);
                    return { kind: "cancel" };
                }
                if (result.headers && ((result.headers.set && Object.keys(result.headers.set).length) || (result.headers.remove && result.headers.remove.length))) {
                    const parts: string[] = [];
                    if (result.headers.set && Object.keys(result.headers.set).length) parts.push(`set ${Object.keys(result.headers.set).join(", ")}`);
                    if (result.headers.remove && result.headers.remove.length) parts.push(`remove ${result.headers.remove.join(", ")}`);
                    log(-1, `[${s.name}] onRequest → request headers (${parts.join("; ")}) ${url}`, "info", s.scriptId);
                    headerMods = { set: { ...(headerMods?.set || {}), ...(result.headers.set || {}) }, remove: [...(headerMods?.remove || []), ...(result.headers.remove || [])] };
                }
            } catch (e: any) {
                log(-1, `console.log: onRequest ${s.name} threw: ${e.message || e}`, "error", s.scriptId);
            }
            }
        }
        return headerMods ? { kind: "headers", changes: headerMods } : null;
    }

    /** Hook tier: chained modifyResponse over the body (async handlers awaited). */
    async runTransform(url: string, method: string, body: string, extra?: { status?: number; contentType?: string }): Promise<string | null> {
        let out: string | Uint8Array = body;
        let touched = false;
        for (const s of this.matchingBodyScripts(url)) {
            for (const transform of s.transform) {
            try {
                const result: any = await transform(
                    { url, method, tabUrl: url, resourceType: "xmlhttprequest", requestHeaders: {}, contentType: extra?.contentType, status: extra?.status },
                    out
                );
                if (result !== undefined && result !== null) {
                    const before = typeof out === "string" ? out.length : out.byteLength;
                    const prevOut = out;
                    const next = typeof result === "string" ? result : result instanceof Uint8Array ? result : JSON.stringify(result);
                    const after = typeof next === "string" ? next.length : next.byteLength;
                    out = next;
                    // unchanged output = do-nothing, don't log it
                    if (next !== prevOut) {
                        log(-1, `[${s.name}] modifyResponse applied (${before}b → ${after}b) ${url}`, "info", s.scriptId);
                    }
                    touched = true;
                }
            } catch (e: any) {
                log(-1, `console.log: transform ${s.name} threw: ${e.message || e}`, "error", s.scriptId);
            }
            }
        }
        return touched ? (typeof out === "string" ? out : new TextDecoder().decode(out)) : null;
    }

    /** Hook tier: first replaceResponse handler's result, or null. */
    async runReplace(url: string, method: string): Promise<{ mime: string; content: string } | null> {
        for (const s of this.matchingBodyScripts(url)) {
            for (const replace of s.replace) {
                try {
                    const out = await replace({ url, method, tabUrl: url, resourceType: "xmlhttprequest", requestHeaders: {} });
                    if (out !== undefined && out !== null) {
                        const content = out && typeof out === "object" && (out as any).file ? (out as any).file : out;
                        const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
                        const mimes: Record<string, string> = { js: "application/javascript", json: "application/json", css: "text/css", html: "text/html", xml: "application/xml" };
                        const mime = mimes[ext] || "application/json";
                        const body = typeof content === "string" ? content : String(content);
                        log(-1, `[${s.name}] replaceResponse → ${mime} (${body.length}b) ${url}`, "info", s.scriptId);
                        return { mime, content: body };
                    }
                } catch (e: any) {
                    log(-1, `console.log: replaceResponse ${s.name} threw: ${e.message || e}`, "error", s.scriptId);
                }
            }
        }
        return null;
    }

    supportsBodyModification(): boolean {
        return true;
    }

    /** Called by the Tier-A hook (via background messaging) to claim a request. */
    claimRequest(url: string): void {
        this.claimedUrls.set(url, Date.now());
        if (this.claimedUrls.size > 500) {
            const cutoff = Date.now() - 30_000;
            for (const [u, t] of this.claimedUrls) {
                if (t < cutoff) this.claimedUrls.delete(u);
            }
        }
    }

    isClaimed(url: string): boolean {
        const t = this.claimedUrls.get(url);
        return t !== undefined && Date.now() - t < 10_000;
    }

    /** Called after the background served a hook bundle to a tab. */
    markHookReady(tabId: number): void {
        this.hookReadyTabs.add(tabId);
    }

    forgetTab(tabId: number): void {
        this.hookReadyTabs.delete(tabId);
        this.hookBrokenTabs.delete(tabId);
    }

    /** Page CSP blocked hook compilation in this tab → CDP handles all bodies. */
    markHookBroken(tabId: number): void {
        this.hookReadyTabs.delete(tabId);
        this.hookBrokenTabs.add(tabId);
    }

    matchingBodyScripts(url: string): BodyScriptEntry[] {
        return this.bodyScripts.filter((s) => matchAny(s.match, url));
    }

    /** All enabled body scripts — the hook filters per-request itself. */
    allBodyScripts(): BodyScriptEntry[] {
        return this.bodyScripts;
    }

    getTransformsForUrl(url: string, _tabUrl: string | null): BodyScriptInfo[] {
        return this.matchingBodyScripts(url).map((s) => ({
            scriptId: s.scriptId,
            code: "",
            meta: {
                name: s.name,
                match: s.match,
                include: [],
                phase: ["request", "response"],
                strategy: s.strategy as any,
                runAt: "document_start",
            },
        }));
    }

    handleBeforeRequest(details: WebRequestDetailsLike, _tabUrl: string | null): MaybePromise<HookDisposition> {
        // Tier-A claims win: the page hook owns this request's body.
        if (this.isClaimed(details.url)) {
            return { kind: "allow" };
        }

        const matching = this.matchingBodyScripts(details.url);
        if (matching.length === 0) {
            return { kind: "allow" };
        }

        // walk each matching script's strategy priority list in order and
        // combine: the first viable tier per script wins
        let anyCdp = false;
        for (const script of matching) {
            const list = script.strategy.split(",").map((x) => x.trim());
            let chosen: string | null = null;
            for (const tier of list) {
                if (tier === "auto") {
                    // default priority: hook → (proxy later/mv3) → cdp
                    if (details.type === "xmlhttprequest" || details.type === "websocket") {
                        chosen = this.hookReadyTabs.has(details.tabId) ? "hook" : "cdp";
                    } else {
                        chosen = "cdp";
                    }
                    break;
                }
                if (tier === "hook") {
                    // only viable for page-initiated traffic once the hook is
                    // ready; otherwise continue down the list
                    if (
                        (details.type === "xmlhttprequest" || details.type === "websocket") &&
                        this.hookReadyTabs.has(details.tabId)
                    ) {
                        chosen = "hook";
                        break;
                    }
                    continue;
                }
                if (tier === "cdp") {
                    chosen = "cdp";
                    break;
                }
                if (tier === "webrequest") {
                    // Firefox-only network path; on Chrome = no body work
                    chosen = "none";
                    break;
                }
                // proxy: reserved for the MV3 DNR path
            }
            if (chosen === "cdp") {
                anyCdp = true;
                break;
            }
            if (chosen === "hook") {
                return { kind: "allow" }; // hook-owned: no debugger
            }
            // chosen === null → fall through to next script in list
        }

        if (anyCdp) {
            log(details.tabId, `[CDP] body transform via debugger for ${shortUrl(details.url)}`, "info");
            return { kind: "needsCdp" };
        }
        return { kind: "allow" };
    }

    handleBeforeSendHeaders(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HeaderChanges | null> {
        return null; // header mods live in webRequestStrategy
    }

    handleHeadersReceived(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HeaderChanges | null> {
        return null;
    }

    dispose(): void {
        this.bodyScripts = [];
        this.claimedUrls.clear();
        this.hookReadyTabs.clear();
        this.hookBrokenTabs.clear();
    }
}

function shortUrl(url: string): string {
    return url.length > 120 ? url.slice(0, 117) + "..." : url;
}
