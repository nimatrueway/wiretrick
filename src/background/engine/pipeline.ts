/**
 * Wires the strategies into chrome.webRequest and background messaging.
 * This is the single place that touches MV2 webRequest APIs; everything
 * browser-specific below it lives in strategies/.
 */
import type { InterceptionStrategy } from "./strategies/types";
import type { ChromeBodyStrategy } from "./strategies/chromeBodyStrategy";
import type { CdpStrategy } from "./strategies/cdpStrategy";
import type { ProcessStrategy } from "./strategies/processStrategy";
import { IS_FIREFOX, onProcessActiveChange, processActive, tierUnavailable } from "./strategies/processState";
import type { HeaderChanges } from "./strategies/types";
import type { Script } from "./scriptStore";
import { listScripts, getScript, onScriptsChanged, saveScript, deleteScript, setEnabled, newId, scriptStorageGet, scriptStorageSet, loadAllParamValues, getParamValues, setParamValue } from "./scriptStore";
import { serveStore } from "./strategies/webRequestStrategy";
import { dlog, dlogLevel } from "../../shared/debugLog";
import { isThenable, toRunnableJs } from "../../shared/compile";
import "../../shared/transpile";
import { log, getScriptErrors, getScriptTypeErrors, bodyTappedSince } from "./logs";
import { missedLine } from "../../shared/netTypes";
import { makeMissedThrottle, missedReason, missedWhat, routeProblem, MISSED_SKIP_TYPES } from "../../shared/missedTap";
import { resolveParamValues } from "../../shared/scriptDef";
import { effectiveStrategy, hookCanSee, routeLabel, routeMatches, setDefaultStrategy, type RouteMeta, type Strategy } from "../../shared/route";
import { analyzeScripts, runBodyOp, type Analyzed } from "../compileHost";
import { recordNetBody } from "../network";
import { STRATEGY_KEY } from "../settingsFile";

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

