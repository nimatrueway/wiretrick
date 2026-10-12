/**
 * Wires the strategies into chrome.webRequest and background messaging.
 * This is the single place that touches MV2 webRequest APIs; everything
 * browser-specific below it lives in strategies/.
 */
import type { InterceptionStrategy } from "./strategies/types";
import type { ChromeBodyStrategy } from "./strategies/chromeBodyStrategy";
import type { CdpStrategy } from "./strategies/cdpStrategy";
import type { HeaderChanges } from "./strategies/types";
import type { Script } from "./scriptStore";
import { listScripts, onScriptsChanged, saveScript, deleteScript, setEnabled, newId } from "./scriptStore";
import { serveStore } from "./strategies/webRequestStrategy";
import { dlog } from "../../shared/debugLog";
import { log } from "./logs";
import { serializeHandlers, type HandlerSources } from "../../shared/compile";

const FILTER: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

export interface Pipeline {
    reload(): Promise<void>;
    chromeBody: ChromeBodyStrategy;
    cdp: CdpStrategy;
    dispose(): void;
}

interface ScriptWithSources extends Script {
    _sources?: HandlerSources;
}

export function createPipeline(
    webRequestStrategy: InterceptionStrategy & { reload(s: Script[]): void },
    chromeBody: ChromeBodyStrategy,
    cdp: CdpStrategy
): Pipeline {
    const tabUrls = new Map<number, string>();

    // ---- tab URL tracking ----
    chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (info.url) {
            tabUrls.set(tabId, info.url);
            // pre-attach only when a CDP-relevant (non hook-only) body
            // script matches the page URL, and schedule an idle detach so
            // the banner disappears once the page settles
            if (cdp.cdpRelevantScripts(info.url).length > 0) {
                void cdp.ensureAttached(tabId, info.url);
                cdp.scheduleIdleDetach(tabId);
            }
        }
        if (info.status === "complete") {
            cdp.scheduleIdleDetach(tabId);
        }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        tabUrls.delete(tabId);
        chromeBody.forgetTab(tabId);
        cdp.forgetTab(tabId);
    });

    function tabUrlFor(tabId: number, requestUrl: string): string | null {
        if (tabId === -1) return requestUrl;
        return tabUrls.get(tabId) || null;
    }

    function applyHeaderChanges(
        headers: { name: string; value?: string }[],
        changes: HeaderChanges
    ): { name: string; value?: string }[] {
        // normalize set keys case-insensitively, preserving original casing
        // for headers that end up appended
        const setMap = new Map<string, { name: string; value: string }>();
        for (const [name, value] of Object.entries(changes.set || {})) {
            setMap.set(name.toLowerCase(), { name, value });
        }
        const removeSet = new Set([...(changes.remove || []).map((n) => n.toLowerCase()), ...setMap.keys()]);
        const out: { name: string; value?: string }[] = [];
        for (const h of headers) {
            const lower = h.name.toLowerCase();
            if (removeSet.has(lower)) {
                const replacement = setMap.get(lower);
                if (replacement) {
                    out.push({ name: h.name, value: replacement.value });
                    setMap.delete(lower);
                }
                continue;
            }
            out.push(h);
        }
        for (const replacement of setMap.values()) {
            out.push({ name: replacement.name, value: replacement.value });
        }
        return out;
    }

    // ---- webRequest wiring ----
    const onBeforeRequest = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);
        dlog("pipeline", "onBeforeRequest", { url: details.url, type: details.type, tabId: details.tabId }); // debug-level chatter

        // let the CDP strategy ensure attachment for main frames
        if (details.type === "main_frame" && tabUrl !== null) {
            void cdp.ensureAttached(details.tabId, details.url);
        }

        const cdpDisposition = { kind: "allow" as const };
        void cdpDisposition;

        const disposition = webRequestStrategy.handleBeforeRequest(details, tabUrl);
        const bodyDisposition = disposition.kind === "allow" ? chromeBody.handleBeforeRequest(details, tabUrl) : disposition;

        switch (bodyDisposition.kind) {
            case "redirect": {
                log(details.tabId, `${details.url} → ${bodyDisposition.url}`, "info");
                return { redirectUrl: bodyDisposition.url };
            }
            case "cancel": {
                log(details.tabId, `cancelled ${details.url}`, "warn");
                return { cancel: true };
            }
            case "needsCdp": {
                dlog("pipeline", "needsCdp → attach", { url: details.url, tabId: details.tabId });
                // banner minimization: this tab is actively using the debugger
                cdp.cancelIdleDetach(details.tabId);
                // learn which resource types each matching script hits, so
                // hook-covered (xhr-only) scripts stop triggering attaches
                const matchedScripts = chromeBody.matchingBodyScripts(details.url).map((x) => x.scriptId);
                if (matchedScripts.length) cdp.noteResourceType(matchedScripts, details.type);
                // gate on the REQUEST url — it matched a body script
                void cdp.ensureAttached(details.tabId, details.url);
                return {};
            }
            default:
                return {};
        }
    };

    const onBeforeSendHeaders = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);
        const changes =
            webRequestStrategy.handleBeforeSendHeaders(details, tabUrl) ||
            chromeBody.handleBeforeSendHeaders(details, tabUrl);
        if (!changes) return {};
        return { requestHeaders: applyHeaderChanges(details.requestHeaders || [], changes) };
    };

    const onHeadersReceived = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);
        const changes =
            webRequestStrategy.handleHeadersReceived(details, tabUrl) ||
            chromeBody.handleHeadersReceived(details, tabUrl);
        if (!changes) return {};
        return { responseHeaders: applyHeaderChanges(details.responseHeaders || [], changes) };
    };

    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER, ["blocking"]);
    chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, FILTER, ["requestHeaders", "blocking"]);
    chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, FILTER, ["responseHeaders", "blocking"]);

    // per-request caches must not leak for requests that never reach the
    // response-header phase
    const onDone = (details: any) => {
        webRequestStrategy.pruneRequest?.(details.requestId);
    };
    chrome.webRequest.onCompleted.addListener(onDone, FILTER);
    chrome.webRequest.onErrorOccurred.addListener(onDone, FILTER);

    // ---- manager protocol ----
    function injectName(code: string, name: string): string {
        if (!name) return code;
        if (/^\s*\/\/\s*@name\s+.*$/m.test(code)) {
            return code.replace(/^(\s*\/\/\s*@name\s+).*$/m, `$1${name}`);
        }
        // no @name line: inject one so the manager's name sticks
        return `// @name ${name}\n${code}`;
    }

    chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
        if (msg && msg.type === "listScripts") {
            listScripts().then((scripts) => sendResponse(scripts));
            return true;
        }
        if (msg && msg.type === "saveScript") {
            saveScript({
                id: msg.id || newId(),
                code: injectName(msg.code, msg.name),
                enabled: msg.enabled,
            })
                .then((s) => sendResponse(s))
                .catch((e) => sendResponse({ error: String(e) }));
            return true;
        }
        if (msg && msg.type === "deleteScript") {
            deleteScript(msg.id).then(() => sendResponse({}));
            return true;
        }
        if (msg && msg.type === "setEnabled") {
            setEnabled(msg.id, msg.enabled).then(() => sendResponse({}));
            return true;
        }
        if (msg && msg.type === "openTab") {
            chrome.windows.create({ url: msg.url, width: 1100, height: 750 }, () => void (chrome.runtime as any).lastError);
            sendResponse({});
            return false;
        }
        if (msg && msg.type === "getServe") {
            const entry = serveStore.get(msg.rid);
            serveStore.delete(msg.rid);
            sendResponse(entry || { content: null });
            return false;
        }

        if (msg && msg.type === "claimRequest") {
            chromeBody.claimRequest(msg.url);
            sendResponse({});
            return false;
        }
        if (msg && msg.type === "getHookBundle") {
            // full script sources: the hook compiles them itself so handlers
            // keep their `res` binding and top-level scope
            // ship ALL enabled body scripts — body transforms match request
            // URLs, not the page URL, so the hook filters per-request itself
            const bundle = {
                scripts: chromeBody.allBodyScripts().map((s) => ({
                    scriptId: s.scriptId,
                    name: s.name,
                    match: s.match,
                    code: s.code,
                })),
            };
            dlog("pipeline", "getHookBundle responding", { count: bundle.scripts.length, url: msg.url });
            sendResponse(bundle);
            return false;
        }
        if (msg && msg.type === "getProxyTransform") {
            const scripts = chromeBody.getTransformsForUrl(msg.url, null);
            sendResponse({
                transforms: scripts.map((s) => ({
                    scriptId: s.scriptId,
                    name: s.meta.name,
                    code: s.code,
                })),
            });
            return false;
        }
        return false;
    });

    // ---- reload plumbing ----
    async function reload(): Promise<void> {
        const scripts = (await listScripts()) as ScriptWithSources[];
        dlog("pipeline", "reload", { total: scripts.length, enabled: scripts.filter((x) => x.enabled).map((x) => x.meta.name) });
        webRequestStrategy.reload(scripts);
        chromeBody.reload(scripts);
        void cdp.reload(scripts);
    }

    const off = onScriptsChanged(() => void reload());
    void reload();

    return {
        reload,
        chromeBody,
        cdp,
        dispose() {
            off();
            chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
            chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
            chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
            chrome.webRequest.onCompleted.removeListener(onDone);
            chrome.webRequest.onErrorOccurred.removeListener(onDone);
            webRequestStrategy.dispose();
            chromeBody.dispose();
        },
    };
}

