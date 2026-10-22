/**
 * Rolling per-tab request log, pushed to the manager UI over a port.
 */
import { annotateFromLog, URL_AT_END } from "../network";
import { interventionKind, tappedLine, type InterventionKind, type NetKind } from "../../shared/netTypes";

export interface LogEntry {
    tabId: number;
    scriptId: string | null;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    at: number;
    /** set on "tapped (no change)" lines — the UI caps how many it keeps */
    kind?: NetKind;
}

const MAX_PER_TAB = 200;
const tabLogs = new Map<number, LogEntry[]>();
/**
 * "tapped (no change)" DEBUG lines (one per handler run) get their own small
 * per-tab ring, so a busy page can't evict the useful lines from the
 * replay ring above.
 */
const MAX_TAPPED_PER_TAB = 50;
const tappedLogs = new Map<number, LogEntry[]>();

function pushCapped(rings: Map<number, LogEntry[]>, entry: LogEntry, cap: number): void {
    const list = rings.get(entry.tabId) || [];
    list.push(entry);
    if (list.length > cap) list.splice(0, list.length - cap);
    rings.set(entry.tabId, list);
}

const uiPorts = new Set<chrome.runtime.Port>();

export function addUiPort(port: chrome.runtime.Port): void {
    uiPorts.add(port);
    port.onDisconnect.addListener(() => uiPorts.delete(port));
    // replay this tab's recent logs to the newly connected manager page
    const all: LogEntry[] = [];
    for (const entries of tabLogs.values()) {
        all.push(...entries);
    }
    all.sort((a, b) => a.at - b.at);
    const tapped = [...tappedLogs.values()].flat();
    const replay = tapped.length ? [...all.slice(-MAX_PER_TAB), ...tapped].sort((a, b) => a.at - b.at) : all.slice(-MAX_PER_TAB);
    for (const entry of replay) {
        port.postMessage({ type: "log", entry });
    }
}

/**
 * `kind` marks a script-attributed line that names a request (ends with its
 * URL) as "tapped" (handler ran, no change) or "modified"; omitted, it is
 * inferred (see interventionKind).
 */
export function log(tabId: number, message: string, level: LogEntry["level"] = "info", scriptId: string | null = null, kind?: InterventionKind, url?: string): void {
    const netKind = scriptId ? interventionKind(level, message, kind) : undefined;
    if (scriptId && netKind !== "missed") noteTap(scriptId, level, message);
    const tappedOnly = kind === "tapped" && level === "debug";
    const entry: LogEntry = { tabId, scriptId, level, message, at: Date.now(), ...(tappedOnly ? { kind: "tapped" as const } : {}) };
    if (tappedOnly) pushCapped(tappedLogs, entry, MAX_TAPPED_PER_TAB);
    else pushCapped(tabLogs, entry, MAX_PER_TAB);
    for (const port of uiPorts) {
        port.postMessage({ type: "log", entry });
    }
    if (scriptId) annotateFromLog(tabId, scriptId, message, level, netKind, url);
    if (scriptId && level === "error" && !/^\[[^\]]*\] (console\.error|type error)/.test(message)) recordScriptError(scriptId, message);
    if (level === "error") {
        console.error("[Wiretrick]", message);
    }
}

// ---- tap registry: did a script's handler run for a URL? ----
// Recorded whether or not a manager is open (annotateFromLog needs a port),
// keyed without the tab — the process tier logs with tabId -1. Feeds the
// "modifyResponse never ran" warning (pipeline.ts).

const MAX_TAPS = 2000;
/** `${scriptId}|${url}` → when a body handler last ran (or onRequest ended the request) */
const bodyTaps = new Map<string, number>();
const lastScriptError = new Map<string, number>();
/** lines that mean the body handlers ran — or legitimately never will */
const BODY_TAP = /\b(modifyResponse|replaceResponse)\b|onRequest → (respond|cancel|redirect)\b/;

function noteTap(scriptId: string, level: LogEntry["level"], message: string): void {
    const now = Date.now();
    if (level === "error" && !/^\[[^\]]*\] (console\.error|type error)/.test(message)) lastScriptError.set(scriptId, now);
    if (!BODY_TAP.test(message)) return;
    const m = URL_AT_END.exec(message);
    if (!m) return;
    const key = `${scriptId}|${m[1]}`;
    bodyTaps.delete(key);
    bodyTaps.set(key, now);
    if (bodyTaps.size > MAX_TAPS) bodyTaps.delete(bodyTaps.keys().next().value!);
}

/** Did a body handler of scriptId run for url (or the script throw anywhere) at or after `since` (ms epoch)? */
export function bodyTappedSince(scriptId: string, url: string, since: number): boolean {
    const t = bodyTaps.get(`${scriptId}|${url}`);
    if (t !== undefined && t >= since) return true;
    const e = lastScriptError.get(scriptId);
    return e !== undefined && e >= since;
}

/** test seam */
export function __resetTaps(): void {
    bodyTaps.clear();
    lastScriptError.clear();
}

/** A handler ran for `url` but changed nothing: a DEBUG line that marks the request "tapped". */
export function logTapped(tabId: number, scriptName: string, handler: string, url: string, scriptId: string): void {
    log(tabId, tappedLine(scriptName, handler, url), "debug", scriptId, "tapped");
}

/** every tab's retained LOG lines, oldest first (diagnostic report) */
export function allLogs(): LogEntry[] {
    return [...tabLogs.values(), ...tappedLogs.values()].flat().sort((a, b) => a.at - b.at);
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
    tappedLogs.delete(tabId);
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
const runtimeErrors = new Map<string, ScriptRuntimeError>();
/** TypeScript diagnostics of the SAVED code, reported by the manager's editor */
const typeErrors = new Map<string, string[]>();
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
            ? area.get([ERR_KEY, TYPE_KEY]).then(
                  (d) => {
                      for (const [k, v] of Object.entries((d?.[ERR_KEY] || {}) as Record<string, ScriptRuntimeError>)) {
                          if (!runtimeErrors.has(k)) runtimeErrors.set(k, v);
                      }
                      for (const [k, v] of Object.entries((d?.[TYPE_KEY] || {}) as Record<string, string[]>)) {
                          if (!typeErrors.has(k)) typeErrors.set(k, v);
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
        void sessionArea()?.set({ [ERR_KEY]: Object.fromEntries(runtimeErrors), [TYPE_KEY]: Object.fromEntries(typeErrors) }).catch(() => {});
        broadcastToUi({ type: "scriptErrors", errors: Object.fromEntries(runtimeErrors), typeErrors: Object.fromEntries(typeErrors) });
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
 * Newly appearing errors are logged once at ERROR; unchanged reports are
 * silent, so re-reports (every manager load) don't spam the log.
 */
export async function setScriptTypeErrors(scriptId: string, name: string, errors: string[]): Promise<void> {
    await loadErrors();
    const prev = typeErrors.get(scriptId) || [];
    const next = errors.slice(0, 50).map((e) => e.slice(0, 500));
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    const seen = new Set(prev);
    for (const e of next) if (!seen.has(e)) log(-1, `[${name}] type error: ${e}`, "error", scriptId);
    if (next.length) typeErrors.set(scriptId, next);
    else typeErrors.delete(scriptId);
    errorsChanged();
}

export async function clearScriptTypeErrors(scriptId: string): Promise<void> {
    await loadErrors();
    if (typeErrors.delete(scriptId)) errorsChanged();
}
