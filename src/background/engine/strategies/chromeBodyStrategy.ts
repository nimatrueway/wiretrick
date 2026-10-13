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
import { dlog } from "../../../shared/debugLog";

const PROXY_PATH = "__resproxy?p=";

interface BodyScriptEntry {
    scriptId: string;
    name: string;
    match: string[];
    code: string;
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

    reload(scripts: Script[]): void {
        this.bodyScripts = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            if (!/res\s*\.\s*modifyResponse|res\s*\.\s*replaceResponse/.test(s.code)) continue;
            const compiled = compileScript(
                s.code,
                makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, msg) => log(-1, `res.log: ${msg}`, "info", id), (id, level, msg) => log(-1, `script.console: ${msg}`, level, id))
            );
            if (!compiled.handlers.modifyResponse) continue;
            this.bodyScripts.push({
                scriptId: s.id,
                name: s.meta.name,
                match: s.meta.match,
                code: s.code,
                strategy: s.meta.strategy,
            });
        }
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
            code: s.code,
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
