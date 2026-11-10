/**
 * Wires the strategies into chrome.webRequest and background messaging.
 * This is the single place that touches MV2 webRequest APIs; everything
 * browser-specific below it lives in strategies/.
 */
import { beginBusy } from "./busy";
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
import { analyzePackage, applyPending, checkPackages, dismissPending, forgetPackage, installPackage, listPackages, offerPackage, rollbackPackage, setAutoUpdate } from "./packages";
import { loadPackages, packagesSnapshot, requestPackages, resolveVersion } from "./packageImports";
import { isUrlSpec, packageClosure } from "../../shared/packageImports";
import { serveStore } from "./strategies/extensionStrategy";
import { dlog, dlogLevel } from "../../shared/debugLog";
import { isThenable, rulesProblems, siteProblems, toRunnableJs } from "../../shared/compile";
import "../../shared/transpile";
import { log, noteRan, getScriptErrors, getScriptTypeErrors, getScriptRuleErrors, getScriptRouteWarnings, setScriptRouteWarnings, bodyObservedSince, bodySkipSince, noteBodySkip } from "./logs";
import { bypassed } from "./bypass";
import { prepareStores, storeOwner } from "./stores";
import { ensureBuiltins, needsReact } from "../../shared/builtins";
import { missedLine } from "../../shared/netTypes";
import { binaryOptedOut, frameHasHook as pingHook, isLoopbackUrl, missedReason, missedWhat, routeProblem, MISSED_SKIP_TYPES } from "../../shared/missedTap";
import { resolveParamValues } from "../../shared/scriptDef";
import type { ShippedLib } from "../../shared/scriptImports";
import { effectiveStrategy, hookCanSee, isNetKind, pageWorld, routeLabel, routeMatches, takesBinary, type RouteMeta, type Strategy } from "../../shared/route";
import { analyzeScripts, runBodyOp, type Analyzed } from "../compileHost";
import { recordNetBody } from "../network";
import { reportSkipped, setSkipRoutes } from "./skipped";
import { correlator } from "./requestCorrelator";
import { winnerOf } from "../../shared/precedence";
import { targetsWebSocket, WS_BLIND, wsUnseen } from "../../shared/websocketLimits";
import { TEXT_TYPES_KEY } from "../settingsFile";
import { getTextTypes, setTextTypes } from "../../shared/bodyKind";
import { packBytes, unpackBytes } from "../../shared/bytesPack";
import type { RequestBody } from "../../shared/requestBody";
import { pushBundleUpdate } from "./bridgePorts";
import { installPages, pages, pagesReady } from "./pages";
import { pushIsoUpdate, pushPreviewUpdate, revalidateOverlayLinks, setupOverlayLinks, type IsoRun, type OverlayRun } from "./overlayLinks";
import { onUserScriptsStatus, syncUserScripts, userScriptsStatus, type IsoScript } from "../userScripts";
import { USER_SCRIPTS_OFF, userScriptsProblem, type UserScriptsStatus } from "../../shared/userScriptsStatus";
import { contentHash } from "../../shared/folderSync";
import { reactChunkSource } from "../reactChunk";

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

/** the page strategy's ctx.requestBody (the bridge packs bytes; anything else → undefined) */
function pageRequestBody(msg: any): RequestBody | undefined {
    const b = unpackBytes(msg?.requestBody);
    return typeof b === "string" || b instanceof Uint8Array ? b : undefined;
}

