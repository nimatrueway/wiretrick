/**
 * Wires the strategies into chrome.webRequest and background messaging.
 * This is the single place that touches MV2 webRequest APIs; everything
 * browser-specific below it lives in strategies/.
 */
import type { InterceptionStrategy } from "./strategies/types";
import type { PageStrategy } from "./strategies/pageStrategy";
import type { DebuggerStrategy } from "./strategies/debuggerStrategy";
import type { HelperStrategy } from "./strategies/helperStrategy";
import type { RulesStrategy } from "./strategies/rulesStrategy";
import { IS_FIREFOX, onHelperActiveChange, helperActive, strategyUnavailable } from "./strategies/helperState";
import type { HeaderChanges } from "./strategies/types";
import type { Script } from "./scriptStore";
import {
    listScripts, getScript, onScriptsChanged, saveScript, deleteScript, setEnabled, newId, scriptStorageGet, scriptStorageSet, loadAllParamValues, getParamValues, setParamValue,
    listDataFiles, getDataFile, saveDataFile, deleteDataFile, listFolders, createFolder, renameFolder, deleteFolder,
} from "./scriptStore";
import { loadDataFiles } from "./dataFiles";
import { serveStore } from "./strategies/extensionStrategy";
import { dlog, dlogLevel } from "../../shared/debugLog";
import { isThenable, toRunnableJs } from "../../shared/compile";
import "../../shared/transpile";
import { log, getScriptErrors, getScriptTypeErrors, getScriptRuleErrors, getScriptRouteWarnings, setScriptRouteWarnings, bodyObservedSince, bodySkipSince, noteBodySkip } from "./logs";
import { missedLine } from "../../shared/netTypes";
import { binaryOptedOut, frameHasHook as pingHook, isLoopbackUrl, missedReason, missedWhat, routeProblem, MISSED_SKIP_TYPES } from "../../shared/missedTap";
import { resolveParamValues } from "../../shared/scriptDef";
import type { ShippedLib } from "../../shared/scriptImports";
import { effectiveStrategy, hookCanSee, routeLabel, routeMatches, setDefaultStrategy, type RouteMeta, type Strategy } from "../../shared/route";
import { analyzeScripts, runBodyOp, type Analyzed } from "../compileHost";
import { recordNetBody } from "../network";
import { reportSkipped, setSkipRoutes } from "./skipped";
import { correlator } from "./requestCorrelator";
import { winnerOf } from "../../shared/precedence";
import { STRATEGY_KEY, TEXT_TYPES_KEY } from "../settingsFile";
import { getTextTypes, setTextTypes } from "../../shared/bodyKind";
import { packBytes, unpackBytes } from "../../shared/bytesPack";

const FILTER: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

/** an enabled script's body-handler route — checked by the "never ran" warning */
interface BodyWatch {
    id: string;
    name: string;
    route: RouteMeta;
    strategy: Strategy;
}
const MISSED_DELAY_MS = 1500;
/** the helper usually connects within this after a (service-worker) start */
const HELPER_GRACE_MS = 5000;

/** settings.defaultStrategy → route.ts default, settings.textTypes → bodyKind.ts (every reload and hook bundle) */
function loadDefaultStrategy(): Promise<void> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get([STRATEGY_KEY, TEXT_TYPES_KEY], (g: any) => {
                void (chrome.runtime as any).lastError;
                setDefaultStrategy(g?.[STRATEGY_KEY]);
                setTextTypes(g?.[TEXT_TYPES_KEY]);
                resolve();
            });
        } catch {
            resolve();
        }
    });
}

/** stored scripts with their meta replaced by the analyzed one (real params + imports) */
function withAnalyzedMeta(scripts: Script[], analyzed: Map<string, Analyzed>): Script[] {
    return scripts.map((s) => {
        const a = analyzed.get(s.id);
        return a ? { ...s, meta: { ...a.meta, name: s.meta.name } } : s;
    });
}

export interface Pipeline {
    reload(): Promise<void>;
    pageStrategy: PageStrategy;
    cdp: DebuggerStrategy;
    dispose(): void;
}

