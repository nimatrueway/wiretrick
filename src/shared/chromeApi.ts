/**
 * MV2-safe promise wrappers for chrome.* APIs. Modern MV2 builds don't
 * support promise-based extension APIs — every call must go through the
 * callback form, which works everywhere.
 */

export function runtimeSendMessage<T = any>(msg: any): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp: any) => {
            const err = (chrome.runtime as any).lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp as T);
        });
    });
}

export function debuggerSend(tabId: number, command: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId } as any, command as any, params as any, (resp: any) => {
            const err = (chrome.runtime as any).lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp);
        });
    });
}

export function debuggerAttach(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3" as any, () => {
            const err = (chrome.runtime as any).lastError;
            if (err) reject(new Error(err.message));
            else resolve();
        });
    });
}

export function debuggerDetach(tabId: number): Promise<void> {
    return new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => { void (chrome.runtime as any).lastError; resolve(); });
    });
}

export function tabsGet(tabId: number): Promise<chrome.tabs.Tab | undefined> {
    return new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => {
            const err = (chrome.runtime as any).lastError;
            resolve(err ? undefined : tab);
        });
    });
}

export function tabsQueryAll(): Promise<chrome.tabs.Tab[]> {
    return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => resolve(tabs || []));
    });
}

export function badgeSetText(text: string, tabId?: number): Promise<void> {
    return new Promise((resolve) => {
        (chrome.browserAction ?? chrome.action).setBadgeText(tabId !== undefined ? { text, tabId } : { text }, () => {
            void (chrome.runtime as any).lastError;
            resolve();
        });
    });
}

export function badgeSetColor(color: string, tabId?: number): Promise<void> {
    return new Promise((resolve) => {
        (chrome.browserAction ?? chrome.action).setBadgeBackgroundColor(tabId !== undefined ? { color, tabId } : { color }, () => {
            void (chrome.runtime as any).lastError;
            resolve();
        });
    });
}

export function storageGet(keys: string | string[] | null): Promise<Record<string, any>> {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys as any, (d) => {
            void (chrome.runtime as any).lastError;
            resolve(d || {});
        });
    });
}

export function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set(items, () => {
            void (chrome.runtime as any).lastError;
            resolve();
        });
    });
}