/** settings.strategy → route.ts default (every reload and hook bundle) */
function loadDefaultStrategy(): Promise<void> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get([STRATEGY_KEY], (g: any) => {
                void (chrome.runtime as any).lastError;
                setDefaultStrategy(g?.[STRATEGY_KEY]);
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
    chromeBody: ChromeBodyStrategy;
    cdp: CdpStrategy;
    dispose(): void;
}

export function createPipeline(
    webRequestStrategy: InterceptionStrategy & { reload(s: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void; matchingNames?(url: string): string[] },
    chromeBody: ChromeBodyStrategy,
    cdp: CdpStrategy,
    processStrategy: ProcessStrategy,
    updateTabBadge?: (tabId: number, url: string | undefined) => Promise<void>,
    noteRequestForBadge?: (tabId: number, url: string) => number
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
        // MV3 debugger tier: attach BEFORE the navigation's subresources
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
                    log(d.tabId, `[cdp] page load ${d.url} left before the debugger attached — re-loaded it through the debugger so it is intercepted`, "info");
                }
            });
        });
        chrome.tabs.onRemoved.addListener((tabId) => mainFrameSeen.delete(tabId));
    }
    // ---- "modifyResponse never ran" ----
    // A body handler can silently not run: Chromium's webRequest can't read
    // bodies and the hook only sees page fetch/XHR, a cached load skips the
    // debugger, the helper is down… Once a matching request completes, warn
    // (attributed to the script) when none of its body handlers ran for it.
    let bodyWatch: BodyWatch[] = [];
    /** requestId → start time, only for requests a watched script matches */
    const watchedStarts = new Map<string, number>();
    /** `${tabId}|${url}` loads the debugger-tier warning below already reported */
    const cdpWarned = new Set<string>();
    const missedThrottle = makeMissedThrottle();
    const extOrigin = chrome.runtime.getURL("");
    const watchedFor = (url: string, method?: string, type?: string) => bodyWatch.filter((w) => routeMatches(w.route, url, method, type));
    const ownRequest = (d: any) => d.url.startsWith(extOrigin) || (d.initiator || d.originUrl || "").startsWith(extOrigin.replace(/\/$/, ""));
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
        const routes = watchedFor(d.url, (d as any).method, d.type);
        if (!routes.length) return;
        setTimeout(() => {
            // the hook took it: the page may simply never read the body
            if (chromeBody.isClaimed(d.url)) return;
            const done = new Set<string>();
            for (const w of routes) {
                if (done.has(w.id)) continue;
                done.add(w.id);
                if (bodyTappedSince(w.id, d.url, start - 250)) continue;
                const reason = missedReason({
                    strategy: w.strategy,
                    type: d.type,
                    firefox: IS_FIREFOX,
                    mv3: __MV3__,
                    fromCache: !!d.fromCache,
                    helperActive: processActive(),
                    cdpWarned: cdpWarned.has(`${d.tabId}|${d.url}`),
                });
                if (!reason || !missedThrottle(`${w.id}|${d.url}`)) continue;
                log(d.tabId, missedLine(w.name, routeLabel(w.route), d.url, missedWhat(d.type), reason), "warn", w.id, "missed", d.url);
            }
        }, MISSED_DELAY_MS);
    }

    // ---- up-front: handlers that can't run where they are ----
    /** `${scriptId}|${message}` → handler labels last reported */
    let routeWarned = new Map<string, string>();
    let helperTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    function warnRoutes(scripts: Script[]): void {
        const next = new Map<string, string>();
        const problems: { id: string; name: string; msg: string; labels: string[] }[] = [];
        const helperDown: { id: string; name: string; labels: string[] }[] = [];
        for (const s of scripts) {
            if (!s.enabled || !s.meta.active) continue;
            const byMsg = new Map<string, string[]>();
            const down: string[] = [];
            for (const r of s.meta.routes || []) {
                if (r.kind === "onDom") continue;
                const strategy = effectiveStrategy(r);
                const msg = routeProblem({ kind: r.kind, strategy, types: r.types }, { firefox: IS_FIREFOX, mv3: __MV3__ });
                if (msg) byMsg.set(msg, [...(byMsg.get(msg) || []), routeLabel(r)]);
                else if (strategy === "process" && tierUnavailable("process")) down.push(routeLabel(r));
            }
            for (const [msg, labels] of byMsg) problems.push({ id: s.id, name: s.meta.name, msg, labels });
            if (down.length) helperDown.push({ id: s.id, name: s.meta.name, labels: down });
        }
        for (const p of problems) {
            const key = `${p.id}|${p.msg}`;
            const labels = p.labels.join(", ");
            next.set(key, labels);
            if (routeWarned.get(key) !== labels) log(-1, `[${p.name}] ${labels}: ${p.msg}`, "warn", p.id);
        }
        // keep helper-down keys so a reload while it stays down doesn't repeat it
        for (const [k, v] of routeWarned) if (k.endsWith("|helper")) next.set(k, v);
        routeWarned = next;
        if (helperTimer) clearTimeout(helperTimer);
        if (!helperDown.length) {
            for (const k of [...routeWarned.keys()]) if (k.endsWith("|helper")) routeWarned.delete(k);
            return;
        }
        helperTimer = setTimeout(() => {
            if (processActive()) return;
            for (const h of helperDown) {
                const key = `${h.id}|helper`;
                const labels = h.labels.join(", ");
                if (routeWarned.get(key) === labels) continue;
                routeWarned.set(key, labels);
                log(-1, `[${h.name}] ${labels}: strategy "process" — ${tierUnavailable("process")}; these handlers don't run until it is`, "warn", h.id);
            }
        }, Math.max(0, HELPER_GRACE_MS - (Date.now() - startedAt)));
    }

    function refreshBodyWatch(scripts: Script[]): void {
        const next: BodyWatch[] = [];
        for (const s of scripts) {
            if (!s.enabled || !s.meta.active) continue;
            for (const r of s.meta.routes || []) {
                if (r.kind === "modifyResponse" || r.kind === "replaceResponse") next.push({ id: s.id, name: s.meta.name, route: r, strategy: effectiveStrategy(r) });
            }
        }
        bodyWatch = next;
    }

    if (chrome.webRequest?.onCompleted) {
        chrome.webRequest.onCompleted.addListener((d) => checkMissed(d), { urls: ["<all_urls>"] });
        // observe-only (MV3-legal): a debugger-tier load that left before
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
                    log(d.tabId, `[cdp] ${what} ${d.url}${d.fromCache ? " (from cache)" : ""} was NOT intercepted by ${names.map((n) => `"${n}"`).join(", ")} — it loaded before the debugger attached to this tab. ${hint}`, "warn");
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
    /** requestId → first URL of requests a webrequest-tier script matched (diagnostics) */
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

        const disposition = webRequestStrategy.handleBeforeRequest(details, tabUrl);
        if (!traced.has(details.requestId) && webRequestStrategy.matchingNames?.(details.url).length) {
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
                log(details.tabId, `cancelled ${details.url}`, "info");
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
                dlogLevel("webrequest", "debug", `${event} listener registered (${extra.join(", ")})`);
            } catch (e: any) {
                // e.g. a browser build that dropped MV2 blocking webRequest
                log(-1, `[webrequest] cannot register blocking ${event} listener — the "webrequest" strategy is inactive in this browser: ${e?.message || e}`, "error");
            }
        };
        addBlocking("onBeforeRequest", onBeforeRequest, ["blocking"]);
        addBlocking("onBeforeSendHeaders", onBeforeSendHeaders, ["requestHeaders", "blocking", "extraHeaders"]);
        addBlocking("onHeadersReceived", onHeadersReceived, ["responseHeaders", "blocking", "extraHeaders"]);

        // per-request caches must not leak for requests that never reach the
        // response-header phase
        const onDone = (details: any) => {
            webRequestStrategy.pruneRequest?.(details.requestId);
        };
        chrome.webRequest.onCompleted.addListener(onDone, FILTER);
        chrome.webRequest.onErrorOccurred.addListener(onDone, FILTER);

        // diagnostics: what the browser did with requests a webrequest-tier
        // script matched (LOG panel at logLevel: debug; failures as warn)
        const tr = (details: any, msg: string, level: "debug" | "warn" = "debug") => {
            const t = traced.get(details.requestId);
            if (!t) return;
            log(details.tabId, `[webrequest] ${msg}${details.url !== t.url ? ` (originally ${t.url})` : ""}`, level);
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
            log(t?.tabId ?? -1, `[webrequest] the browser IGNORED this extension's "${d.action}"${t ? ` for ${t.url}` : ""} — another extension's change to the same request took precedence (disable other request-modifying extensions, e.g. a second Wiretrick install)`, "warn");
        });
    } else {
        dlog("pipeline", "MV3: no blocking webRequest — hook tier carries page fetch/XHR; strategy cdp (debugger) or process (local helper) carries browser-initiated loads");
    }

    // ---- manager protocol ----
    chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
        if (msg && msg.type === "listScripts") {
            listScripts().then(async (scripts) => {
                // scripts saved before params existed have no stored
                // paramDefs — compile them on the fly (imports stubbed: we
                // only need declarations here) so the UI can offer ⚙
                const missing = scripts.filter((s) => s.paramDefs === undefined);
                const analyzed = await analyzeScripts(missing.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
                const errors = await getScriptErrors();
                const typeErrors = await getScriptTypeErrors();
                sendResponse(
                    scripts.map((s) => ({
                        ...s,
                        paramDefs: s.paramDefs === undefined ? analyzed.get(s.id)?.paramDefs || {} : s.paramDefs,
                        runtimeError: errors.get(s.id) ?? null,
                        typeErrors: typeErrors.get(s.id) ?? [],
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
                // Network handlers run in the background (the hook is
                // eval-free and immune to page CSP): the page gets only the
                // ROUTES of hook-owned handlers, so it touches fetch/XHR to
                // those and leaves everything else native. onDom handlers
                // need the page's window: their scripts' FULL sources ship
                // (top-level helpers/closures survive), compiled in the MAIN
                // world when the page CSP allows, else in the bridge.
                const url = msg.url || "";
                const domHandlers: { scriptId: string; name: string; src: string; params: Record<string, any> }[] = [];
                const libs = new Map<string, { name: string; src: string; params: Record<string, any> }>();
                const routes: RouteMeta[] = [];
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
                        if (r.kind === "onDom") dom ||= routeMatches(r, url);
                        else if (r.kind !== "onResponseHeaders" && effectiveStrategy(r) === "hook" && hookCanSee(r)) routes.push(r);
                    }
                    if (!dom) continue;
                    for (const d of a.deps) depNames.add(d);
                    domHandlers.push({ scriptId: s.id, name: s.meta.name, src: toRunnableJs(s.code), params: resolveParamValues(a.paramDefs || {}, paramValues[s.id]) });
                }
                // ship the transitively imported library sources once
                for (const depName of depNames) {
                    const lib = pageScripts.find((x) => x.meta.name === depName);
                    if (!lib || libs.has(lib.meta.name)) continue;
                    const defs = analyzed.get(lib.id)?.paramDefs || {};
                    libs.set(lib.meta.name, { name: lib.meta.name, src: toRunnableJs(lib.code), params: resolveParamValues(defs, paramValues[lib.id]) });
                }
                dlogLevel("pipeline", "debug", "getHookBundle responding", { routes: routes.length, dom: domHandlers.length, url });
                sendResponse({ count: routes.length, routes, domHandlers, libs: [...libs.values()] });
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
                const analyzed = await analyzeScripts(scripts.map((x) => ({ id: x.id, name: x.meta.name, code: x.code, updatedAt: x.updatedAt })));
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
        // hook tier (page fetch/XHR) — bodies recorded for the Network tab
        if (msg && msg.type === "runRequestDecision") {
            dlogLevel("pipeline", "debug", `runRequestDecision ${msg.url}`);
            const tabId = sender?.tab?.id ?? -1;
            const method = msg.method || "GET";
            chromeBody.runRequestDecision(msg.url, method, tabId).then((r) => {
                if (r?.kind === "respond") recordNetBody({ tabId, url: msg.url, method, modified: r.content, mime: r.mime, status: r.status || 200 });
                sendResponse(r || null);
            });
            return true;
        }
        if (msg && msg.type === "runTransform") {
            const tabId = sender?.tab?.id ?? -1;
            const method = msg.method || "GET";
            chromeBody.runTransform(msg.url, method, msg.body || "", { status: msg.status, contentType: msg.contentType }, tabId).then((body) => {
                recordNetBody({ tabId, url: msg.url, method, original: msg.body ?? "", modified: body });
                sendResponse({ body });
            });
            return true;
        }
        if (msg && msg.type === "runReplace") {
            const tabId = sender?.tab?.id ?? -1;
            const method = msg.method || "GET";
            chromeBody.runReplace(msg.url, method, tabId).then((r) => {
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
        await loadDefaultStrategy();
        const stored = await listScripts();
        const paramValues = await loadAllParamValues();
        // routes come from running each script's top level with its real
        // params and imports (stored meta had imports stubbed). MV3: this
        // also warms the analyze cache so the next getHookBundle is served
        // without waking the sandbox (keeps onDom document_start early).
        let scripts = stored;
        try {
            scripts = withAnalyzedMeta(stored, await analyzeScripts(stored.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })), paramValues));
        } catch (e: any) {
            dlogLevel("pipeline", "warn", `script analysis failed, using saved routes: ${e?.message || e}`);
        }
        if (seq !== reloadSeq) return; // superseded by a newer reload
        dlog("pipeline", "reload", { total: scripts.length, enabled: scripts.filter((x) => x.enabled).map((x) => x.meta.name) });
        webRequestStrategy.reload(scripts, paramValues);
        chromeBody.reload(scripts, paramValues);
        cdp.reload(scripts, paramValues);
        processStrategy.reload(scripts, paramValues);
        refreshBodyWatch(scripts);
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
    // ownership moves between the process tier and the other tiers
    const offProcess = onProcessActiveChange(() => void reload());
    // settings.strategy moves ownership between tiers
    const onStorage = (changes: Record<string, unknown>, area: string) => {
        if (area === "local" && changes[STRATEGY_KEY]) void reload();
    };
    chrome.storage.onChanged.addListener(onStorage);
    void reload();

    return {
        reload,
        chromeBody,
        cdp,
        dispose() {
            off();
            offProcess();
            chrome.storage.onChanged.removeListener(onStorage);
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

