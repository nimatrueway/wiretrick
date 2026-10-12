/**
 * Background entry point (MV2 event page).
 */
import { WebRequestStrategy } from "./engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "./engine/strategies/chromeBodyStrategy";
import { CdpStrategy } from "./engine/strategies/cdpStrategy";
import { createPipeline } from "./engine/pipeline";
import { addUiPort, clearTab } from "./engine/logs";
import { onScriptsChanged, listScripts } from "./engine/scriptStore";
import { matchAny } from "../shared/matcher";

const IS_FIREFOX =
    typeof (globalThis as any).browser !== "undefined" &&
    typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

const webRequestStrategy = new WebRequestStrategy();
const chromeBody = new ChromeBodyStrategy();
const cdp = new CdpStrategy();

createPipeline(webRequestStrategy, chromeBody, cdp);

// ---- manager UI port: logs stream over it ----
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "logs") {
        addUiPort(port);
    }
});

// ---- CDP debugger events (Tier C) ----
if (chrome.debugger) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method === "Fetch.requestPaused" && source.tabId !== undefined) {
            void cdp.handlePaused(source.tabId, params);
        }
    });
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId !== undefined) {
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
const action = (chrome.browserAction ?? chrome.action) as any;

async function countMatching(url: string | undefined): Promise<number> {
    if (!url || !/^https?:/i.test(url)) return 0;
    const scripts = await listScripts();
    return scripts.filter((s) => s.enabled && matchAny(s.meta.match, url)).length;
}

async function updateTabBadge(tabId: number, url: string | undefined): Promise<void> {
    try {
        const n = await countMatching(url);
        await action.setBadgeBackgroundColor({ color: "#4ec9b0" });
        await action.setBadgeText({ tabId, text: n > 0 ? String(n) : "" });
    } catch {
        /* tab gone */
    }
}

async function updateAllTabs(): Promise<void> {
    try {
        for (const tab of await chrome.tabs.query({})) {
            if (tab.id !== undefined) void updateTabBadge(tab.id, tab.url);
        }
    } catch {
        /* no tabs access */
    }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs
        .get(tabId)
        .then((tab) => updateTabBadge(tabId, tab.url))
        .catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url !== undefined || info.status === "complete") {
        void updateTabBadge(tabId, tab.url);
    }
});
onScriptsChanged(() => void updateAllTabs());
void updateAllTabs();

console.log(`[ResOverride] background ready (${IS_FIREFOX ? "firefox/webRequest+filterResponseData" : "chrome/tiered"})`);
