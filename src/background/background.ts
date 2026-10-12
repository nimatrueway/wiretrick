/**
 * Background entry point (MV2 event page).
 */
import { WebRequestStrategy } from "./engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "./engine/strategies/chromeBodyStrategy";
import { CdpStrategy } from "./engine/strategies/cdpStrategy";
import { createPipeline } from "./engine/pipeline";
import { addUiPort, clearTab } from "./engine/logs";
import { onScriptsChanged, listScripts } from "./engine/scriptStore";
import { dlog, getDebugBuffer, pushEntry, clearDebugBuffer } from "../shared/debugLog";
import { badgeSetText, badgeSetColor, tabsQueryAll, tabsGet } from "../shared/chromeApi";
import { matchAny } from "../shared/matcher";

const IS_FIREFOX =
    typeof (globalThis as any).browser !== "undefined" &&
    typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

dlog("bg", "background starting", { firefox: (globalThis as any).browser !== undefined });

const webRequestStrategy = new WebRequestStrategy();
const chromeBody = new ChromeBodyStrategy();
const cdp = new CdpStrategy();
cdp.isClaimed = (url: string) => chromeBody.isClaimed(url);

createPipeline(webRequestStrategy, chromeBody, cdp);

// ---- manager UI port: logs stream over it ----
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "logs") {
        addUiPort(port);
    }
});

// ---- debug log relay: hook/sw/push entries + download support ----
chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
    if (msg && msg.type === "debugLog" && msg.entry) {
        pushEntry(msg.entry);
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
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

// ---- badge: per-tab count of enabled scripts matching the tab URL ----
async function countMatching(url: string | undefined): Promise<number> {
    if (!url || !/^https?:/i.test(url)) return 0;
    const scripts = await listScripts();
    return scripts.filter((s) => s.enabled && matchAny(s.meta.match, url)).length;
}

async function updateTabBadge(tabId: number, url: string | undefined): Promise<void> {
    const n = await countMatching(url);
    await badgeSetColor("#4ec9b0", tabId);
    await badgeSetText(n > 0 ? String(n) : "", tabId);
}

async function updateAllTabs(): Promise<void> {
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
