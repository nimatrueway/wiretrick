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
import { compileScript, serializeHandlers } from "../../../shared/compile";
import type { BodyScriptInfo, HookDisposition, InterceptionStrategy, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log } from "../logs";

const PROXY_PATH = "__resproxy?p=";

interface BodyScriptEntry {
    scriptId: string;
    name: string;
    match: string[];
    transformSrc: string;
    strategy: string;
}

export class ChromeBodyStrategy implements InterceptionStrategy {
    readonly name = "chromebody";

    private bodyScripts: BodyScriptEntry[] = [];
    private claimedUrls = new Map<string, number>();

    reload(scripts: Script[]): void {
        this.bodyScripts = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            if (!/res\s*\.\s*modifyResponse|res\s*\.\s*replaceResponse/.test(s.code)) continue;
            const compiled = compileScript(s.code);
            const src = serializeHandlers(compiled).modifyResponse;
            if (!src) continue;
            this.bodyScripts.push({
                scriptId: s.id,
                name: s.meta.name,
                match: s.meta.match,
                transformSrc: src,
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

    matchingBodyScripts(url: string): BodyScriptEntry[] {
        return this.bodyScripts.filter((s) => matchAny(s.match, url));
    }

    getTransformsForUrl(url: string, _tabUrl: string | null): BodyScriptInfo[] {
        return this.matchingBodyScripts(url).map((s) => ({
            scriptId: s.scriptId,
            transformSrc: s.transformSrc,
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
            // The hook owns page-initiated traffic; it should have claimed this.
            return { kind: "allow" };
        }

        if (details.type === "main_frame") {
            // Main-frame HTML: a proxy redirect would clobber the address bar;
            // leave to CDP (opt-in) or the data-URL static-replace path.
            return { kind: "allow" };
        }

        // Tier B: redirect to the extension proxy service worker.
        const proxyUrl = chrome.runtime.getURL(PROXY_PATH + encodeURIComponent(details.url) + "&rt=" + details.type);
        log(details.tabId, `[Tier B] proxying ${shortUrl(details.url)} through extension proxy`, "info");
        return { kind: "redirect", url: proxyUrl };
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
    }
}

function shortUrl(url: string): string {
    return url.length > 120 ? url.slice(0, 117) + "..." : url;
}
