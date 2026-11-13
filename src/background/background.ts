/**
 * Background entry point (MV2 event page).
 */
import { ExtensionStrategy } from "./engine/strategies/extensionStrategy";
import { PageStrategy } from "./engine/strategies/pageStrategy";
import { DebuggerStrategy } from "./engine/strategies/debuggerStrategy";
import { HelperStrategy } from "./engine/strategies/helperStrategy";
import { RulesStrategy } from "./engine/strategies/rulesStrategy";
import { createPipeline } from "./engine/pipeline";
import { startPackageUpdates } from "./engine/packages";
import { installTargetUrl } from "../shared/packageSource";
import { addUiPort, clearTab, clearLogHistory, log, noteRan, broadcastEntry, broadcastToUi, clearScriptErrors, setScriptTypeErrors, onScriptActivity, onScriptProblemsChanged, getScriptProblems } from "./engine/logs";
import { onScriptsChanged, listScripts, refreshStaleMeta } from "./engine/scriptStore";
import { dlog, dlogLevel, getDebugBuffer, pushEntry, clearDebugBuffer, setSink } from "../shared/debugLog";
import * as folderSync from "./folderSync";
import { addNetworkCountsPort, addNetworkPort } from "./network";
import { collectDiagnostics } from "./diagnostics";
import { getSettingsText, applySettingsText, applySettingsDoc } from "./settingsFile";
import { getStoresText, applyStoresText } from "./storesFile";
import { badgeSetText, badgeSetColor, actionSetTitle, tabsQueryAll, tabsGet } from "../shared/chromeApi";
import { createBadgeCounter, badgeLook } from "./badgeCounter";
import { actionIconView, createBusyIndicator } from "./busyIcon";
import { onBusyChange } from "./engine/busy";
import { addBridgePort } from "./engine/bridgePorts";
import { addPreviewPort, addUserScriptPort } from "./engine/overlayLinks";
import { contextTag, SCRIPT_CONTEXTS } from "../shared/scriptLog";

const IS_FIREFOX =
    typeof (globalThis as any).browser !== "undefined" &&
    typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

dlog("bg", "background starting", { firefox: (globalThis as any).browser !== undefined });

// mirror every debug entry into the Editor's Log view
setSink((e) =>
    broadcastEntry({ tabId: -1, scriptId: null, level: e.level || "info", message: `[${e.src}] ${e.msg}`, at: e.at })
);

const extensionStrategy = new ExtensionStrategy();
const pageStrategy = new PageStrategy();
const debuggerStrategy = new DebuggerStrategy();
const helperStrategy = new HelperStrategy();
helperStrategy.onStatus = (status) => broadcastToUi({ type: "processStatus", status });
// MV3: talking to the helper needs the optional `nativeMessaging` permission (Settings → Local helper → Allow)
const onHelperPermission = (p: chrome.permissions.Permissions) => {
    if (p.permissions?.includes("nativeMessaging")) helperStrategy.permissionsChanged();
};
chrome.permissions?.onAdded?.addListener(onHelperPermission);
chrome.permissions?.onRemoved?.addListener(onHelperPermission);

createPipeline(extensionStrategy, pageStrategy, debuggerStrategy, helperStrategy, new RulesStrategy(), updateTabBadge, noteRequestForBadge);

// ---- local helper controls for the Editor ----
chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
    if (msg?.type === "processStatus") {
        sendResponse(helperStrategy.status());
        return false;
    }
    if (msg?.type === "processRetry") {
        helperStrategy.reconnect();
        sendResponse(helperStrategy.status());
        return false;
    }
    if (msg?.type === "processTrustCa") {
        helperStrategy.trustCa();
        sendResponse({});
        return false;
    }
    return false;
});