export function createPipeline(
    extensionStrategy: InterceptionStrategy & { reload(s: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void; matchingNames?(url: string): string[] },
    pageStrategy: PageStrategy,
    cdp: DebuggerStrategy,
    helperStrategy: HelperStrategy,
    rulesStrategy: RulesStrategy,
    updateTabBadge?: (tabId: number, url: string | undefined) => Promise<void>,
    noteRequestForBadge?: (tabId: number, url: string) => number,
    /** resolves once startup migrations ran — scripts aren't loaded before */
    ready: Promise<unknown> = Promise.resolve()
): Pipeline {
    const tabUrls = new Map<number, string>();

    // ---- tab URL tracking ----
    /** `${tabId}|${url}` page loads re-issued through the debugger (MV3) */
    const renavigated = new Set<string>();
    if (__MV3__ && (chrome as any).webNavigation) {
        // the page request usually leaves while the debugger is still
        // attaching; remember it so a missed GET can be re-issued
        const mainFrameSeen = new Map<number, { url: string; method: string }>();
        chrome.webRequest?.onBeforeRequest?.addListener(
            (d) => {
                if (d.type === "main_frame" && d.tabId >= 0) mainFrameSeen.set(d.tabId, { url: d.url, method: d.method });
            },
            { urls: ["<all_urls>"], types: ["main_frame"] }
        );
        // MV3 debugger strategy: attach BEFORE the navigation's subresources
        // load (webNavigation also wakes an idle service worker)
        chrome.webNavigation.onBeforeNavigate.addListener((d) => {
            if (d.frameId !== 0) return;
            const wasAttached = cdp.isTabAttached(d.tabId);
            void cdp.syncTab(d.tabId, d.url).then(async () => {
                if (wasAttached || !cdp.isTabAttached(d.tabId) || !cdp.debuggerScriptsFor(d.url).length) return;
                // let in-flight requestPaused / onBeforeRequest events land
                await new Promise((r) => setTimeout(r, 60));
                const seen = mainFrameSeen.get(d.tabId);
                if (!seen || seen.url !== d.url || cdp.wasPaused(d.tabId, d.url)) return;
                const key = `${d.tabId}|${d.url}`;
                // GET only: re-sending a form POST could repeat its side effect
                if (seen.method !== "GET" || renavigated.has(key)) return;
                renavigated.add(key);
                setTimeout(() => renavigated.delete(key), 10000);
                if (await cdp.renavigate(d.tabId, d.url)) {
                    log(d.tabId, `[debugger] page load ${d.url} left before the debugger attached — re-loaded it through the debugger so it is intercepted`, "info");
                }
            });
        });
        chrome.tabs.onRemoved.addListener((tabId) => mainFrameSeen.delete(tabId));
    }
    // ---- "onResponseBody never ran" ----
    // A body handler can silently not run: Chromium's webRequest can't read
    // bodies and the hook only sees page fetch/XHR, a cached load skips the
    // debugger, the helper is down… Once a matching request completes, warn
    // (attributed to the script) when none of its body handlers ran for it.
    let bodyWatch: BodyWatch[] = [];
    /** requestId → start time, only for requests a watched script matches */
    const watchedStarts = new Map<string, number>();
    /** `${tabId}|${url}` loads the debugger strategy warning below already reported */
    const cdpWarned = new Set<string>();
    const frameHasHook = (tabId: number, frameId?: number) => pingHook(chrome.tabs, () => chrome.runtime.lastError, tabId, frameId);
    const extOrigin = chrome.runtime.getURL("");
    const watchedFor = (url: string, method?: string, type?: string) => bodyWatch.filter((w) => routeMatches(w.route, url, method, type));
    const ownRequest = (d: any) => d.url.startsWith(extOrigin) || (d.initiator || d.originUrl || "").startsWith(extOrigin.replace(/\/$/, ""));
    // webRequest requestIds for the strategies' log lines, Network rows and the check below
    correlator.attach(chrome.webRequest);
    if (chrome.webRequest?.onBeforeRequest) {
        chrome.webRequest.onBeforeRequest.addListener(
            (d) => {
                if (d.tabId < 0 || MISSED_SKIP_TYPES.has(d.type) || !bodyWatch.length || !watchedFor(d.url, d.method, d.type).length) return;
                watchedStarts.set(d.requestId, d.timeStamp);
                if (watchedStarts.size > 500) watchedStarts.delete(watchedStarts.keys().next().value!);
            },
            { urls: ["<all_urls>"] }
        );
        chrome.webRequest.onErrorOccurred?.addListener((d) => void watchedStarts.delete(d.requestId), { urls: ["<all_urls>"] });
    }
    function checkMissed(d: chrome.webRequest.WebResponseCacheDetails): void {
        const start = watchedStarts.get(d.requestId);
        if (start === undefined) return;
        watchedStarts.delete(d.requestId);
        if (ownRequest(d)) return;
        // page onRequest routes: only the page's fetch/XHR (a matching document load isn't a miss)
        const routes = watchedFor(d.url, (d as any).method, d.type).filter((w) => w.route.kind !== "onRequest" || d.type === "xmlhttprequest");
        if (!routes.length) return;
        setTimeout(async () => {
            // per request: a same-URL request's skip/tap isn't this one's
            const bodySkip = bodySkipSince(d.url, start - 250, d.requestId);
            // the hook took it: the page may simply never read the body (unless it skipped a binary one)
            if (pageStrategy.isClaimed(d.url) && bodySkip?.strategy !== "page") return;
            const hookLoaded = d.type === "xmlhttprequest" && routes.some((w) => w.strategy === "page") ? await frameHasHook(d.tabId, d.frameId) : undefined;
            const done = new Set<string>();
            for (const w of routes) {
                if (done.has(w.id)) continue;
                done.add(w.id);
                if (bodyObservedSince(w.id, d.url, start - 250, d.requestId)) continue;
                // `binary: false` on every matching route: text only, by choice
                if (binaryOptedOut(bodySkip, w.strategy, routes.filter((r) => r.id === w.id).map((r) => r.route.binary))) continue;
                const reason = missedReason({
                    strategy: w.strategy,
                    type: d.type,
                    firefox: IS_FIREFOX,
                    mv3: __MV3__,
                    fromCache: !!d.fromCache,
                    helperActive: helperActive(),
                    cdpWarned: cdpWarned.has(`${d.tabId}|${d.url}`),
                    hookLoaded,
                    loopback: isLoopbackUrl(d.url),
                    bodySkip,
                });
                if (!reason) continue;
                log(d.tabId, missedLine(w.name, routeLabel(w.route), d.url, missedWhat(d.type), reason), "warn", w.id, "missed", d.url, d.requestId);
            }
        }, MISSED_DELAY_MS);
    }

    // ---- up-front: handlers that can't run where they are (Problems view, not the Log) ----
    let helperTimer: ReturnType<typeof setTimeout> | undefined;
    /** the current route warnings (Problems view): scriptId → "<handler>: <why>", one per handler */
    let routeNow = new Map<string, string[]>();
    /** helper-down warnings, once their grace period has passed: scriptId → one per handler */
    let helperNow = new Map<string, string[]>();
    function publishRouteWarnings(): void {
        const all = new Map<string, string[]>();
        for (const [id, w] of routeNow) all.set(id, [...w]);
        for (const [id, w] of helperNow) all.set(id, [...(all.get(id) || []), ...w]);
        void setScriptRouteWarnings(all);
    }
    function warnRoutes(scripts: Script[]): void {
        const problems: { id: string; msg: string }[] = [];
        const helperDown: { id: string; name: string; labels: string[] }[] = [];
        for (const s of scripts) {
            if (!s.enabled || !s.meta.active) continue;
            const down: string[] = [];
            for (const r of s.meta.routes || []) {
                if (r.kind === "onDocument") continue;
                const strategy = effectiveStrategy(r);
                const msg = routeProblem({ kind: r.kind, strategy, resourceTypes: r.resourceTypes }, { firefox: IS_FIREFOX, mv3: __MV3__ });
                // one warning per handler: each points at its own line
                if (msg) problems.push({ id: s.id, msg: `${routeLabel(r)}: ${msg}` });
                else if (strategy === "helper" && strategyUnavailable("helper")) down.push(routeLabel(r));
            }
            if (down.length) helperDown.push({ id: s.id, name: s.meta.name, labels: down });
        }
        routeNow = new Map();
        for (const p of problems) routeNow.set(p.id, [...(routeNow.get(p.id) || []), p.msg]);
        if (helperTimer) clearTimeout(helperTimer);
        const stillDown = new Set(helperDown.map((h) => h.id));
        helperNow = new Map([...helperNow].filter(([id]) => stillDown.has(id)));
        publishRouteWarnings();
        if (!helperDown.length) return;
        // the helper may only now be (re)starting: give every reload a grace
        // period, and keep waiting while it is still connecting
        const check = (): void => {
            helperTimer = undefined;
            if (helperActive()) return;
            const st = helperStrategy.status();
            if (st.state === "connecting" || (st.state === "ready" && !st.routing?.reason)) {
                helperTimer = setTimeout(check, HELPER_GRACE_MS);
                return;
            }
            const why = `strategy "helper" — ${strategyUnavailable("helper")}; these handlers don't run until it is`;
            for (const h of helperDown) helperNow.set(h.id, h.labels.map((l) => `${l}: ${why}`));
            publishRouteWarnings();
        };
        helperTimer = setTimeout(check, HELPER_GRACE_MS);
    }

    function refreshBodyWatch(scripts: Script[]): void {
        const next: BodyWatch[] = [];
        for (const s of scripts) {
            if (!s.enabled || !s.meta.active) continue;
            for (const r of s.meta.routes || []) {
                const strategy = effectiveStrategy(r);
                // onRequest: only "page" routes — the hook claims every request it handles, so an unclaimed one in a hook-less tab was missed
                if (r.kind === "onResponseBody" || r.kind === "replaceResponse" || (r.kind === "onRequest" && strategy === "page")) next.push({ id: s.id, name: s.meta.name, route: r, strategy });
            }
        }
        bodyWatch = next;
    }

    if (chrome.webRequest?.onCompleted) {
        chrome.webRequest.onCompleted.addListener((d) => checkMissed(d), { urls: ["<all_urls>"] });
        // observe-only (MV3-legal): a debugger strategy load that left before
        // the tab's debugger attached is NOT intercepted — say so instead of
        // failing silently. Typical: the page itself on a first visit (MV2
        // attaches only once the navigation has started; MV3 after a cold
        // service-worker start or a very fast navigation).
        const neverPaused = new Set(["xmlhttprequest", "websocket", "ping", "csp_report", "webbundle", "webtransport"]);
        chrome.webRequest.onCompleted.addListener(
            (d) => {
                if (d.tabId < 0 || neverPaused.has(d.type)) return;
                const names = cdp.debuggerScriptsFor(d.url);
                if (!names.length) return;
                // any pause (request or response stage) precedes completion
                setTimeout(() => {
                    if (cdp.wasPaused(d.tabId, d.url) || renavigated.has(`${d.tabId}|${d.url}`)) return;
                    const what = d.type === "main_frame" ? "page load" : d.type;
                    const hint = __MV3__ ? "Reload the tab (it stays attached from now on)." : "Reload the tab within a few seconds (the debugger detaches when the page goes idle).";
                    cdpWarned.add(`${d.tabId}|${d.url}`);
                    setTimeout(() => cdpWarned.delete(`${d.tabId}|${d.url}`), 10000);
                    log(d.tabId, `[debugger] ${what} ${d.url}${d.fromCache ? " (from cache)" : ""} was NOT intercepted by ${names.map((n) => `"${n}"`).join(", ")} — it loaded before the debugger attached to this tab. ${hint}`, "warn");
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
            if (cdp.shouldAttach(info.url)) {
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
        pageStrategy.forgetTab(tabId);
        cdp.forgetTab(tabId);
        helperStrategy.forgetTab(tabId);
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
    /** requestId → first URL of requests a extension-strategy script matched (diagnostics) */
    const traced = new Map<string, { url: string; tabId: number; at: number }>();
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
            if (cdp.hasOwners()) {
                void cdp.ensureWorkerAttached(details.url);
            }
        } else {
            const n = noteRequestForBadge?.(details.tabId, details.url);
            if (n !== undefined && n > 0) void updateTabBadge?.(details.tabId, details.url);
        }

        const disposition = extensionStrategy.handleBeforeRequest(details, tabUrl);
        if (!traced.has(details.requestId) && extensionStrategy.matchingNames?.(details.url).length) {
            traced.set(details.requestId, { url: details.url, tabId: details.tabId, at: Date.now() });
            if (traced.size > 500) traced.delete(traced.keys().next().value as string);
        }

        // Firefox: blocking listeners accept promises — pass straight through
        if (isThenable(disposition)) {
            return disposition.then((d: any) => this2.applyDisposition(d, details));
        }

        // MV2: a cdp-owned route matches — make sure the debugger is on this tab
        return this2.applyDisposition(disposition.kind === "allow" && cdp.needs(details) ? { kind: "needsCdp" } : disposition, details);
    };

    const this2 = {
        applyDisposition,
    };

    function applyDisposition(disposition: any, details: any): any {
        switch (disposition.kind) {
            case "redirect": {
                log(details.tabId, `redirected ${details.url} → ${disposition.url}`, "info");
                return { redirectUrl: disposition.url };
            }
            case "cancel": {
                log(details.tabId, `blocked ${details.url}`, "info");
                return { cancel: true };
            }
            case "needsCdp": {
                dlogLevel("pipeline", "debug", "needsCdp → attach", { url: details.url, tabId: details.tabId });
                // banner minimization: this tab is actively using the debugger
                cdp.cancelIdleDetach(`tab:${details.tabId}`);
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
            extensionStrategy.handleBeforeSendHeaders(details, tabUrl) ||
            pageStrategy.handleBeforeSendHeaders(details, tabUrl);
        if (isThenable(changes)) {
            return changes.then((c: any) => (c ? { requestHeaders: applyHeaderChanges(details.requestHeaders || [], c) } : {}));
        }
        if (!changes) return {};
        return { requestHeaders: applyHeaderChanges(details.requestHeaders || [], changes) };
    };

    const onHeadersReceived = (details: any) => {
        const tabUrl = tabUrlFor(details.tabId, details.url);
        const changes =
            extensionStrategy.handleHeadersReceived(details, tabUrl) ||
            pageStrategy.handleHeadersReceived(details, tabUrl);
        if (isThenable(changes)) {
            return changes.then((c: any) => (c ? { responseHeaders: applyHeaderChanges(details.responseHeaders || [], c) } : {}));
        }
        if (!changes) return {};
        return { responseHeaders: applyHeaderChanges(details.responseHeaders || [], changes) };
    };

    if (!__MV3__) {
        // MV2-only: blocking webRequest is the extension strategy's dispatch path. MV3
        // forbids "blocking" — the page strategy (below) carries interception.
        const addBlocking = (event: string, fn: any, extra: string[]) => {
            try {
                try {
                    // Chrome hides Cookie/Referer/Accept-Language/Set-Cookie from header listeners without it
                    (chrome.webRequest as any)[event].addListener(fn, FILTER, extra);
                } catch (e) {
                    // Firefox rejects "extraHeaders"
                    if (!extra.includes("extraHeaders")) throw e;
                    extra = extra.filter((s) => s !== "extraHeaders");
                    (chrome.webRequest as any)[event].addListener(fn, FILTER, extra);
                }
                dlogLevel("extension", "debug", `${event} listener registered (${extra.join(", ")})`);
            } catch (e: any) {
                // e.g. a browser build that dropped MV2 blocking webRequest
                log(-1, `[extension] cannot register blocking ${event} listener — the "extension" strategy is inactive in this browser: ${e?.message || e}`, "error");
            }
        };
        addBlocking("onBeforeRequest", onBeforeRequest, ["blocking"]);
        addBlocking("onBeforeSendHeaders", onBeforeSendHeaders, ["requestHeaders", "blocking", "extraHeaders"]);
        addBlocking("onHeadersReceived", onHeadersReceived, ["responseHeaders", "blocking", "extraHeaders"]);

        // per-request caches must not leak for requests that never reach the
        // response-header phase
        const onDone = (details: any) => {
            extensionStrategy.pruneRequest?.(details.requestId);
        };
        chrome.webRequest.onCompleted.addListener(onDone, FILTER);
        chrome.webRequest.onErrorOccurred.addListener(onDone, FILTER);

        // diagnostics: what the browser did with requests a extension-strategy
        // script matched (LOG panel at logLevel: debug; failures as warn)
        const tr = (details: any, msg: string, level: "debug" | "warn" = "debug") => {
            const t = traced.get(details.requestId);
            if (!t) return;
            log(details.tabId, `[extension] ${msg}${details.url !== t.url ? ` (originally ${t.url})` : ""}`, level);
        };
        chrome.webRequest.onBeforeRedirect.addListener(
            (d: any) => tr(d, `browser followed redirect ${d.url} → ${d.redirectUrl} (status ${d.statusCode}${d.fromCache ? ", from cache" : ""})`),
            FILTER
        );
        chrome.webRequest.onResponseStarted.addListener(
            (d: any) => tr(d, `response started ${d.statusLine || d.statusCode} ${d.url}${d.fromCache ? " (from cache)" : ""}${d.ip ? ` ip=${d.ip}` : ""}`),
            FILTER
        );
        chrome.webRequest.onCompleted.addListener((d: any) => {
            tr(d, `completed ${d.statusCode} ${d.url}${d.fromCache ? " (from cache)" : ""}`);
            traced.delete(d.requestId);
        }, FILTER);
        chrome.webRequest.onErrorOccurred.addListener((d: any) => {
            tr(d, `request FAILED ${d.error} ${d.type} ${d.url}`, "warn");
            traced.delete(d.requestId);
        }, FILTER);
        // another extension's conflicting change won (e.g. two copies of
        // Wiretrick, or an ad blocker redirecting the same request)
        (chrome.webRequest as any).onActionIgnored?.addListener((d: any) => {
            const t = traced.get(d.requestId);
            log(t?.tabId ?? -1, `[extension] the browser IGNORED this extension's "${d.action}"${t ? ` for ${t.url}` : ""} — another extension's change to the same request took precedence (disable other request-modifying extensions, e.g. a second Wiretrick install)`, "warn");
        });
    } else {
        dlog("pipeline", "MV3: no blocking webRequest — the page strategy carries page fetch/XHR; the debugger or helper strategy carries browser-initiated loads");
    }

    // ---- manager protocol ----
    chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
        if (msg && msg.type === "listScripts") {
            listScripts().then(async (scripts) => {
                // scripts saved before params existed have no stored
                // paramDefs — compile them on the fly so the UI can offer ⚙
                // (with every script: imported param definitions resolve)
                const missing = scripts.some((s) => s.paramDefs === undefined);
                const analyzed = missing ? await analyzeScripts(scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })), await loadAllParamValues()) : new Map<string, Analyzed>();
                const errors = await getScriptErrors();
                const typeErrors = await getScriptTypeErrors();
                const ruleErrors = await getScriptRuleErrors();
                const routeWarnings = await getScriptRouteWarnings();
                sendResponse(
                    scripts.map((s) => ({
                        ...s,
                        paramDefs: s.paramDefs === undefined ? analyzed.get(s.id)?.paramDefs || {} : s.paramDefs,
                        runtimeError: errors.get(s.id) ?? null,
                        typeErrors: typeErrors.get(s.id) ?? [],
                        ruleErrors: ruleErrors.get(s.id) ?? [],
                        routeWarnings: routeWarnings.get(s.id) ?? [],
                    }))
                );
            });
            return true;
        }
        if (msg && msg.type === "saveScript") {
            void (async () => {
                // optimistic concurrency: the editor sends the text it loaded;
                // refuse when the stored copy has moved on since
                if (typeof msg.base === "string" && msg.id) {
                    const cur = await getScript(msg.id);
                    if (!cur) return { conflict: "deleted" };
                    if (cur.code !== msg.base && cur.code !== msg.code) return { conflict: "changed", code: cur.code };
                }
                return saveScript({
                id: msg.id || newId(),
                code: msg.code,
                name: msg.name,
                    enabled: msg.enabled,
                });
            })()
                .then((s) => sendResponse(s))
                .catch((e) => sendResponse({ error: String(e) }));
            return true;
        }
        // data files and folders (the Editor's explorer); changes notify like
        // script changes (chrome.storage resDataFiles / resFolders)
        if (msg && msg.type === "listDataFiles") {
            listDataFiles().then((files) => sendResponse(files));
            return true;
        }
        if (msg && msg.type === "listFolders") {
            listFolders().then((folders) => sendResponse(folders));
            return true;
        }
        if (msg && msg.type === "saveDataFile") {
            void (async () => {
                // optimistic concurrency like saveScript: `base` is the text the editor loaded
                if (typeof msg.base === "string" && msg.id) {
                    const cur = await getDataFile(msg.id);
                    if (!cur) return { conflict: "deleted" };
                    if (cur.text !== msg.base && cur.text !== msg.text) return { conflict: "changed", text: cur.text };
                }
                return saveDataFile({ id: msg.id, path: msg.path, text: msg.text });
            })()
                .then((d) => sendResponse(d))
                .catch((e) => sendResponse({ error: String(e?.message || e) }));
            return true;
        }
        if (msg && msg.type === "renameDataFile") {
            saveDataFile({ id: msg.id, path: msg.path })
                .then((d) => sendResponse(d))
                .catch((e) => sendResponse({ error: String(e?.message || e) }));
            return true;
        }
        if (msg && msg.type === "deleteDataFile") {
            deleteDataFile(msg.id).then(() => sendResponse({}));
            return true;
        }
        if (msg && (msg.type === "createFolder" || msg.type === "renameFolder" || msg.type === "deleteFolder")) {
            const op = msg.type === "createFolder" ? createFolder(msg.path) : msg.type === "renameFolder" ? renameFolder(msg.from, msg.to) : deleteFolder(msg.path);
            (op as Promise<unknown>)
                .then((r) => sendResponse(r ?? {}))
                .catch((e) => sendResponse({ error: String(e?.message || e) }));
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
            pageStrategy.claimRequest(msg.url);
            sendResponse({});
            return false;
        }
        if (msg && msg.type === "getHookBundle") {
            void (async () => {
                // Network handlers run in the background (the hook is
                // eval-free and immune to page CSP): the page gets only the
                // ROUTES of hook-owned handlers, so it touches fetch/XHR to
                // those and leaves everything else native. onDocument handlers
                // need the page's window: their scripts' FULL sources ship
                // (top-level helpers/closures survive), compiled in the MAIN
                // world when the page CSP allows, else in the bridge.
                const url = msg.url || "";
                const domHandlers: { scriptId: string; name: string; src: string; params: Record<string, any> }[] = [];
                const libs = new Map<string, ShippedLib>();
                const routes: RouteMeta[] = [];
                await ready;
                await loadDefaultStrategy();
                const pageScripts = await listScripts();
                const paramValues = await loadAllParamValues();
                // MV3: analyzed in the sandbox page (the SW can't eval),
                // cached; MV2 compiles right here
                const analyzed = await analyzeScripts(pageScripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })), paramValues);
                const depNames = new Set<string>();
                for (const s of pageScripts) {
                    const a = analyzed.get(s.id);
                    if (!s.enabled || !a || a.error || !a.meta.active) continue;
                    let dom = false;
                    for (const r of a.meta.routes) {
                        if (r.kind === "onDocument") dom ||= routeMatches(r, url);
                        else if (r.kind !== "onResponseHeaders" && effectiveStrategy(r) === "page" && hookCanSee(r)) routes.push(r);
                    }
                    if (!dom) continue;
                    for (const d of a.deps) depNames.add(d);
                    domHandlers.push({ scriptId: s.id, name: s.meta.name, src: toRunnableJs(s.code), params: resolveParamValues(a.paramDefs || {}, paramValues[s.id]) });
                }
                // ship the transitively imported library sources (and data files) once
                const dataFiles = depNames.size ? await listDataFiles() : [];
                for (const depName of depNames) {
                    const lib = pageScripts.find((x) => x.meta.name === depName);
                    const data = !lib && dataFiles.find((d) => d.path === depName);
                    if (data && !libs.has(data.path)) libs.set(data.path, { name: data.path, json: data.text });
                    if (!lib || libs.has(lib.meta.name)) continue;
                    const defs = analyzed.get(lib.id)?.paramDefs || {};
                    libs.set(lib.meta.name, { name: lib.meta.name, src: toRunnableJs(lib.code), params: resolveParamValues(defs, paramValues[lib.id]) });
                }
                dlogLevel("pipeline", "debug", "getHookBundle responding", { routes: routes.length, dom: domHandlers.length, url });
                sendResponse({ count: routes.length, routes, textTypes: getTextTypes(), domHandlers, libs: [...libs.values()] });
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
                // analyze with all scripts so the module resolver sees imported libraries
                // (and the stored values: params may be declared conditionally)
                const analyzed = await analyzeScripts(scripts.map((x) => ({ id: x.id, name: x.meta.name, code: x.code, updatedAt: x.updatedAt })), await loadAllParamValues());
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
        // page strategy (page fetch/XHR) — bodies recorded for the Network tab
        if (msg && msg.type === "runRequestDecision") {
            dlogLevel("pipeline", "debug", `runRequestDecision ${msg.url}`);
            const tabId = sender?.tab?.id ?? -1;
            const method = msg.method || "GET";
            pageStrategy.runRequestDecision(msg.url, method, tabId).then((r) => {
                reportSkipped(tabId, { url: msg.url, method, type: "xmlhttprequest" }, winnerOf(r, "page"));
                if (r?.kind === "respond") recordNetBody({ tabId, url: msg.url, method, modified: r.content, mime: r.mime, status: r.status || 200 });
                sendResponse(r || null);
            });
            return true;
        }
        if (msg && msg.type === "runTransform") {
            const tabId = sender?.tab?.id ?? -1;
            const method = msg.method || "GET";
            // the bridge packs binary bodies (runtime messaging is JSON)
            const original = unpackBytes(msg.body);
            // the response is in: its webRequest request has started (onRequest/replace ran before it, by URL)
            const requestId = correlator.claim("page", method, msg.url, { tabId })?.requestId;
            pageStrategy.runTransform(msg.url, method, original || "", { status: msg.status, contentType: msg.contentType, requestId }, tabId).then((body) => {
                recordNetBody({ tabId, url: msg.url, method, original: original ?? "", modified: body, requestId });
                sendResponse(packBytes({ body }));
            });
            return true;
        }
        if (msg && msg.type === "bodySkip") {
            const requestId = correlator.claim("page", msg.method || "GET", msg.url, { tabId: sender?.tab?.id ?? -1 })?.requestId;
            noteBodySkip("page", msg.url, msg.why || "binary", msg.contentType || "", requestId);
            sendResponse({});
            return false;
        }
        if (msg && msg.type === "runReplace") {
            const tabId = sender?.tab?.id ?? -1;
            const method = msg.method || "GET";
            pageStrategy.runReplace(msg.url, method, tabId).then((r) => {
                reportSkipped(tabId, { url: msg.url, method, type: "xmlhttprequest" }, winnerOf(r, "page"));
                if (r) recordNetBody({ tabId, url: msg.url, method, modified: r.content, mime: r.mime, status: 200 });
                sendResponse(r || { content: null });
            });
            return true;
        }
        return false;
    });

    // ---- reload plumbing ----
    let reloadSeq = 0;
    async function reload(): Promise<void> {
        const seq = ++reloadSeq;
        await ready;
        await loadDefaultStrategy();
        await loadDataFiles();
        const stored = await listScripts();
        const paramValues = await loadAllParamValues();
        // routes come from running each script's top level with its real
        // params and imports (stored meta had imports stubbed). MV3: this
        // also warms the analyze cache so the next getHookBundle is served
        // without waking the sandbox (keeps onDocument document_start early).
        let scripts = stored;
        try {
            scripts = withAnalyzedMeta(stored, await analyzeScripts(stored.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })), paramValues));
        } catch (e: any) {
            dlogLevel("pipeline", "warn", `script analysis failed, using saved routes: ${e?.message || e}`);
        }
        if (seq !== reloadSeq) return; // superseded by a newer reload
        dlog("pipeline", "reload", { total: scripts.length, enabled: scripts.filter((x) => x.enabled).map((x) => x.meta.name) });
        extensionStrategy.reload(scripts, paramValues);
        pageStrategy.reload(scripts, paramValues);
        cdp.reload(scripts, paramValues);
        helperStrategy.reload(scripts, paramValues);
        void rulesStrategy.reload(scripts, paramValues);
        refreshBodyWatch(scripts);
        setSkipRoutes(scripts);
        warnRoutes(scripts);

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
    // ownership moves between the helper strategy and the other strategies
    const offProcess = onHelperActiveChange(() => void reload());
    // settings.defaultStrategy moves ownership between strategies
    const onStorage = (changes: Record<string, unknown>, area: string) => {
        if (area === "local" && (changes[STRATEGY_KEY] || changes[TEXT_TYPES_KEY])) void reload();
    };
    chrome.storage.onChanged.addListener(onStorage);
    void reload();

    return {
        reload,
        pageStrategy,
        cdp,
        dispose() {
            off();
            offProcess();
            chrome.storage.onChanged.removeListener(onStorage);
            if (!__MV3__) {
                const onDone = (details: any) => {
                    extensionStrategy.pruneRequest?.(details.requestId);
                };
                chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
                chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders as any);
                chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived as any);
                chrome.webRequest.onCompleted.removeListener(onDone);
                chrome.webRequest.onErrorOccurred.removeListener(onDone);
            }
            extensionStrategy.dispose();
            pageStrategy.dispose();
        },
    };
}

