/**
 * Wires the strategies into chrome.webRequest and background messaging.
 * This is the single place that touches MV2 webRequest APIs; everything
 * browser-specific below it lives in strategies/.
 */
import type { InterceptionStrategy } from "./strategies/types";
import type { ChromeBodyStrategy } from "./strategies/chromeBodyStrategy";
import type { CdpStrategy } from "./strategies/cdpStrategy";
import type { ProcessStrategy } from "./strategies/processStrategy";
import { onProcessActiveChange } from "./strategies/processState";
import type { HeaderChanges } from "./strategies/types";
import type { Script } from "./scriptStore";
import { listScripts, onScriptsChanged, saveScript, deleteScript, setEnabled, newId, scriptStorageGet, scriptStorageSet, loadAllParamValues, getParamValues, setParamValue } from "./scriptStore";
import { matchAny } from "../../shared/matcher";
import { serveStore } from "./strategies/webRequestStrategy";
import { dlogLevel } from "../../shared/debugLog";
import { isThenable, toRunnableJs } from "../../shared/compile";
import "../../shared/transpile";
void toRunnableJs;
import { log } from "./logs";
import { serializeHandlers, type HandlerSources } from "../../shared/compile";
import { resolveParamValues } from "../../shared/scriptDef";
import { analyzeScripts, runBodyOp } from "../compileHost";
import { syncProxyRules } from "../proxyRules";

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
    webRequestStrategy: InterceptionStrategy & { reload(s: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void },
    chromeBody: ChromeBodyStrategy,
    cdp: CdpStrategy,
    processStrategy: ProcessStrategy,
    updateTabBadge?: (tabId: number, url: string | undefined) => Promise<void>,
    noteRequestForBadge?: (tabId: number, url: string) => number
): Pipeline {
    const tabUrls = new Map<number, string>();

    // ---- tab URL tracking ----
    if (__MV3__ && (chrome as any).webNavigation) {
        // MV3 debugger tier: attach BEFORE the navigation's subresources
        // load (webNavigation also wakes an idle service worker)
        chrome.webNavigation.onBeforeNavigate.addListener((d) => {
            if (d.frameId === 0) void cdp.syncTab(d.tabId, d.url);
        });
    }
    if (__MV3__ && chrome.webRequest) {
        // observe-only (MV3-legal): a debugger-tier load that left before
        // the tab's debugger attached (fast first navigation / cold SW) is
        // NOT intercepted — say so instead of failing silently
        const neverPaused = new Set(["xmlhttprequest", "websocket", "ping", "csp_report", "webbundle", "webtransport"]);
        chrome.webRequest.onCompleted.addListener(
            (d) => {
                if (d.tabId < 0 || neverPaused.has(d.type)) return;
                const names = cdp.debuggerScriptsFor(d.url);
                if (!names.length) return;
                // any pause (request or response stage) precedes completion
                setTimeout(() => {
                    if (cdp.wasPaused(d.tabId, d.url)) return;
                    log(d.tabId, `[Tier C] ${d.type} ${d.url}${d.fromCache ? " (from cache)" : ""} loaded BEFORE the debugger attached to this tab (or before interception was enabled) — NOT intercepted by ${names.map((n) => `"${n}"`).join(", ")}. Reload the tab (it stays attached from now on).`, "warn");
                }, 300);
            },
            { urls: ["<all_urls>"] }
        );
    }
    chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (__MV3__) {
            if (info.url) {
                tabUrls.set(tabId, info.url);
                void cdp.syncTab(tabId, info.url);
            }
            return;
        }
        if (info.url) {
            tabUrls.set(tabId, info.url);
            // pre-attach only when a CDP-relevant (non hook-only) body
            // script matches the page URL, and schedule an idle detach so
            // the banner disappears once the page settles
            if (cdp.hasCdpListedScripts(info.url) && cdp.cdpRelevantScripts(info.url).length > 0) {
                void cdp.ensureAttached(tabId, info.url);
                cdp.scheduleIdleDetach(`tab:${tabId}`);
            }
        }
        if (info.status === "complete") {
            cdp.scheduleIdleDetach(`tab:${tabId}`);
        }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        tabUrls.delete(tabId);
        chromeBody.forgetTab(tabId);
        cdp.forgetTab(tabId);
        processStrategy.forgetTab(tabId);
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
        dlogLevel("pipeline", "debug", "onBeforeRequest", { url: details.url, type: details.type, tabId: details.tabId });

        // let the CDP strategy ensure attachment for main frames
        if (details.type === "main_frame" && tabUrl !== null) {
            void cdp.ensureAttached(details.tabId, details.url);
        }
        // badge: main-frame navigation resets the tab's active-script set,
        // then every request (page + resources) accumulates matches
        if (details.type === "main_frame") {
            noteRequestForBadge?.(details.tabId, details.url);
            void updateTabBadge?.(details.tabId, details.url);
            // workers/service-workers can't host the hook — sweep their
            // targets so respond-with-status works for worker fetches too
            if (chromeBody.allBodyScripts().length > 0) {
                void cdp.ensureWorkerAttached(details.url);
            }
        } else {
            const n = noteRequestForBadge?.(details.tabId, details.url);
            if (n !== undefined && n > 0) void updateTabBadge?.(details.tabId, details.url);
        }

        const cdpDisposition = { kind: "allow" as const };
        void cdpDisposition;

        const disposition = webRequestStrategy.handleBeforeRequest(details, tabUrl);

        // Firefox: blocking listeners accept promises — pass straight through
        if (isThenable(disposition)) {
            return disposition.then((d: any) => this2.applyDisposition(d, details));
        }

        return this2.applyDisposition(
            disposition.kind === "allow" ? (chromeBody.handleBeforeRequest(details, tabUrl) as any) : disposition,
            details
        );
    };

    const self = {
        applyDisposition,
    };
    const this2 = {
        applyDisposition,
    };

    function applyDisposition(disposition: any, details: any): any {
        switch (disposition.kind) {
            case "redirect": {
                log(details.tabId, `${details.url} → ${disposition.url}`, "info");
                return { redirectUrl: disposition.url };
            }
            case "cancel": {
                log(details.tabId, `cancelled ${details.url}`, "warn");
                return { cancel: true };
            }
            case "needsCdp": {
                dlogLevel("pipeline", "debug", "needsCdp → attach", { url: details.url, tabId: details.tabId });
                // banner minimization: this tab is actively using the debugger
                cdp.cancelIdleDetach(`tab:${details.tabId}`);
                // learn which resource types each matching script hits, so
                // hook-covered (xhr-only) scripts stop triggering attaches
                const matchedScripts = chromeBody.matchingBodyScripts(details.url).map((x) => x.scriptId);
                if (matchedScripts.length) cdp.noteResourceType(matchedScripts, details.type);
                if (details.tabId === -1) {
                    // worker/service-worker initiated (no content scripts
                    // there) — attach to the worker targets directly
                    void cdp.ensureWorkerAttached(details.url);
                } else {
                    // forced: this request explicitly needs CDP (e.g. a
                    // respond-with-status the hook cannot serve)
                    void cdp.ensureAttachedForced(details.tabId, details.url);
                    // cover worker-initiated twins of the same origin
                    void cdp.ensureWorkerAttached(details.url);
                }
                return {};
            }
            default:
                return {};
        }
    }

    const onBeforeSendHeaders = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);
        const changes =
            webRequestStrategy.handleBeforeSendHeaders(details, tabUrl) ||
            chromeBody.handleBeforeSendHeaders(details, tabUrl);
        if (isThenable(changes)) {
            return changes.then((c: any) => (c ? { requestHeaders: applyHeaderChanges(details.requestHeaders || [], c) } : {}));
        }
        if (!changes) return {};
        return { requestHeaders: applyHeaderChanges(details.requestHeaders || [], changes) };
    };

    const onHeadersReceived = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);
        const changes =
            webRequestStrategy.handleHeadersReceived(details, tabUrl) ||
            chromeBody.handleHeadersReceived(details, tabUrl);
        if (isThenable(changes)) {
            return changes.then((c: any) => (c ? { responseHeaders: applyHeaderChanges(details.responseHeaders || [], c) } : {}));
        }
        if (!changes) return {};
        return { responseHeaders: applyHeaderChanges(details.responseHeaders || [], changes) };
    };

    if (!__MV3__) {
        // MV2-only: blocking webRequest is the Tier-A2 dispatch path. MV3
        // forbids "blocking" — the hook tier (below) carries interception.
        chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest as any, FILTER, ["blocking"] as any);
        chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders as any, FILTER, ["requestHeaders", "blocking"] as any);
        chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived as any, FILTER, ["responseHeaders", "blocking"] as any);

        // per-request caches must not leak for requests that never reach the
        // response-header phase
        const onDone = (details: any) => {
            webRequestStrategy.pruneRequest?.(details.requestId);
        };
        chrome.webRequest.onCompleted.addListener(onDone, FILTER);
        chrome.webRequest.onErrorOccurred.addListener(onDone, FILTER);
    } else {
        dlogLevel("pipeline", "info", "MV3: no blocking webRequest — hook tier carries page fetch/XHR; the debugger tier (strategy cdp/proxy) carries browser-initiated loads");
    }

    // ---- manager protocol ----
    chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
        if (msg && msg.type === "listScripts") {
            listScripts().then(async (scripts) => {
                // scripts saved before declareScript existed have no stored
                // paramDefs — compile them on the fly (imports stubbed: we
                // only need declarations here) so the UI can offer ⚙
                const missing = scripts.filter((s) => s.paramDefs === undefined);
                const analyzed = await analyzeScripts(missing.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
                sendResponse(
                    scripts.map((s) =>
                        s.paramDefs === undefined ? { ...s, paramDefs: analyzed.get(s.id)?.paramDefs || {} } : s
                    )
                );
            });
            return true;
        }
        if (msg && msg.type === "saveScript") {
            saveScript({
                id: msg.id || newId(),
                code: msg.code,
                name: msg.name,
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
            chrome.windows.getLastFocused((win) => {
                if (win && win.id !== undefined) {
                    chrome.tabs.create({ windowId: win.id, url: msg.url });
                } else {
                    chrome.windows.create({ url: msg.url, width: 1100, height: 750 });
                }
            });
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
            void (async () => {
            // full script sources: the hook compiles them itself so handlers
            // keep their `res` binding and top-level scope
            // ship ALL enabled body scripts — body transforms match request
            // URLs, not the page URL, so the hook filters per-request itself
            // deliver runnable JS: the page hook has no TS compiler
            // Transforms run in the background (the hook is eval-free and
            // immune to page CSP). onDom handler SOURCES ship to the page:
            // onDom needs the page's window, so it runs in the MAIN world
            // when the page CSP allows, with the bridge as the fallback.
            const domHandlers: { scriptId: string; name: string; when: string; src: string; params: Record<string, any> }[] = [];
            const libs = new Map<string, string>(); // name → transpiled lib source
            {
                const pageScripts = await listScripts();
                // MV3: scripts are analyzed in the sandbox page (the SW can't
                // eval); MV2 compiles right here. Both paths return plain
                // metadata; the shipped handler SOURCES are transpiled locally.
                const analyzed = await analyzeScripts(pageScripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
                const depNames = new Set<string>();
                for (const s of pageScripts) {
                    if (!s.enabled || !matchAny(s.meta.match, msg.url || "")) continue;
                    const a = analyzed.get(s.id);
                    if (!a?.declared) continue; // library: inert on its own
                    for (const d of a.deps) depNames.add(d);
                    if (a.onDom) {
                        // FULL transpiled source: the runner compiles it with
                        // a shim so top-level helpers/closures survive
                        domHandlers.push({
                            scriptId: s.id,
                            name: s.meta.name,
                            when: a.onDomWhen || "DOMContentLoaded",
                            src: toRunnableJs(s.code),
                            params: resolveParamValues(a.paramDefs || {}, await getParamValues(s.id)),
                        });
                    }
                }
                // ship the transitively imported library sources once
                for (const depName of depNames) {
                    const lib = pageScripts.find((x) => x.meta.name === depName);
                    if (lib && !libs.has(lib.meta.name)) libs.set(lib.meta.name, toRunnableJs(lib.code));
                }
            }
            dlogLevel("pipeline", "debug", "getHookBundle responding", {
                count: chromeBody.allBodyScripts().length,
                dom: domHandlers.length,
                url: msg.url,
            });
                sendResponse({ count: chromeBody.allBodyScripts().length, domHandlers, libs: [...libs.entries()].map(([name, src]) => ({ name, src })) });
            })();
            return true; // async sendResponse above
        }
        if (msg && msg.type === "scriptStorageGet") {
            scriptStorageGet(msg.scriptId, msg.key).then((value: any) => sendResponse({ value }));
            return true;
        }
        if (msg && msg.type === "getScriptParams") {
            void (async () => {
                const scripts = await listScripts();
                const s = scripts.find((x) => x.id === msg.scriptId);
                if (!s) {
                    sendResponse({ defs: {}, values: {} });
                    return;
                }
                const analyzed = await analyzeScripts([{ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt }]);
                const defs = analyzed.get(s.id)?.paramDefs || {};
                sendResponse({
                    defs,
                    values: resolveParamValues(defs, await getParamValues(s.id)),
                    name: s.meta.name,
                });
            })();
            return true;
        }
        if (msg && msg.type === "setScriptParam") {
            void (async () => {
                const scripts = await listScripts();
                const s = scripts.find((x) => x.id === msg.scriptId);
                if (s) {
                    await setParamValue(s.id, msg.key, msg.value);
                    log(-1, `[${s.meta.name}] param ${msg.key} = ${JSON.stringify(msg.value)}`, "info", s.id);
                }
                sendResponse({});
            })();
            return true;
        }
        if (msg && msg.type === "scriptStorageSet") {
            scriptStorageSet(msg.scriptId, msg.key, msg.value).then(() => sendResponse({}));
            return true;
        }
        if (msg && msg.type === "runRequestDecision") {
            dlogLevel("pipeline", "debug", `runRequestDecision ${msg.url}`);
            chromeBody.runRequestDecision(msg.url, msg.method || "GET").then((r) => sendResponse(r || null));
            return true;
        }
        if (msg && msg.type === "runTransform") {
            chromeBody
                .runTransform(msg.url, msg.method || "GET", msg.body || "", { status: msg.status, contentType: msg.contentType })
                .then((body) => sendResponse({ body }));
            return true;
        }
        if (msg && msg.type === "runReplace") {
            chromeBody.runReplace(msg.url, msg.method || "GET").then((r) => sendResponse(r || { content: null }));
            return true;
        }
        if (msg && msg.type === "getProxyTransform") {
            const scripts = chromeBody.getTransformsForUrl(msg.url, null);
            // proxy tier is MV3-reserved; code omitted on MV2 (the MV2
            // service worker cannot intercept page-initiated loads)
            sendResponse({
                transforms: scripts.map((s) => ({
                    scriptId: s.scriptId,
                    name: s.meta.name,
                    code: "",
                })),
            });
            return false;
        }
        return false;
    });

    // ---- reload plumbing ----
    async function reload(): Promise<void> {
        const scripts = (await listScripts()) as ScriptWithSources[];
        const paramValues = await loadAllParamValues();
        dlogLevel("pipeline", "info", "reload", { total: scripts.length, enabled: scripts.filter((x) => x.enabled).map((x) => x.meta.name) });
        webRequestStrategy.reload(scripts, paramValues);
        chromeBody.reload(scripts, paramValues);
        void cdp.reload(scripts, paramValues);
        processStrategy.reload(scripts, paramValues);
        if (__MV3__) {
            // refresh the analyze cache NOW so the next page's getHookBundle
            // is served from it without waking the sandbox (keeps onDom
            // document_start as early as MV3 allows) + sync the proxy
            // tier's DNR redirect rules with the current script set
            void analyzeScripts(scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
            void syncProxyRules(scripts);
        }

        // HOT RELOAD: push the new bundle to every open tab's hook so
        // changes apply without reloading the target tab
        chrome.tabs.query({}, (tabs) => {
            for (const t of tabs) {
                if (t.id === undefined) continue;
                try {
                    chrome.tabs.sendMessage(t.id, { type: "bundleUpdate" }, () => void (chrome.runtime as any).lastError);
                } catch {}
            }
        });
    }

    const off = onScriptsChanged(() => void reload());
    // ownership moves between the process tier and the other tiers
    const offProcess = onProcessActiveChange(() => void reload());
    void reload();

    return {
        reload,
        chromeBody,
        cdp,
        dispose() {
            off();
            offProcess();
            if (!__MV3__) {
                const onDone = (details: any) => {
                    webRequestStrategy.pruneRequest?.(details.requestId);
                };
                chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
                chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders as any);
                chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived as any);
                chrome.webRequest.onCompleted.removeListener(onDone);
                chrome.webRequest.onErrorOccurred.removeListener(onDone);
            }
            webRequestStrategy.dispose();
            chromeBody.dispose();
        },
    };
}