// ---- synced folder (watching runs here: persistent page, never throttled) ----
void folderSync.initFromStorage();
chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
    if (msg && msg.type === "hookCspBlocked" && _s && _s.tab && _s.tab.id !== undefined) {
        dlogLevel("bg", "info", "page CSP blocks compiling scripts in the page — page-world onPage code runs in the isolated world in this tab", { tabId: _s.tab.id });
        sendResponse({});
        return false;
    }
    if (msg && msg.type === "getSettingsYaml") {
        getSettingsText(msg.text).then((text) => sendResponse({ text }));
        return true;
    }
    if (msg && msg.type === "applySettingsYaml") {
        applySettingsText(msg.text).then(async (r) => {
            if (!r.error) await folderSync.exportSettingsFrom(msg.text);
            sendResponse(r);
        });
        return true;
    }
    if (msg && msg.type === "applySettingsDoc") {
        applySettingsDoc(msg.doc).then(sendResponse);
        return true;
    }
    if (msg && msg.type === "getStoresJson") {
        getStoresText().then((text) => sendResponse({ text }));
        return true;
    }
    if (msg && msg.type === "applyStoresJson") {
        applyStoresText(msg.text).then(async (r) => {
            if (!r.error) await folderSync.exportStoresFrom(msg.text);
            sendResponse(r);
        });
        return true;
    }
    if (msg && msg.type === "ensureStoresOnDisk") {
        folderSync.ensureStoresFile().then(() => sendResponse({}));
        return true;
    }
    if (msg && msg.type === "folderSyncAdopt") {
        // handle was stored to IndexedDB by the sender (handles can't cross
        // runtime messaging — JSON only)
        folderSync.startFromStoredHandle({ fresh: !!msg.fresh }).then((ok) => sendResponse({ ok })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
    if (msg && msg.type === "folderSyncStart") {
        folderSync.startFromStoredHandle({ fresh: !!msg.fresh }).then((ok) => sendResponse({ ok })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
    if (msg && msg.type === "folderSyncStop") {
        folderSync.stop().then(() => sendResponse({}));
        return true;
    }
    if (msg && msg.type === "folderSyncStatus") {
        sendResponse(folderSync.getStatus());
        return false;
    }
    if (msg && msg.type === "folderSyncPreview") {
        folderSync.previewStoredHandle().then((p) => sendResponse(p)).catch((e) => sendResponse({ error: String(e) }));
        return true;
    }
    return false;
});

// ---- manager UI port: logs stream over it ----
// L6: a script's isolated-world onPage code (MV3 chrome.userScripts world)
(chrome.runtime as any).onUserScriptConnect?.addListener((port: chrome.runtime.Port) => addUserScriptPort(port));
chrome.runtime.onConnect.addListener((port) => {
    if (addBridgePort(port)) return; // L2: a content-script bridge
    if (addPreviewPort(port)) return; // L5: the Editor's Preview tab
    if (port.name === "logs") {
        addUiPort(port);
    }
    if (port.name === "network") {
        addNetworkPort(port);
    }
    if (port.name === "network-counts") {
        addNetworkCountsPort(port);
    }
});

// ---- debug log relay: hook/sw/push entries + download support ----
chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    if (msg && msg.type === "scriptLog" && typeof msg.msg === "string") {
        // script output relayed from a page (hook/bridge): into the tab's LOG
        const level = ["debug", "info", "warn", "error"].includes(msg.level) ? msg.level : "info";
        // GUI code's lines say where they came from (onPage main/isolated world, the overlay)
        const ctx = SCRIPT_CONTEXTS.includes(msg.ctx) ? contextTag(msg.ctx, sender.url || sender.tab?.url) : undefined;
        log(sender.tab?.id ?? -1, msg.msg.slice(0, 8000), level, typeof msg.scriptId === "string" ? msg.scriptId : null, undefined, undefined, undefined, ctx);
        sendResponse({});
        return false;
    }
    if (msg && msg.type === "scriptRan" && typeof msg.scriptId === "string") {
        // onPage/onOverlay ran here, or the overlay fetched as the page: the Network row says which script
        noteRan(sender.tab?.id ?? -1, msg.scriptId, String(msg.name ?? ""), msg.api, msg.url);
        sendResponse({});
        return false;
    }
    if (msg && msg.type === "debugLog" && msg.entry) {
        pushEntry(msg.entry); // also mirrors to the UI via the sink
        sendResponse({});
        return false;
    }
    if (msg && msg.type === "openInstallUrl" && typeof msg.url === "string") {
        const target = installTargetUrl(msg.url);
        if (target) {
            const tab = sender.tab;
            chrome.tabs.create(
                {
                    url: chrome.runtime.getURL(`install.html?url=${encodeURIComponent(target)}`),
                    ...(tab?.id !== undefined ? { openerTabId: tab.id } : {}),
                    ...(tab?.index !== undefined ? { index: tab.index + 1 } : {}),
                    ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
                },
                () => void chrome.runtime.lastError
            );
        }
        sendResponse({});
        return false;
    }
    if (msg && msg.type === "getDebugLogs") {
        sendResponse({ entries: getDebugBuffer(), ua: navigator.userAgent, ver: chrome.runtime.getManifest().version });
        return false;
    }
    if (msg && msg.type === "scriptTypeErrors" && typeof msg.scriptId === "string") {
        void setScriptTypeErrors(msg.scriptId, String(msg.name || msg.scriptId), Array.isArray(msg.errors) ? msg.errors.map(String) : []).then(() => sendResponse({}));
        return true;
    }
    if (msg && msg.type === "clearScriptError") {
        void clearScriptErrors(typeof msg.scriptId === "string" ? msg.scriptId : undefined).then(() => sendResponse({}));
        return true;
    }
    if (msg && msg.type === "collectDiagnostics") {
        void collectDiagnostics({
            ...(msg.extra || {}),
            state: { process: helperStrategy.status(), folderSync: folderSync.getStatus() },
        })
            .then((report) => sendResponse({ report }))
            .catch((e) => sendResponse({ error: String(e?.message || e) }));
        return true;
    }
    if (msg && msg.type === "clearDebugLogs") {
        clearDebugBuffer();
        clearLogHistory();
        sendResponse({});
        return false;
    }
    return false;
});

