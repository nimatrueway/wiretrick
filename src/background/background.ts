/**
 * Background entry point (MV2 event page).
 */
import { WebRequestStrategy } from "./engine/strategies/webRequestStrategy";
import { ChromeBodyStrategy } from "./engine/strategies/chromeBodyStrategy";
import { CdpStrategy } from "./engine/strategies/cdpStrategy";
import { createPipeline } from "./engine/pipeline";
import { addUiPort, clearTab } from "./engine/logs";
import { onScriptsChanged, listScripts } from "./engine/scriptStore";

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

// ---- badge: number of active scripts ----
const action = (chrome.browserAction ?? chrome.action) as any;
async function updateBadge(): Promise<void> {
    try {
        const scripts = await listScripts();
        const active = scripts.filter((s) => s.enabled).length;
        await action.setBadgeBackgroundColor({ color: "#4ec9b0" });
        await action.setBadgeText({ text: active > 0 ? String(active) : "" });
    } catch {
        /* browserAction unavailable */
    }
}
onScriptsChanged(() => void updateBadge());
void updateBadge();

console.log(`[ResOverride] background ready (${IS_FIREFOX ? "firefox/webRequest+filterResponseData" : "chrome/tiered"})`);
