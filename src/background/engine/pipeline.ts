/**
 * Wires the strategies into chrome.webRequest and background messaging.
 * This is the single place that touches MV2 webRequest APIs; everything
 * browser-specific below it lives in strategies/.
 */
import type { InterceptionStrategy } from "./strategies/types";
import type { ChromeBodyStrategy } from "./strategies/chromeBodyStrategy";
import type { CdpStrategy } from "./strategies/cdpStrategy";
import type { ProcessStrategy } from "./strategies/processStrategy";
import { hookEligible, onProcessActiveChange, processActive } from "./strategies/processState";
import type { HeaderChanges } from "./strategies/types";
import type { Script } from "./scriptStore";
import { listScripts, getScript, onScriptsChanged, saveScript, deleteScript, setEnabled, newId, scriptStorageGet, scriptStorageSet, loadAllParamValues, getParamValues, setParamValue } from "./scriptStore";
import { matchAny } from "../../shared/matcher";
import { serveStore } from "./strategies/webRequestStrategy";
import { dlog, dlogLevel } from "../../shared/debugLog";
import { isThenable, toRunnableJs } from "../../shared/compile";
import "../../shared/transpile";
void toRunnableJs;
import { log, getScriptErrors, getScriptTypeErrors, bodyTappedSince } from "./logs";
import { parseStrategyList } from "../../shared/metaParser";
import { missedLine } from "../../shared/netTypes";
import { bodyTierGap, makeMissedThrottle, missedReason, missedWhat, MISSED_SKIP_TYPES } from "../../shared/missedTap";
import { serializeHandlers, type HandlerSources } from "../../shared/compile";
import { resolveParamValues } from "../../shared/scriptDef";
import { unknownStrategies } from "../../shared/metaParser";
import { analyzeScripts, runBodyOp } from "../compileHost";
import { recordNetBody } from "../network";

const FILTER: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" && typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

/** an enabled, declared script with body handlers — checked by the "never ran" warning */
interface BodyWatch {
    id: string;
    name: string;
    match: string[];
    tiers: string[];
    modify: boolean;
    replace: boolean;
}
const MISSED_DELAY_MS = 1500;