// debug seam: raw buffer access for e2e/diagnostics
(globalThis as any).__resDebugBuffer = getDebugBuffer;

// ---- CDP debugger events (debugger strategy) ----
if (chrome.debugger) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method === "Fetch.requestPaused" && source.tabId !== undefined) {
            const pp = params as any; dlog("debugger", "requestPaused", { tabId: source.tabId, url: pp?.request?.url, status: pp?.responseStatusCode });
            void debuggerStrategy.handlePaused(`tab:${source.tabId}`, params);
        }
    });
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId !== undefined) {
            dlog("debugger", "detached", { tabId: source.tabId });
            void debuggerStrategy.handleDetach(`tab:${source.tabId}`);
        } else if (source.targetId) {
            dlog("debugger", "detached", { targetId: source.targetId });
            void debuggerStrategy.handleDetach(`tgt:${source.targetId}`);
        }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        void debuggerStrategy.detach(tabId);
    });
}

// ---- tab lifecycle logging ----
chrome.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
    badge.forget(tabId);
    saveBadge();
});

// ---- reopen the manager after an extension reload (Chrome kills the
// old page's renderer; the fresh instance restores it) ----
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get("resManagerOpen", (d) => {
        if (!d || !d.resManagerOpen) return;
        chrome.tabs.query({}, (tabs) => {
            if (tabs.some((t) => t.url && t.url.includes("editor.html"))) return;
            dlogLevel("bg", "info", "extension reloaded with the Editor open — reopening it as a tab");
            // reopen in a tab of the last focused window — not a new window
            chrome.windows.getLastFocused((win) => {
                if (win && win.id !== undefined) {
                    chrome.tabs.create({ windowId: win.id, url: chrome.runtime.getURL("editor.html") });
                } else {
                    chrome.windows.create({ url: chrome.runtime.getURL("editor.html"), width: 1100, height: 750 });
                }
            });
        });
    });
});

