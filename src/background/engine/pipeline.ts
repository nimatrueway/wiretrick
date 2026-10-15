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
import { listScripts, onScriptsChanged, saveScript, deleteScript, setEnabled, newId, scriptStorageGet, scriptStorageSet, loadAllParamValues, getParamValues, setParamValue } from "./scriptStore";
import { compileScript, makeModuleResolver } from "../../shared/compile";
import { matchAny } from "../../shared/matcher";
import { serveStore } from "./strategies/webRequestStrategy";
import { dlogLevel } from "../../shared/debugLog";
import { isThenable } from "../../shared/compile";
import { toRunnableJs } from "../../shared/compile";
import "../../shared/transpile";
void toRunnableJs;
import { log } from "./logs";
import { serializeHandlers, type HandlerSources } from "../../shared/compile";
import { resolveParamValues } from "../../shared/scriptDef";

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
    updateTabBadge?: (tabId: number, url: string | undefined) => Promise<void>,
    noteRequestForBadge?: (tabId: number, url: string) => number
): Pipeline {
    const tabUrls = new Map<number, string>();

    // ---- tab URL tracking ----
    chrome.tabs.onUpdated.addListener((tabId, info) => {
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

    // ---- manager protocol ----
    chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
        if (msg && msg.type === "listScripts") {
            listScripts().then((scripts) => {
                // scripts saved before declareScript existed have no stored
                // paramDefs — compile them on the fly so the UI can offer ⚙
                sendResponse(
                    scripts.map((s) =>
                        s.paramDefs === undefined ? { ...s, paramDefs: compileScript(s.code).paramDefs || {} } : s
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
                // module registry so scripts' `import "./lib"` resolves here;
                // resolved libs ship with the bundle for the page-side require
                const overridesFor = (s: { id: string; name: string; code: string }) => ({
                    importModule: (spec: string) => resolver.resolve(spec),
                });
                const resolver = makeModuleResolver(
                    pageScripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
                    overridesFor
                );
                for (const s of pageScripts) {
                    if (!s.enabled || !matchAny(s.meta.match, msg.url || "")) continue;
                    const compiled = compileScript(s.code, { paramValues: await getParamValues(s.id), importModule: (spec) => resolver.resolve(spec) });
                    if (!compiled.meta.declared) continue; // library: inert on its own
                    if (compiled.handlers.onDom) {
                        // FULL transpiled source: the runner compiles it with
                        // a shim so top-level helpers/closures survive
                        domHandlers.push({
                            scriptId: s.id,
                            name: s.meta.name,
                            when: (compiled.handlers as any).onDomOptions?.when || "DOMContentLoaded",
                            src: toRunnableJs(s.code),
                            params: resolveParamValues(compiled.paramDefs || {}, await getParamValues(s.id)),
                        });
                    }
                }
                // ship the transitively imported library sources once
                for (const depName of resolver.deps) {
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
                const compiled = compileScript(s.code, { paramValues: await getParamValues(s.id) });
                sendResponse({
                    defs: compiled.paramDefs || {},
                    values: resolveParamValues(compiled.paramDefs || {}, await getParamValues(s.id)),
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
    void reload();

    return {
        reload,
        chromeBody,
        cdp,
        dispose() {
            off();
            chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
            chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders as any);
            chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived as any);
            chrome.webRequest.onCompleted.removeListener(onDone);
            chrome.webRequest.onErrorOccurred.removeListener(onDone);
            webRequestStrategy.dispose();
            chromeBody.dispose();
        },
    };
}

