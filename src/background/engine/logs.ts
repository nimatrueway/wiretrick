/**
 * Rolling per-tab request log, pushed to the manager UI over a port.
 */
import { annotateFromLog, URL_AT_END } from "../network";
import { SKIPPED_MARK } from "../../shared/precedence";
import { outcomeKind, observedLine, type OutcomeKind, type NetKind } from "../../shared/netTypes";
import type { Strategy } from "../../shared/route";

export interface LogEntry {
    tabId: number;
    scriptId: string | null;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    at: number;
    /** set on "observed (no change)" lines — the UI caps how many it keeps */
    kind?: NetKind;
    /** the webRequest requestId the line is about, when the strategy knew it */
    requestId?: string;
}

const MAX_PER_TAB = 200;
const tabLogs = new Map<number, LogEntry[]>();
/**
 * "observed (no change)" DEBUG lines (one per handler run) get their own small
 * per-tab ring, so a busy page can't evict the useful lines from the
 * replay ring above.
 */
const MAX_OBSERVED_PER_TAB = 50;
const observedLogs = new Map<number, LogEntry[]>();

function pushCapped(rings: Map<number, LogEntry[]>, entry: LogEntry, cap: number): void {
    const list = rings.get(entry.tabId) || [];
    list.push(entry);
    if (list.length > cap) list.splice(0, list.length - cap);
    rings.set(entry.tabId, list);
}

const uiPorts = new Set<chrome.runtime.Port>();

/** The manager's "clear": drop the replay rings too, so a reconnecting manager doesn't bring old lines back. */
export function clearLogHistory(): void {
    tabLogs.clear();
    observedLogs.clear();
}

export function addUiPort(port: chrome.runtime.Port): void {
    uiPorts.add(port);
    port.onDisconnect.addListener(() => uiPorts.delete(port));
    // replay this tab's recent logs to the newly connected manager page
    const all: LogEntry[] = [];
    for (const entries of tabLogs.values()) {
        all.push(...entries);
    }
    all.sort((a, b) => a.at - b.at);
    const observed = [...observedLogs.values()].flat();
    const replay = observed.length ? [...all.slice(-MAX_PER_TAB), ...observed].sort((a, b) => a.at - b.at) : all.slice(-MAX_PER_TAB);
    for (const entry of replay) {
        port.postMessage({ type: "log", entry });
    }
}

/**
 * `kind` marks a script-attributed line that names a request (ends with its
 * URL) as "observed" (handler ran, no change) or "modified"; omitted, it is
 * inferred (see outcomeKind).
 */
export function log(tabId: number, message: string, level: LogEntry["level"] = "info", scriptId: string | null = null, kind?: OutcomeKind, url?: string, requestId?: string): void {
    const netKind = scriptId ? outcomeKind(level, message, kind) : undefined;
    // a skipped handler isn't "missed" twice (the onCompleted check)
    if (scriptId && (netKind !== "missed" || message.includes(SKIPPED_MARK))) noteTap(scriptId, level, message, requestId);
    const observedOnly = kind === "observed" && level === "debug";
    const entry: LogEntry = { tabId, scriptId, level, message, at: Date.now(), ...(observedOnly ? { kind: "observed" as const } : {}), ...(requestId ? { requestId } : {}) };
    if (observedOnly) pushCapped(observedLogs, entry, MAX_OBSERVED_PER_TAB);
    else pushCapped(tabLogs, entry, MAX_PER_TAB);
    for (const port of uiPorts) {
        port.postMessage({ type: "log", entry });
    }
    if (scriptId) annotateFromLog(tabId, scriptId, message, level, netKind, url, requestId);
    if (scriptId && level === "error" && !/^\[[^\]]*\] console\.error/.test(message)) recordScriptError(scriptId, message);
    if (level === "error") {
        console.error("[Wiretrick]", message);
    }
}

// ---- tap registry: did a script's handler run for a URL? ----
// Recorded whether or not a manager is open (annotateFromLog needs a port),
// keyed without the tab — the helper strategy logs with tabId -1. Feeds the
// "onResponseBody never ran" warning (pipeline.ts). A line that knows its
// webRequest requestId is recorded for that request only (two same-URL
// requests each get their own answer); the URL maps hold the rest.

const MAX_TAPS = 2000;
/** `${scriptId}|${url}` → when a body handler last ran (or onRequest ended the request) */
const bodyTaps = new Map<string, number>();
/** `${scriptId}|${requestId}` → same, for lines that know their request */
const tapsById = new Map<string, number>();

function setCapped<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_TAPS) map.delete(map.keys().next().value!);
}
const lastScriptError = new Map<string, number>();
/** lines that mean the body handlers ran — or legitimately never will */
const BODY_TAP = /\b(onResponseBody|replaceResponse)\b|onRequest → (block|redirect)\b| → skipped: /;

function noteTap(scriptId: string, level: LogEntry["level"], message: string, requestId?: string): void {
    const now = Date.now();
    if (level === "error" && !/^\[[^\]]*\] console\.error/.test(message)) lastScriptError.set(scriptId, now);
    if (!BODY_TAP.test(message)) return;
    const m = URL_AT_END.exec(message);
    if (!m) return;
    if (requestId) setCapped(tapsById, `${scriptId}|${requestId}`, now);
    else setCapped(bodyTaps, `${scriptId}|${m[1]}`, now);
}

