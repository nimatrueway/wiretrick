/**
 * Rolling per-tab request log, pushed to the manager UI over a port.
 */

export interface LogEntry {
    tabId: number;
    scriptId: string | null;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    at: number;
}

const MAX_PER_TAB = 200;
const tabLogs = new Map<number, LogEntry[]>();

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
    for (const entry of all.slice(-MAX_PER_TAB)) {
        port.postMessage({ type: "log", entry });
    }
}

export function log(tabId: number, message: string, level: LogEntry["level"] = "info", scriptId: string | null = null): void {
    const entry: LogEntry = { tabId, scriptId, level, message, at: Date.now() };
    const list = tabLogs.get(tabId) || [];
    list.push(entry);
    if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
    tabLogs.set(tabId, list);
    for (const port of uiPorts) {
        port.postMessage({ type: "log", entry });
    }
    if (level === "error") {
        console.error("[Wiretrick]", message);
    }
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
}

export function scriptError(scriptId: string, message: string): void {
    log(-1, message, "error", scriptId);
}
