/**
 * Chrome-class body strategy. Chrome's webRequest cannot touch response
 * bodies, so body modification is layered:
 *
 *  Tier A (hook):      a MAIN-world content script overrides fetch/XHR and
 *                      streams page-initiated bodies through the user's
 *                      transform. Banner-free. Claims requests so the
 *                      background skips them.
 *  Tier B (process):   the local helper (MITM proxy via PAC), opt-in via
 *                      strategy: ["process"]. Banner-free.
 *  Tier C (cdp):       chrome.debugger + Fetch domain, opt-in via
 *                      strategy: ["cdp"]. Handles main-frame HTML and
 *                      anything the hook cannot see.
 */
import { matchAny } from "../../../shared/matcher";
import { compileScript, makeScriptOverrides, makeModuleResolver } from "../../../shared/compile";
import { scriptLogLine } from "../../../shared/scriptLog";
import { formatScriptError } from "../../../shared/scriptError";
import { resolveFileRef } from "../../../shared/bodyOps";
import type { BodyScriptInfo, HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { runBodyOp } from "../../compileHost";
import { processActive } from "./processState";

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
    /** MV3: plain script data for the sandbox RPCs (no local compilation) */
    private mv3Scripts: { id: string; name: string; code: string; updatedAt: number; enabled: boolean }[] = [];
    private mv3Params: { [scriptId: string]: Record<string, any> } = {};
    private claimedUrls = new Map<string, number>();
    /** tabs where the page hook confirmed its bundle arrived */
    private hookReadyTabs = new Set<number>();
    /** tabs where page CSP blocked hook compilation — CDP fallback required */
    private hookBrokenTabs = new Set<number>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        if (__MV3__) {
            // the SW cannot compile — keep the plain data for the sandbox
            // RPCs (run* below); handlers execute in the sandbox page
            this.mv3Scripts = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true }));
            this.mv3Params = paramValues || {};
            return;
        }
        let resolveSpec: (spec: string) => any = (spec) => {
            throw new Error(`cannot import "${spec}" before the module registry is ready`);
        };
        const overridesFor = (s: { id: string; name: string; code: string }) =>
            makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, level, source, text) => log(-1, scriptLogLine(s.name, source, text), level, id), paramValues?.[s.id], (spec) => resolveSpec(spec));
        resolveSpec = makeModuleResolver(
            scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
            overridesFor
        ).resolve;
        this.bodyScripts = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            if (!/\b(?:wt|res)\s*\.\s*(modifyResponse|replaceResponse|onRequest)/.test(s.code)) continue;
            const compiled = compileScript(s.code, overridesFor({ id: s.id, name: s.meta.name, code: s.code }));
            if (!compiled.meta.declared) continue; // library module: inert, importable
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
        if (__MV3__) {
            return runBodyOp(this.mv3Scripts, this.mv3Params, "requestDecision", { url, method });
        }
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
                    log(-1, `[${s.name}] onRequest → redirect → ${result.redirect} ${url}`, "info", s.scriptId);
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
                log(-1, formatScriptError(s.name, e, "onRequest"), "error", s.scriptId);
            }
            }
        }
        return headerMods ? { kind: "headers", changes: headerMods } : null;
    }

    /** Hook tier: chained modifyResponse over the body (async handlers awaited). */
    async runTransform(url: string, method: string, body: string, extra?: { status?: number; contentType?: string }): Promise<string | null> {
        if (__MV3__) {
            return runBodyOp(this.mv3Scripts, this.mv3Params, "transform", { url, method, body, status: extra?.status, contentType: extra?.contentType });
        }
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
                log(-1, formatScriptError(s.name, e, "modifyResponse"), "error", s.scriptId);
            }
            }
        }
        return touched ? (typeof out === "string" ? out : new TextDecoder().decode(out)) : null;
    }

    /** Hook tier: first replaceResponse handler's result, or null. */
    async runReplace(url: string, method: string): Promise<{ mime: string; content: string } | null> {
        if (__MV3__) {
            return runBodyOp(this.mv3Scripts, this.mv3Params, "replace", { url, method });
        }
        for (const s of this.matchingBodyScripts(url)) {
            for (const replace of s.replace) {
                try {
                    const out = await replace({ url, method, tabUrl: url, resourceType: "xmlhttprequest", requestHeaders: {} });
                    if (out !== undefined && out !== null) {
                        const file = out && typeof out === "object" ? (out as any).file : undefined;
                        const { mime, content: body } = typeof file === "string" ? resolveFileRef(file, url) : { mime: guessMimeFromUrl(url), content: typeof out === "string" ? out : String(out) };
                        log(-1, `[${s.name}] replaceResponse → ${mime} (${body.length}b) ${url}`, "info", s.scriptId);
                        return { mime, content: body };
                    }
                } catch (e: any) {
                    log(-1, formatScriptError(s.name, e, "replaceResponse"), "error", s.scriptId);
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
        if (__MV3__) {
            // no local compilation — the plain-script count drives the hook's
            // active flag; transforms execute in the sandbox page
            return this.mv3Scripts.map((s) => ({
                scriptId: s.id,
                name: s.name,
                match: [],
                onRequest: [],
                transform: [],
                replace: [],
                strategy: "auto",
            })) as any;
        }
        return this.bodyScripts;
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
                    // default priority: hook → cdp
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
                if (tier === "process") {
                    // the helper proxy owns it while connected; else fall through
                    if (processActive()) {
                        chosen = "process";
                        break;
                    }
                    continue;
                }
                if (tier === "webrequest") {
                    // the webRequest strategy handles headers/redirects/
                    // static responses itself; response bodies can't be
                    // streamed on Chromium, so no body work here
                    chosen = "none";
                    break;
                }
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
            log(details.tabId, `[cdp] body transformed via debugger: ${shortUrl(details.url)}`, "info");
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
