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
        }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        tabUrls.delete(tabId);
    });

    function tabUrlFor(tabId: number, requestUrl: string): string | null {
        if (tabId === -1) return requestUrl;
        return tabUrls.get(tabId) || null;
    }

    function applyHeaderChanges(
        headers: { name: string; value?: string }[],
        changes: HeaderChanges
    ): { name: string; value?: string }[] {
        const removeSet = new Set((changes.remove || []).map((n) => n.toLowerCase()));
        const out = headers
            .filter((h) => !removeSet.has(h.name.toLowerCase()))
            .map((h) => {
                const lower = h.name.toLowerCase();
                if (changes.set && lower in changes.set) {
                    return { name: h.name, value: changes.set[lower] };
                }
                return h;
            });
        if (changes.set) {
            const existing = new Set(out.map((h) => h.name.toLowerCase()));
            for (const [name, value] of Object.entries(changes.set)) {
                if (!existing.has(name.toLowerCase())) {
                    out.push({ name, value });
                }
            }
        }
        return out;
    }

    // ---- webRequest wiring ----
    const onBeforeRequest = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);

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

    // ---- manager protocol ----
    function injectName(code: string, name: string): string {
        if (!name) return code;
        if (/^\s*\/\/\s*@name\s+.*$/m.test(code)) {
            return code.replace(/^(\s*\/\/\s*@name\s+).*$/m, `$1${name}`);
        }
        return code;
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

        if (msg && msg.type === "claimRequest") {
            chromeBody.claimRequest(msg.url);
            sendResponse({});
            return false;
        }
        if (msg && msg.type === "getHookBundle") {
            // everything the page hook needs for this tab URL
            const bundle = {
                scripts: chromeBody.matchingBodyScripts(msg.url).map((s) => ({
                    scriptId: s.scriptId,
                    name: s.name,
                    match: s.match,
                    transformSrc: s.transformSrc,
                })),
                headerScripts: [] as any[],
            };
            sendResponse(bundle);
            return false;
        }
        if (msg && msg.type === "getProxyTransform") {
            const scripts = chromeBody.getTransformsForUrl(msg.url, null);
            sendResponse({
                transforms: scripts.map((s) => ({
                    scriptId: s.scriptId,
                    name: s.meta.name,
                    transformSrc: s.transformSrc,
                })),
            });
            return false;
        }
        return false;
    });

    // ---- reload plumbing ----
    async function reload(): Promise<void> {
        const scripts = (await listScripts()) as ScriptWithSources[];
        webRequestStrategy.reload(scripts);
        chromeBody.reload(scripts);
        cdp.reload(scripts);
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
            webRequestStrategy.dispose();
            chromeBody.dispose();
        },
    };
}