// ---- badge: per-tab count of enabled scripts active on the tab (a
// network route matched one of its requests, or its onPage code ran
// there); its color says whether any of them has a problem ----
let cachedScripts: import("./engine/scriptStore").Script[] = [];
const badge = createBadgeCounter(() => cachedScripts);
const BADGE_KEY = "badgeTabs";
// MV3: the service worker stops when idle; the counts outlive it
const badgeRestored: Promise<void> = (async () => {
    try {
        const d = await chrome.storage?.session?.get(BADGE_KEY);
        badge.restore(d?.[BADGE_KEY]);
    } catch {}
})();
let badgeSaveTimer: ReturnType<typeof setTimeout> | null = null;
function saveBadge(): void {
    if (badgeSaveTimer || !chrome.storage?.session) return;
    badgeSaveTimer = setTimeout(() => {
        badgeSaveTimer = null;
        chrome.storage.session.set({ [BADGE_KEY]: badge.save() }).catch(() => {});
    }, 300);
}

async function refreshCache(): Promise<void> {
    cachedScripts = await listScripts();
}
onScriptsChanged(() => void refreshCache());
void refreshStaleMeta().catch((e) => dlogLevel("bg", "warn", `refreshing stored script meta failed: ${e?.message || e}`));

/** Record scripts with a network route matching a request from a tab (a page load starts over; the pipeline redraws it); returns the active count. */
function noteRequestForBadge(tabId: number, url: string, newPage = false): number {
    const before = badge.count(tabId);
    const n = badge.note(tabId, url, newPage);
    if (newPage) saveBadge();
    else if (n !== before) {
        saveBadge();
        tabsGet(tabId).then((tab) => updateTabBadge(tabId, tab?.url));
    }
    return n;
}
// page code ran (or failed) on a tab
onScriptActivity((tabId, scriptId) => {
    const before = badge.count(tabId);
    if (badge.ran(tabId, scriptId) === before) return;
    saveBadge();
    tabsGet(tabId).then((tab) => updateTabBadge(tabId, tab?.url));
});
onScriptProblemsChanged(() => void updateAllTabs(false));

// toolbar icon while a script change is compiled and hot-reloaded
onBusyChange(createBusyIndicator(actionIconView()));

// the popup asks which scripts make up the badge number on its tab
chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
    if (msg?.type !== "activeScripts" || typeof msg.tabId !== "number") return false;
    badgeRestored.then(() => sendResponse(badge.ids(msg.tabId)));
    return true;
});

/** Redraw a tab's badge (`url`: the tab's page). */
async function updateTabBadge(tabId: number, url: string | undefined): Promise<void> {
    await badgeRestored;
    const ids = url && /^https?:/i.test(url) ? badge.ids(tabId) : [];
    const problems = ids.length ? await getScriptProblems() : new Map();
    const names = ids.map((id) => cachedScripts.find((s) => s.id === id)?.meta.name || id);
    const look = badgeLook(names, ids.map((id) => problems.get(id)));
    await badgeSetColor(look.color, tabId);
    await badgeSetText(ids.length ? String(ids.length) : "", tabId);
    await actionSetTitle(look.title, tabId);
}

async function updateAllTabs(reread = true): Promise<void> {
    if (reread) await refreshCache();
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

// opening a *.tangitweak.ts URL or any package URL marked with
// #tangitweak:install offers to install it, like a userscript manager
chrome.tabs.onUpdated.addListener((tabId, info) => {
    const target = info.url ? installTargetUrl(info.url) : null;
    if (!target) return;
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`install.html?url=${encodeURIComponent(target)}`) }, () => void chrome.runtime.lastError);
});
startPackageUpdates();

// ---- MV3: warm the analyze cache at SW start so the first page's
// getHookBundle is served from storage, not a cold sandbox round-trip ----
if (__MV3__) {
    void (async () => {
        try {
            const { listScripts } = await import("./engine/scriptStore");
            const { analyzeScripts } = await import("./compileHost");
            await analyzeScripts((await listScripts()).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt })));
            dlog("bg", "analyze cache warmed");
        } catch (e: any) {
            dlogLevel("bg", "warn", `warming the script analyze cache failed (scripts are analyzed on first use instead): ${e?.message || e}`);
        }
    })();
}

console.log(`[TangiTweak] background ready (${__MV3__ ? "mv3/sandbox" : IS_FIREFOX ? "firefox/webRequest+filterResponseData" : "chrome/mv2"})`);