/**
 * Did a body handler of scriptId run for url (or the script throw anywhere) at
 * or after `since` (ms epoch)? With a requestId: for that request, or a line
 * that didn't know its request.
 */
export function bodyObservedSince(scriptId: string, url: string, since: number, requestId?: string): boolean {
    const byId = requestId ? tapsById.get(`${scriptId}|${requestId}`) : undefined;
    if (byId !== undefined && byId >= since) return true;
    const t = bodyTaps.get(`${scriptId}|${url}`);
    if (t !== undefined && t >= since) return true;
    const e = lastScriptError.get(scriptId);
    return e !== undefined && e >= since;
}

type BodySkip = { at: number; strategy: Strategy; why: string; contentType: string };
/** url → the latest body a strategy didn't hand to onResponseBody, and why ("binary", "empty"…) */
const bodySkips = new Map<string, BodySkip>();
/** requestId → same, when the strategy knew the request */
const skipsById = new Map<string, BodySkip>();

export function noteBodySkip(strategy: Strategy, url: string, why: string, contentType: string, requestId?: string): void {
    const s = { at: Date.now(), strategy, why, contentType };
    if (requestId) setCapped(skipsById, requestId, s);
    else setCapped(bodySkips, url, s);
}

/** Did a strategy skip the body of url (of that request, when requestId is given) at or after `since`? */
export function bodySkipSince(url: string, since: number, requestId?: string): { strategy: Strategy; why: string; contentType: string } | undefined {
    const byId = requestId ? skipsById.get(requestId) : undefined;
    if (byId && byId.at >= since) return byId;
    const s = bodySkips.get(url);
    return s && s.at >= since ? s : undefined;
}

export function noteHelperSkip(url: string, why: string, contentType: string, requestId?: string): void {
    noteBodySkip("helper", url, why, contentType, requestId);
}

/** Did the helper skip the body of url at or after `since`? */
export function helperSkipSince(url: string, since: number, requestId?: string): { why: string; contentType: string } | undefined {
    const s = bodySkipSince(url, since, requestId);
    return s?.strategy === "helper" ? s : undefined;
}

/** test seam */
export function __resetTaps(): void {
    bodyTaps.clear();
    tapsById.clear();
    lastScriptError.clear();
    bodySkips.clear();
    skipsById.clear();
}

/** A handler ran for `url` but changed nothing: a DEBUG line that marks the request "observed". */
export function logObserved(tabId: number, scriptName: string, handler: string, url: string, scriptId: string, requestId?: string): void {
    log(tabId, observedLine(scriptName, handler, url), "debug", scriptId, "observed", undefined, requestId);
}

/** every tab's retained LOG lines, oldest first (diagnostic report) */
export function allLogs(): LogEntry[] {
    return [...tabLogs.values(), ...observedLogs.values()].flat().sort((a, b) => a.at - b.at);
}

/** Push an arbitrary message to all connected manager/popup pages. */
export function broadcastToUi(msg: any): void {
    for (const port of uiPorts) {
        port.postMessage(msg);
    }
}

/** Stream an arbitrary entry (e.g. debug log mirror) to the UI ports. */
export function broadcastEntry(entry: LogEntry): void {
    for (const port of uiPorts) {
        port.postMessage({ type: "log", entry });
    }
}

export function clearTab(tabId: number): void {
    tabLogs.delete(tabId);
    observedLogs.delete(tabId);
}

export function scriptError(scriptId: string, message: string): void {
    log(-1, message, "error", scriptId);
}

// ---- per-script runtime errors (indicator in the manager list + popup) ----

export interface ScriptRuntimeError {
    message: string;
    at: number;
    count: number;
}

const ERR_KEY = "wtScriptErrors";
const TYPE_KEY = "wtScriptTypeErrors";
const RULE_KEY = "wtScriptRuleErrors";
const ROUTE_KEY = "wtScriptRouteWarnings";
const runtimeErrors = new Map<string, ScriptRuntimeError>();
/** TypeScript diagnostics of the SAVED code, reported by the manager's editor */
const typeErrors = new Map<string, string[]>();
/** `rules` handlers that couldn't become rules: "onRequest #2: reason" */
const ruleErrors = new Map<string, string[]>();
/** handlers that can't run where they are: "<route labels>: <why>" (Problems view warnings) */
const routeWarnings = new Map<string, string[]>();
let errorsLoaded: Promise<void> | null = null;
let errorsTimer: ReturnType<typeof setTimeout> | null = null;

/** MV3: survive service-worker restarts via session storage (cleared with the browser session). */
function sessionArea(): chrome.storage.StorageArea | null {
    try {
        return (globalThis as any).chrome?.storage?.session ?? null;
    } catch {
        return null;
    }
}

