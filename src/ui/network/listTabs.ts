import type { TabInfo } from "./NetworkPanel";

/** The Network view's tab picker: the tabs it can record. */
export async function listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter((t) => t.id !== undefined && t.url && /^(https?|file):/.test(t.url))
        .map((t) => ({ id: t.id!, title: t.title || t.url || `tab ${t.id}` }));
}
