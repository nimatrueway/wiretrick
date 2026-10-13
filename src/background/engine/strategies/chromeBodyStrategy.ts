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
import type { BodyScriptInfo, HookDisposition, InterceptionStrategy, WebRequestDetailsLike } from "./types";
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
    strategy: string;
}

export class ChromeBodyStrategy implements InterceptionStrategy {
    readonly name = "chromebody";

    private bodyScripts: BodyScriptEntry[] = [];
    private claimedUrls = new Map<string, number>();
    /** tabs where the page hook confirmed its bundle arrived */
    private hookReadyTabs = new Set<number>();

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

    handleBeforeRequest(details: WebRequestDetailsLike, _tabUrl: string | null): HookDisposition {
        // Tier-A claims win: the page hook owns this request's body.
        if (this.isClaimed(details.url)) {
            return { kind: "allow" };
        }

        const matching = this.matchingBodyScripts(details.url);
        if (matching.length === 0) {
            return { kind: "allow" };
        }

        if (matching.some((s) => s.strategy === "cdp")) {
            return { kind: "allow" }; // cdpStrategy owns these
        }

        if (details.type === "xmlhttprequest" || details.type === "websocket") {
            // The hook owns page-initiated traffic and claims every fetch it
            // sees. The claim races this decision (claim arrives a few ms
            // after onBeforeRequest), so instead of speculatively attaching
            // the debugger we only fall back to CDP when the hook never
            // confirmed installation in this tab (cold start).
            if (this.hookReadyTabs.has(details.tabId)) {
                return { kind: "allow" };
            }
            dlog("cdp", "hook not ready → CDP fallback", { url: shortUrl(details.url), tabId: details.tabId });
            return { kind: "needsCdp" };
        }

        // Everything the hook cannot see (main frame HTML, script tags,
        // images, css, fonts, ...) goes through the CDP strategy: let the
        // request proceed and transform the response there. The attach is
        // sticky per tab, so only the first navigation races the attach.
        log(details.tabId, `[CDP] body transform via debugger for ${shortUrl(details.url)}`, "info");
        return { kind: "needsCdp" };
    }

    handleBeforeSendHeaders(_d: WebRequestDetailsLike, _t: string | null): null {
        return null; // header mods live in webRequestStrategy
    }

    handleHeadersReceived(_d: WebRequestDetailsLike, _t: string | null): null {
        return null;
    }

    dispose(): void {
        this.bodyScripts = [];
        this.claimedUrls.clear();
        this.hookReadyTabs.clear();
    }
}

function shortUrl(url: string): string {
    return url.length > 120 ? url.slice(0, 117) + "..." : url;
}