function loadErrors(): Promise<void> {
    if (!errorsLoaded) {
        const area = sessionArea();
        errorsLoaded = area
            ? area.get([ERR_KEY, TYPE_KEY, RULE_KEY, ROUTE_KEY]).then(
                  (d) => {
                      for (const [k, v] of Object.entries((d?.[ERR_KEY] || {}) as Record<string, ScriptRuntimeError>)) {
                          if (!runtimeErrors.has(k)) runtimeErrors.set(k, v);
                      }
                      for (const [k, v] of Object.entries((d?.[TYPE_KEY] || {}) as Record<string, string[]>)) {
                          if (!typeErrors.has(k)) typeErrors.set(k, v);
                      }
                      for (const [k, v] of Object.entries((d?.[RULE_KEY] || {}) as Record<string, string[]>)) {
                          if (!ruleErrors.has(k)) ruleErrors.set(k, v);
                      }
                      for (const [k, v] of Object.entries((d?.[ROUTE_KEY] || {}) as Record<string, string[]>)) {
                          if (!routeWarnings.has(k)) routeWarnings.set(k, v);
                      }
                  },
                  () => {}
              )
            : Promise.resolve();
    }
    return errorsLoaded;
}

function errorsChanged(): void {
    if (errorsTimer) return;
    errorsTimer = setTimeout(() => {
        errorsTimer = null;
        void sessionArea()?.set({ [ERR_KEY]: Object.fromEntries(runtimeErrors), [TYPE_KEY]: Object.fromEntries(typeErrors), [RULE_KEY]: Object.fromEntries(ruleErrors), [ROUTE_KEY]: Object.fromEntries(routeWarnings) }).catch(() => {});
        broadcastToUi({
            type: "scriptErrors",
            errors: Object.fromEntries(runtimeErrors),
            typeErrors: Object.fromEntries(typeErrors),
            ruleErrors: Object.fromEntries(ruleErrors),
            routeWarnings: Object.fromEntries(routeWarnings),
        });
    }, 150);
}

export function recordScriptError(scriptId: string, message: string): void {
    void loadErrors().then(() => {
        const prev = runtimeErrors.get(scriptId);
        runtimeErrors.set(scriptId, { message: message.slice(0, 2000), at: Date.now(), count: (prev?.count ?? 0) + 1 });
        errorsChanged();
    });
}

/** Dismiss one script's runtime error, or all of them. */
export async function clearScriptErrors(scriptId?: string): Promise<void> {
    await loadErrors();
    if (scriptId === undefined) {
        if (!runtimeErrors.size) return;
        runtimeErrors.clear();
    } else if (!runtimeErrors.delete(scriptId)) return;
    errorsChanged();
}

export async function getScriptErrors(): Promise<Map<string, ScriptRuntimeError>> {
    await loadErrors();
    return runtimeErrors;
}

export async function getScriptTypeErrors(): Promise<Map<string, string[]>> {
    await loadErrors();
    return typeErrors;
}

/**
 * The editor's TypeScript errors for a script's saved code (empty = clean).
 * They're problems (Problems view), not Log lines.
 */
export async function setScriptTypeErrors(scriptId: string, _name: string, errors: string[]): Promise<void> {
    await loadErrors();
    const prev = typeErrors.get(scriptId) || [];
    const next = errors.slice(0, 50).map((e) => e.slice(0, 500));
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    if (next.length) typeErrors.set(scriptId, next);
    else typeErrors.delete(scriptId);
    errorsChanged();
}

export async function clearScriptTypeErrors(scriptId: string): Promise<void> {
    await loadErrors();
    if (typeErrors.delete(scriptId)) errorsChanged();
}

export async function getScriptRuleErrors(): Promise<Map<string, string[]>> {
    await loadErrors();
    return ruleErrors;
}

/**
 * Replace every script's `rules` errors (scriptId → "onRequest #2: reason").
 * They're problems (Problems view), not Log lines.
 */
export async function setScriptRuleErrors(next: Map<string, string[]>, _names: Map<string, string>): Promise<void> {
    await loadErrors();
    let changed = false;
    for (const id of [...ruleErrors.keys()]) {
        if (!next.has(id)) {
            ruleErrors.delete(id);
            changed = true;
        }
    }
    for (const [id, errs] of next) {
        const prev = ruleErrors.get(id) || [];
        if (JSON.stringify(prev) === JSON.stringify(errs)) continue;
        if (errs.length) ruleErrors.set(id, errs);
        else ruleErrors.delete(id);
        changed = true;
    }
    if (changed) errorsChanged();
}

export async function getScriptRouteWarnings(): Promise<Map<string, string[]>> {
    await loadErrors();
    return routeWarnings;
}

/**
 * Replace every script's route warnings (scriptId → "<route labels>: <why>").
 * They're problems (Problems view), not Log lines.
 */
export async function setScriptRouteWarnings(next: Map<string, string[]>): Promise<void> {
    await loadErrors();
    const cur = JSON.stringify([...routeWarnings].sort(([a], [b]) => a.localeCompare(b)));
    const want = [...next].filter(([, w]) => w.length).sort(([a], [b]) => a.localeCompare(b));
    if (cur === JSON.stringify(want)) return;
    routeWarnings.clear();
    for (const [id, w] of want) routeWarnings.set(id, w);
    errorsChanged();
}
