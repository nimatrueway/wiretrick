/**
 * Background entry point (MV2 event page).
 */
import { WebRequestStrategy } from "./engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "./engine/strategies/chromeBodyStrategy";
import { CdpStrategy } from "./engine/strategies/cdpStrategy";
import { createPipeline } from "./engine/pipeline";
import { addUiPort, clearTab, broadcastEntry } from "./engine/logs";
import { onScriptsChanged, listScripts } from "./engine/scriptStore";
import { dlog, getDebugBuffer, pushEntry, clearDebugBuffer, setSink } from "../shared/debugLog";
import { badgeSetText, badgeSetColor, tabsQueryAll, tabsGet } from "../shared/chromeApi";
import { matchAny } from "../shared/matcher";

const IS_FIREFOX =
    typeof (globalThis as any).browser !== "undefined" &&
    typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

dlog("bg", "background starting", { firefox: (globalThis as any).browser !== undefined });

// mirror every debug entry into the manager's LOG panel
setSink((e) =>
    broadcastEntry({ tabId: -1, scriptId: null, level: e.level || "info", message: `[${e.src}] ${e.msg}`, at: e.at })
);

const webRequestStrategy = new WebRequestStrategy();
const chromeBody = new ChromeBodyStrategy();
const cdp = new CdpStrategy();
cdp.isClaimed = (url: string) => chromeBody.isClaimed(url);

createPipeline(webRequestStrategy, chromeBody, cdp, updateTabBadge, noteRequestForBadge);

// ---- manager UI port: logs stream over it ----
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "logs") {
        addUiPort(port);
    }
});

// ---- debug log relay: hook/sw/push entries + download support ----
chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
    if (msg && msg.type === "debugLog" && msg.entry) {
        pushEntry(msg.entry); // also mirrors to the UI via the sink
        sendResponse({});
        return false;
    }
    if (msg && msg.type === "getDebugLogs") {
        sendResponse({ entries: getDebugBuffer(), ua: navigator.userAgent, ver: chrome.runtime.getManifest().version });
        return false;
    }
    if (msg && msg.type === "clearDebugLogs") {
        clearDebugBuffer();
        sendResponse({});
        return false;
    }
    return false;
});

// ---- CDP debugger events (Tier C) ----
if (chrome.debugger) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method === "Fetch.requestPaused" && source.tabId !== undefined) {
            const pp = params as any; dlog("cdp", "requestPaused", { tabId: source.tabId, url: pp?.request?.url, status: pp?.responseStatusCode });
            void cdp.handlePaused(source.tabId, params);
        }
    });
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId !== undefined) {
            dlog("cdp", "detached", { tabId: source.tabId });
            void cdp.handleDetach(source.tabId);
        }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        void cdp.detach(tabId);
    });
}

// ---- tab lifecycle logging ----
chrome.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
    tabActiveScripts.delete(tabId);
});

// ---- reopen the manager after an extension reload (Chrome kills the
// old page's renderer; the fresh instance restores it) ----
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get("resManagerOpen", (d) => {
        if (!d || !d.resManagerOpen) return;
        chrome.tabs.query({}, (tabs) => {
            if (tabs.some((t) => t.url && t.url.includes("manager.html"))) return;
            dlog("bg", "extension reloaded with manager open → reopening");
            chrome.windows.create({ url: chrome.runtime.getURL("manager.html"), width: 1100, height: 750 });
        });
    });
});

// ---- badge: per-tab count of enabled scripts active on the tab
// (matching the page URL or any underlying resource request) ----
const tabActiveScripts = new Map<number, Set<string>>();
let cachedScripts: import("./engine/scriptStore").Script[] = [];

async function refreshCache(): Promise<void> {
    cachedScripts = await listScripts();
}
onScriptsChanged(() => void refreshCache());

/** Record scripts matching a request from a tab; returns the active count. */
function noteRequestForBadge(tabId: number, url: string): number {
    if (!/^https?:/i.test(url)) return 0;
    let set = tabActiveScripts.get(tabId);
    if (!set) {
        set = new Set();
        tabActiveScripts.set(tabId, set);
    }
    for (const s of cachedScripts) {
        if (s.enabled && matchAny(s.meta.match, url)) set.add(s.id);
    }
    return set.size;
}

function activeCountForTab(tabId: number, tabUrl: string | undefined): number {
    if (!tabUrl || !/^https?:/i.test(tabUrl)) return 0;
    let set = tabActiveScripts.get(tabId);
    if (!set) {
        set = new Set();
        tabActiveScripts.set(tabId, set);
    }
    for (const s of cachedScripts) {
        if (s.enabled && matchAny(s.meta.match, tabUrl)) set.add(s.id);
    }
    return set.size;
}
async function updateTabBadge(tabId: number, url: string | undefined): Promise<void> {
    const n = activeCountForTab(tabId, url);
    await badgeSetColor("#4ec9b0", tabId);
    await badgeSetText(n > 0 ? String(n) : "", tabId);
}

async function updateAllTabs(): Promise<void> {
    await refreshCache();
    for (const tab of await tabsQueryAll()) {
        if (tab.id !== undefined) void updateTabBadge(tab.id, tab.url);
    }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
    tabsGet(tabId).then((tab) => updateTabBadge(tabId, tab?.url));
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url !== undefined || info.status === "complete") {
        void updateTabBadge(tabId, tab.url);
    }
});
onScriptsChanged(() => void updateAllTabs());
void updateAllTabs();

console.log(`[ResOverride] background ready (${IS_FIREFOX ? "firefox/webRequest+filterResponseData" : "chrome/tiered"})`);