/** settings.textTypes → bodyKind.ts (every reload and hook bundle) */
function loadTextTypes(): Promise<void> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get([TEXT_TYPES_KEY], (g: any) => {
                void (chrome.runtime as any).lastError;
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
    noteRequestForBadge?: (tabId: number, url: string, newPage?: boolean) => number
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
    /** debugger/page routes aimed at WebSockets: those strategies never see the handshake */
    let wsBlind: BodyWatch[] = [];
    const wsWarned = new Set<string>();
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
                // badge: a main-frame navigation starts the tab's active-script set
                // over, then every request (page + resources) accumulates matches
                if (d.tabId >= 0 && d.type === "main_frame") {
                    noteRequestForBadge?.(d.tabId, d.url, true);
                    void updateTabBadge?.(d.tabId, d.url);
                } else if (d.tabId >= 0) noteRequestForBadge?.(d.tabId, d.url);
                if (d.type === "websocket" && wsBlind.length) {
                    for (const w of wsBlind) {
                        const key = `${w.id}|${w.route.kind}|${w.route.index}|${d.url}`;
                        if (wsWarned.has(key) || !routeMatches(w.route, d.url, d.method, d.type)) continue;
                        wsWarned.add(key);
                        if (wsWarned.size > 200) wsWarned.delete(wsWarned.values().next().value!);
                        log(d.tabId, wsUnseen(w.name, routeLabel(w.route), w.strategy, d.url), "warn", w.id, "missed", d.url, d.requestId);
                    }
                }
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
            const helperStatus = helperStrategy.status();
            for (const first of routes) {
                if (done.has(first.id)) continue;
                done.add(first.id);
                if (bodyObservedSince(first.id, d.url, start - 250, d.requestId)) continue;
                const own = routes.filter((r) => r.id === first.id);
                // `binary: false` on every matching route: text only, by choice
                if (binaryOptedOut(bodySkip, first.strategy, own.map((r) => r.route.binary))) continue;
                // a skipped binary body: name the route that wanted it
                const binaryRoute = bodySkip?.why === "binary" ? own.find((r) => r.strategy === bodySkip.strategy && takesBinary(r.route)) : undefined;
                const w = binaryRoute ?? first;
                const reason = missedReason({
                    takesBinary: !!binaryRoute,
                    helperOutdated: helperStatus.outdated ? helperStatus.version : undefined,
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
    function warnRoutes(scripts: Script[], userScripts: UserScriptsStatus = "ok"): void {
        const problems: { id: string; msg: string }[] = [];
        const helperDown: { id: string; name: string; labels: string[] }[] = [];
        for (const s of scripts) {
            if (!s.enabled) continue;
            if (!s.meta.active) continue;
            const down: string[] = [];
            for (const msg of siteProblems(s.code, s.meta.routes || [])) problems.push({ id: s.id, msg });
            for (const msg of rulesProblems(s.code, s.meta.routes || [])) problems.push({ id: s.id, msg });
            for (const r of s.meta.routes || []) {
                // Chrome MV3: isolated onPage code needs chrome.userScripts (an error, see problems.ts)
                if (userScripts !== "ok" && r.kind === "onDocument" && pageWorld(r) === "isolated") problems.push({ id: s.id, msg: userScriptsProblem(routeLabel(r), userScripts, chrome.runtime.id) });
                if (!isNetKind(r.kind)) continue;
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
        const blind: BodyWatch[] = [];
        for (const s of scripts) {
            if (!s.enabled || !s.meta.active) continue;
            for (const r of s.meta.routes || []) {
                const strategy = effectiveStrategy(r);
                if (isNetKind(r.kind) && WS_BLIND.has(strategy) && targetsWebSocket(r)) blind.push({ id: s.id, name: s.meta.name, route: r, strategy });
                // onRequest: only "page" routes — the hook claims every request it handles, so an unclaimed one in a hook-less tab was missed
                if (r.kind === "onResponseBody" || r.kind === "replaceResponse" || (r.kind === "onRequest" && strategy === "page")) next.push({ id: s.id, name: s.meta.name, route: r, strategy });
            }
        }
        bodyWatch = next;
        wsBlind = blind;
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
        if (bypassed(details, `wr:${details.requestId}`)) return {};
        const tabUrl = tabUrlFor(details.tabId, details.url);
        dlogLevel("pipeline", "debug", "onBeforeRequest", { url: details.url, type: details.type, tabId: details.tabId });

        // let the CDP strategy ensure attachment for main frames
        if (details.type === "main_frame" && tabUrl !== null) {
            void cdp.ensureAttached(details.tabId, details.url);
        }
        // workers/service-workers can't host the hook — sweep their
        // targets so respond-with-status works for worker fetches too
        if (details.type === "main_frame" && cdp.hasOwners()) {
            void cdp.ensureWorkerAttached(details.url);
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
        if (bypassed(details, `wr:${details.requestId}`)) return {};
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
        if (bypassed(details, `wr:${details.requestId}`)) return {};
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
                    // Firefox rejects "extraHeaders"; "requestBody" (ctx.requestBody) is optional too
                    const optional = ["extraHeaders", "requestBody"];
                    if (!extra.some((s) => optional.includes(s))) throw e;
                    extra = extra.filter((s) => !optional.includes(s));
                    (chrome.webRequest as any)[event].addListener(fn, FILTER, extra);
                }
                dlogLevel("extension", "debug", `${event} listener registered (${extra.join(", ")})`);
            } catch (e: any) {
                // e.g. a browser build that dropped MV2 blocking webRequest
                log(-1, `[extension] cannot register blocking ${event} listener — the "extension" strategy is inactive in this browser: ${e?.message || e}`, "error");
            }
        };
        addBlocking("onBeforeRequest", onBeforeRequest, ["blocking", "requestBody"]);
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
    /**
     * What a page's hook and bridge get (getHookBundle), for `url`. Network
     * handlers run in the background (the hook is eval-free and immune to
     * page CSP): the page gets only the ROUTES of hook-owned handlers, so it
     * touches fetch/XHR to those and leaves everything else native. onPage
     * handlers need the page's window: their scripts' FULL sources ship
     * (top-level helpers/closures survive), compiled in the MAIN world when
     * the page CSP allows, else in the bridge. Overlays (top frame only)
     * ship as routes and a code hash; their code goes to the overlay frame
     * over the bridge's port (`overlayRuns`, overlayLinks.ts).
     *
     * `preview` (the Editor's Preview tab): only that script's overlay,
     * with every onOverlay route — matching `url` or not, enabled or not.
     */
    async function hookBundle(url: string, top: boolean, preview?: string) {
        // onSite scripts (hook.ts; the bridge when CSP blocks eval)
        // `v`: the onSite code's version — onPage code tags its calls with it, and the hook waits for that version (hook.ts answerCall)
        const domHandlers: { scriptId: string; name: string; src: string; params: Record<string, any>; v: string }[] = [];
        // onPage scripts: never shipped to the page's own world. MV3 runs
        // them in chrome.userScripts worlds that load the code from the owner
        // (`isoRuns`): the bridge only learns which scripts, to relay the
        // overlay's calls
        const isoHandlers: (typeof domHandlers[number] | { scriptId: string; name: string })[] = [];
        const isoRuns = new Map<string, IsoRun>();
        // onOverlay routes only — overlay code never goes through the page
        const overlays: { scriptId: string; name: string; routes: RouteMeta[]; codeHash: string }[] = [];
        const overlayRuns = new Map<string, OverlayRun>();
        const overlayDeps = new Map<string, Set<string>>();
        const routes: RouteMeta[] = [];
        await loadTextTypes();
        const pageScripts = await listScripts();
        const paramValues = await loadAllParamValues();
        // MV3: analyzed in the sandbox page (the SW can't eval),
        // cached; MV2 compiles right here
        const analyzed = await analyzeScripts(pageScripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })), paramValues);
        const mainDeps = new Set<string>();
        const isoDeps = new Set<string>();
        const isoScriptDeps = new Map<string, Set<string>>();
        let previewWhy = "no such script";
        for (const s of pageScripts) {
            const a = analyzed.get(s.id);
            if (preview !== undefined) {
                if (s.id !== preview) continue;
                previewWhy = !a || a.error ? "the script doesn't compile" : "the script has no overlay handler (wt.onOverlay)";
            } else if (!s.enabled) continue;
            if (!a || a.error || !a.meta.active) continue;
            let main = false;
            let iso = false;
            const over: RouteMeta[] = [];
            for (const r of a.meta.routes) {
                if (r.kind === "onDocument") {
                    if (!routeMatches(r, url)) continue;
                    if (pageWorld(r) === "isolated") iso = true;
                    else main = true;
                } else if (r.kind === "onOverlay") {
                    if (preview !== undefined || (top && routeMatches(r, url))) over.push(r);
                } else if (r.kind !== "onResponseHeaders" && effectiveStrategy(r) === "page" && hookCanSee(r)) routes.push(r);
            }
            if (over.length) {
                overlays.push({ scriptId: s.id, name: s.meta.name, routes: over, codeHash: "" });
                overlayRuns.set(s.id, { name: s.meta.name, code: toRunnableJs(s.code), routes: over, params: resolveParamValues(a.paramDefs || {}, paramValues[s.id]), libs: [], react: false, codeHash: "" });
                overlayDeps.set(s.id, new Set(a.deps));
            }
            if (!main && !iso || preview !== undefined) continue;
            const src = toRunnableJs(s.code);
            const params = resolveParamValues(a.paramDefs || {}, paramValues[s.id]);
            const h = { scriptId: s.id, name: s.meta.name, src, params, v: contentHash(JSON.stringify([src, params])) };
            if (main) domHandlers.push(h);
            if (iso && __MV3__) {
                isoHandlers.push({ scriptId: s.id, name: s.meta.name });
                isoRuns.set(s.id, { name: s.meta.name, src: h.src, siteV: h.v, params: h.params, libs: [], codeHash: "", overlay: !!over.length });
                isoScriptDeps.set(s.id, new Set(a.deps));
            } else if (iso) isoHandlers.push(h);
            if (main) for (const d of a.deps) mainDeps.add(d);
            if (iso && !__MV3__) for (const d of a.deps) isoDeps.add(d);
        }
        // ship the transitively imported library sources (and data files, package modules) once per world
        const dataFiles = mainDeps.size || isoDeps.size || overlayDeps.size || isoScriptDeps.size ? await listDataFiles() : [];
        const pkgs = packagesSnapshot();
        const libsOf = (depNames: Set<string>): ShippedLib[] => {
            const libs = new Map<string, ShippedLib>();
            const urls = [...depNames].filter(isUrlSpec);
            for (const u of urls) if (pkgs.aliases[u]) libs.set(u, { name: u, alias: pkgs.aliases[u] });
            for (const u of packageClosure(pkgs, urls)) libs.set(u, { name: u, pkg: pkgs.modules[u] });
            for (const depName of depNames) {
                if (isUrlSpec(depName)) continue;
                const lib = pageScripts.find((x) => x.meta.name === depName);
                const data = !lib && dataFiles.find((d) => d.path === depName);
                if (data && !libs.has(data.path)) libs.set(data.path, { name: data.path, json: data.text });
                if (!lib || libs.has(lib.meta.name)) continue;
                const defs = analyzed.get(lib.id)?.paramDefs || {};
                const src = toRunnableJs(lib.code);
                libs.set(lib.meta.name, { name: lib.meta.name, src, params: resolveParamValues(defs, paramValues[lib.id]) });
            }
            return [...libs.values()];
        };
        const libs = libsOf(mainDeps);
        const isoLibs = isoDeps.size ? libsOf(isoDeps) : [];
        // an overlay reloads when its code, params or imports change
        for (const o of overlays) {
            const run = overlayRuns.get(o.scriptId)!;
            run.libs = libsOf(overlayDeps.get(o.scriptId)!);
            run.react = needsReact([pageScripts.find((x) => x.id === o.scriptId)?.code ?? "", run.code, ...run.libs.map((l) => l.src ?? "")], pkgs);
            run.codeHash = o.codeHash = contentHash(JSON.stringify([run.code, run.params, run.libs.map((l) => [l.name, l.src ?? l.json ?? l.alias ?? ""])]));
        }
        // a user-script world re-runs when its code, params or imports change
        for (const [id, run] of isoRuns) {
            run.libs = libsOf(isoScriptDeps.get(id)!);
            run.codeHash = contentHash(JSON.stringify([run.src, run.params, run.libs.map((l) => [l.name, l.src ?? l.json ?? l.alias ?? ""])]));
        }
        // MV3 without user scripts: the overlay's calls into isolated code say why at once
        const isoOff = isoRuns.size && (await userScriptsStatus()) !== "ok" ? USER_SCRIPTS_OFF : undefined;
        return { bundle: { count: routes.length, routes, textTypes: getTextTypes(), domHandlers, isoHandlers, overlays, libs, isoLibs, ...(isoOff ? { isoOff } : {}) }, overlayRuns, isoRuns, previewWhy };
    }
    installPages();
    setupOverlayLinks({
        overlayRuns: async (url) => (await hookBundle(url, true)).overlayRuns,
        isoRuns: async (url, top) => (await hookBundle(url, top)).isoRuns,
        isoScripts: async (url, top) => new Set((await hookBundle(url, top)).bundle.isoHandlers.map((h) => h.scriptId)),
        userScriptsOff: async () => (await userScriptsStatus()) !== "ok",
        storageGet: (s, key) => scriptStorageGet(s, key),
        storageSet: async (s, key, value) => void (await scriptStorageSet(s, key, value)),
        log: (tabId, s, level, msg, ctx) => log(tabId, msg, level, s, undefined, undefined, undefined, ctx),
        ran: (tabId, s, name, api, url) => noteRan(tabId, s, name, api, url),
        previewRun: async (s) => {
            const { overlayRuns, previewWhy } = await hookBundle("", true, s);
            const run = overlayRuns.get(s);
            if (!run) throw new Error(previewWhy);
            return run;
        },
    });

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
        // the Editor's "pin the version" quick fix: the exact version a range/tag resolves to on unpkg
        if (msg && msg.type === "resolvePackageVersion") {
            resolveVersion(String(msg.name), String(msg.range || "latest")).then(
                (version) => sendResponse({ version }),
                (e) => sendResponse({ error: String(e?.message ?? e) })
            );
            return true;
        }
        // the Editor's package import markers: where each URL stands (starting the downloads it needs)
        if (msg && msg.type === "packageStatus") {
            requestPackages(Array.isArray(msg.urls) ? msg.urls.map(String) : []).then(
                (statuses) => sendResponse({ statuses }),
                (e) => sendResponse({ error: String(e?.message ?? e) })
            );
            return true;
        }
        // the Editor's "user scripts are off" banner (Chrome MV3)
        if (msg && msg.type === "userScriptsStatus") {
            void userScriptsStatus(true).then((status) => sendResponse({ status, scripts: isoScriptCount, id: chrome.runtime.id }));
            return true;
        }
        // the Editor's welcome page: wait until a just-saved script runs before opening its page
        if (msg && msg.type === "settleScripts") {
            void settle().then(() => sendResponse({}), () => sendResponse({}));
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
        // packages (install page, Explorer): every reply is the result or {error}
        const pkgOp: Record<string, () => Promise<unknown>> = {
            listPackages: () => listPackages(),
            packageAnalyze: () => analyzePackage(msg.fetched, msg.updateOf),
            packageInstall: () => installPackage(msg.fetched, { enabled: msg.enabled !== false, autoUpdate: msg.autoUpdate !== false }),
            packageCheck: () => checkPackages(msg.id),
            packageOffer: () => offerPackage(msg.id, msg.fetched, !!msg.manual),
            packageApply: () => applyPending(msg.id),
            packageDismiss: () => dismissPending(msg.id),
            packageRollback: () => rollbackPackage(msg.id),
            packageSetAutoUpdate: () => setAutoUpdate(msg.id, !!msg.on),
            packageForget: () => forgetPackage(msg.id),
        };
        if (msg && Object.prototype.hasOwnProperty.call(pkgOp, msg.type)) {
            pkgOp[msg.type]()
                .then((r) => sendResponse(r ?? {}))
                .catch((e) => sendResponse({ error: String(e?.message || e) }));
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
        if (msg && msg.type === "getBuiltinReact") {
            // MV2/Firefox: the bridge's isolated onPage code imports React
            reactChunkSource().then(
                (src) => sendResponse({ src }),
                (e) => sendResponse({ error: String(e?.message || e) })
            );
            return true;
        }
        if (msg && msg.type === "getHookBundle") {
            void (async () => {
                const url = msg.url || "";
                const { bundle } = await hookBundle(url, sender.frameId === 0 || sender.frameId === undefined);
                // MV2: the bridge runs isolated onPage code — its stores' current state (this page's wt.pageStore copies), so they read synchronously
                const tabId = sender.tab?.id;
                const isoIds = !__MV3__ ? bundle.isoHandlers.map((h) => h.scriptId) : [];
                if (isoIds.length && typeof tabId === "number" && tabId >= 0) {
                    await pagesReady;
                    // the top frame's page by its document (as its requests' and its bridge's): `current` may still be the pre-commit key
                    const top = sender.frameId === 0 || sender.frameId === undefined;
                    const page = (top ? pages.forRequest({ tabId, frameId: 0, documentId: (sender as any).documentId }) : pages.current(tabId)) ?? "";
                    Object.assign(bundle, { isoPage: page, isoStores: await storeOwner.init(isoIds, { page }) });
                }
                dlogLevel("pipeline", "debug", "getHookBundle responding", { routes: bundle.count, dom: bundle.domHandlers.length, iso: bundle.isoHandlers.length, overlays: bundle.overlays.length, url });
                sendResponse(bundle);
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
            pageStrategy.runRequestDecision(msg.url, method, tabId, pageRequestBody(msg)).then((r) => {
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
            pageStrategy.runTransform(msg.url, method, original || "", { status: msg.status, contentType: msg.contentType, requestId, requestBody: pageRequestBody(msg) }, tabId).then((body) => {
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
            pageStrategy.runReplace(msg.url, method, tabId, pageRequestBody(msg)).then((r) => {
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
    /** the last full reload's browser rules (installed asynchronously) */
    let rulesApplied: Promise<unknown> = Promise.resolve();
    /** the reloadSeq of the last reload that applied the scripts */
    let settledSeq = 0;
    /** enabled scripts with onPage code (the Editor's "user scripts are off" banner) */
    let isoScriptCount = 0;
    /** reload and wait until the current scripts are fully applied, rules included */
    async function settle(): Promise<void> {
        for (let i = 0; i < 5; i++) {
            await reload();
            // a newer reload superseded ours and hasn't applied yet: go again
            if (settledSeq === reloadSeq) break;
        }
        await rulesApplied.catch(() => {});
    }
    /** reload, showing the busy icon until the rules are in and the open tabs were told */
    async function reload(): Promise<void> {
        const end = beginBusy();
        try {
            await reloadNow();
        } finally {
            void rulesApplied.catch(() => {}).then(end);
        }
    }
    async function reloadNow(): Promise<void> {
        const seq = ++reloadSeq;
        await loadTextTypes();
        await loadDataFiles();
        await loadPackages();
        const stored = await listScripts();
        const paramValues = await loadAllParamValues();
        await prepareStores(stored.map((s) => s.id));
        // MV2 compiles right here (synchronously): load the built-in React first if a script imports it
        if (!__MV3__) await ensureBuiltins(stored.map((s) => s.code), packagesSnapshot()).catch((e: any) => dlogLevel("pipeline", "warn", `built-in React failed to load: ${e?.message || e}`));
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
        const isoScripts: IsoScript[] = scripts
            .filter((x) => x.enabled && x.meta.active)
            .map((x) => ({ id: x.id, routes: (x.meta.routes || []).filter((r) => r.kind === "onDocument" && pageWorld(r) === "isolated") }))
            .filter((x) => x.routes.length);
        const usStatus = isoScripts.length ? await userScriptsStatus(true) : "ok";
        if (seq !== reloadSeq) return; // superseded by a newer reload
        dlog("pipeline", "reload", { total: scripts.length, enabled: scripts.filter((x) => x.enabled).map((x) => x.meta.name) });
        extensionStrategy.reload(scripts, paramValues);
        pageStrategy.reload(scripts, paramValues);
        cdp.reload(scripts, paramValues);
        helperStrategy.reload(scripts, paramValues);
        rulesApplied = rulesStrategy.reload(scripts, paramValues);
        settledSeq = seq;
        refreshBodyWatch(scripts);
        setSkipRoutes(scripts);
        warnRoutes(scripts, usStatus);
        isoScriptCount = isoScripts.length;
        // MV3 isolated onPage code: (un)register the user-script worlds; open ones load again
        void syncUserScripts(isoScripts).then(() => pushIsoUpdate());

        // HOT RELOAD: push the new bundle to every open tab's hook so
        // changes apply without reloading the target tab. Bridges with an
        // open L2 port get `bundle.update` and ignore the one-shot message.
        pushBundleUpdate(scripts.filter((x) => x.enabled).map((x) => ({ s: x.id, codeHash: contentHash(x.code) })));
        revalidateOverlayLinks();
        pushPreviewUpdate(scripts.map((x) => ({ s: x.id, codeHash: contentHash(x.code) })));
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
    // the user granted the permission or allowed user scripts (or took it back): register, update Problems and pages
    onUserScriptsStatus(() => void reload());
    if (__MV3__) {
        const recheck = (p: chrome.permissions.Permissions) => p.permissions?.includes("userScripts" as any) && void userScriptsStatus(true);
        chrome.permissions?.onAdded?.addListener(recheck);
        chrome.permissions?.onRemoved?.addListener(recheck);
    }
    // rules handlers may read a store: a change re-probes
    const offStores = storeOwner.onChange((s, _name, page) => page === undefined && rulesStrategy.storeChanged(s));
    // ownership moves between the helper strategy and the other strategies
    const offProcess = onHelperActiveChange(() => void reload());
    const onStorage = (changes: Record<string, unknown>, area: string) => {
        if (area === "local" && changes[TEXT_TYPES_KEY]) void reload();
    };
    chrome.storage.onChanged.addListener(onStorage);
    void reload();

    return {
        reload,
        pageStrategy,
        cdp,
        dispose() {
            off();
            offStores();
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