/** "proxy" (removed) or a typo is silently ignored by parseStrategyList — say so once per script+value */
const warnedStrategies = new Set<string>();
function warnUnknownStrategies(scripts: { id: string; enabled: boolean; meta: { name: string; strategy: string; declared?: boolean } }[]): void {
    for (const s of scripts) {
        if (!s.enabled || !s.meta.declared) continue;
        const bad = unknownStrategies(s.meta.strategy);
        const key = `${s.id}:${bad.join(",")}`;
        if (!bad.length || warnedStrategies.has(key)) continue;
        warnedStrategies.add(key);
        const hint = bad.includes("proxy") ? ' — the "proxy" strategy was removed; use "cdp" or "process" for browser-initiated loads' : "";
        dlogLevel("pipeline", "warn", `Script "${s.meta.name}": unknown strategy ${bad.map((b) => `"${b}"`).join(", ")} ignored${hint}`);
    }
}

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
    /** scriptId → last up-front tier-gap state reported (see bodyTierGap) */
    const gapWarned = new Map<string, string>();
    const extOrigin = chrome.runtime.getURL("");
    const watchedFor = (url: string) => bodyWatch.filter((w) => matchAny(w.match, url));
    const ownRequest = (d: any) => d.url.startsWith(extOrigin) || (d.initiator || d.originUrl || "").startsWith(extOrigin.replace(/\/$/, ""));
    if (chrome.webRequest?.onBeforeRequest) {
        chrome.webRequest.onBeforeRequest.addListener(
            (d) => {
                if (d.tabId < 0 || MISSED_SKIP_TYPES.has(d.type) || !bodyWatch.length || !watchedFor(d.url).length) return;
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
        const scripts = watchedFor(d.url);
        if (!scripts.length) return;
        setTimeout(() => {
            // the hook took it: the page may simply never read the body
            if (chromeBody.isClaimed(d.url)) return;
            for (const w of scripts) {
                if (bodyTappedSince(w.id, d.url, start - 250)) continue;
                const reason = missedReason({
                    tiers: w.tiers,
                    type: d.type,
                    firefox: IS_FIREFOX,
                    mv3: __MV3__,
                    fromCache: !!d.fromCache,
                    helperActive: processActive(),
                    replaceOnly: w.replace && !w.modify,
                    cdpWarned: cdpWarned.has(`${d.tabId}|${d.url}`),
                });
                if (!reason || !missedThrottle(`${w.id}|${d.url}`)) continue;
                const handler = w.modify ? "modifyResponse" : "replaceResponse";
                log(d.tabId, missedLine(w.name, handler, d.url, missedWhat(d.type), reason), "warn", w.id, "missed", d.url);
            }
        }, MISSED_DELAY_MS);
    }
    async function refreshBodyWatch(scripts: Script[]): Promise<void> {
        try {
            const analyzed = await analyzeScripts(scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
            const next: BodyWatch[] = [];
            for (const s of scripts) {
                const a = analyzed.get(s.id);
                if (!s.enabled || !a || a.error || !a.declared || !a.handlers) continue;
                if (!a.handlers.modifyResponse && !a.handlers.replaceResponse) continue;
                next.push({
                    id: s.id,
                    name: s.meta.name,
                    match: s.meta.match,
                    tiers: parseStrategyList(s.meta.strategy as any),
                    modify: a.handlers.modifyResponse > 0,
                    replace: a.handlers.replaceResponse > 0,
                });
            }
            bodyWatch = next;
            // say it once per script + strategy, not on every request
            for (const w of next) {
                const gap = bodyTierGap(w.tiers, IS_FIREFOX, __MV3__, w.modify);
                const key = `${w.tiers.join(",")}|${gap}`;
                if (gapWarned.get(w.id) === key) continue;
                gapWarned.set(w.id, key);
                if (gap) log(-1, `[${w.name}] ${gap}`, "warn", w.id);
            }
        } catch (e: any) {
            dlogLevel("pipeline", "debug", `body-handler watch refresh failed: ${e?.message || e}`);
        }
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
        if (!traced.has(details.requestId) && webRequestStrategy.matchingNames?.(details.url).length) {
            traced.set(details.requestId, { url: details.url, tabId: details.tabId, at: Date.now() });
            if (traced.size > 500) traced.delete(traced.keys().next().value as string);
        }

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
        const addBlocking = (event: string, fn: any, extra: string[]) => {
            try {
                (chrome.webRequest as any)[event].addListener(fn, FILTER, extra);
                dlogLevel("webrequest", "debug", `${event} listener registered (${extra.join(", ")})`);
            } catch (e: any) {
                // e.g. a browser build that dropped MV2 blocking webRequest
                log(-1, `[webrequest] cannot register blocking ${event} listener — the "webrequest" strategy is inactive in this browser: ${e?.message || e}`, "error");
            }
        };
        addBlocking("onBeforeRequest", onBeforeRequest, ["blocking"]);
        addBlocking("onBeforeSendHeaders", onBeforeSendHeaders, ["requestHeaders", "blocking"]);
        addBlocking("onHeadersReceived", onHeadersReceived, ["responseHeaders", "blocking"]);

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
                // scripts saved before declareScript existed have no stored
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
            // full script sources: the hook compiles them itself so handlers
            // keep their `wt` binding and top-level scope
            // ship ALL enabled body scripts — body transforms match request
            // URLs, not the page URL, so the hook filters per-request itself
            // deliver runnable JS: the page hook has no TS compiler
            // Transforms run in the background (the hook is eval-free and
            // immune to page CSP). onDom handler SOURCES ship to the page:
            // onDom needs the page's window, so it runs in the MAIN world
            // when the page CSP allows, with the bridge as the fallback.
            const domHandlers: { scriptId: string; name: string; when: string; src: string; params: Record<string, any> }[] = [];
            const libs = new Map<string, string>(); // name → transpiled lib source
            // URL patterns of hook-eligible body scripts: the hook only
            // touches fetch/XHR to these, everything else stays native
            const patterns = new Set<string>();
            {
                const pageScripts = await listScripts();
                // MV3: scripts are analyzed in the sandbox page (the SW can't
                // eval); MV2 compiles right here. Both paths return plain
                // metadata; the shipped handler SOURCES are transpiled locally.
                const analyzed = await analyzeScripts(pageScripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
                const depNames = new Set<string>();
                for (const s of pageScripts) {
                    const a = analyzed.get(s.id);
                    const h = a?.handlers;
                    if (s.enabled && a?.declared && !a.error && hookEligible(s.meta.strategy) && (!h || h.onRequest || h.modifyResponse || h.replaceResponse)) {
                        for (const m of s.meta.match) patterns.add(m);
                    }
                }
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
                patterns: patterns.size,
                dom: domHandlers.length,
                url: msg.url,
            });
                sendResponse({ count: patterns.size, patterns: [...patterns], domHandlers, libs: [...libs.entries()].map(([name, src]) => ({ name, src })) });
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
    async function reload(): Promise<void> {
        const scripts = (await listScripts()) as ScriptWithSources[];
        const paramValues = await loadAllParamValues();
        dlog("pipeline", "reload", { total: scripts.length, enabled: scripts.filter((x) => x.enabled).map((x) => x.meta.name) });
        webRequestStrategy.reload(scripts, paramValues);
        chromeBody.reload(scripts, paramValues);
        void cdp.reload(scripts, paramValues);
        processStrategy.reload(scripts, paramValues);
        // MV3: also refreshes the analyze cache NOW so the next page's
        // getHookBundle is served from it without waking the sandbox (keeps
        // onDom document_start as early as MV3 allows)
        void refreshBodyWatch(scripts);
        warnUnknownStrategies(scripts);

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

