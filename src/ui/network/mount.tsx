import { render } from "preact";
import { effect } from "@preact/signals";
import { createNetStore } from "./netStore";
import { NetworkPanel, type TabInfo } from "./NetworkPanel";
import type { NetEntry } from "../../shared/netTypes";

async function listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter((t) => t.id !== undefined && t.url && /^(https?|file):/.test(t.url))
        .map((t) => ({ id: t.id!, title: t.title || t.url || `tab ${t.id}` }));
}

/** `onEntries` sees the recorded rows after every change (Network count). */
export function mountNetworkPanel(el: HTMLElement, onEntries?: (entries: NetEntry[]) => void): void {
    const store = createNetStore();
    if (onEntries) effect(() => onEntries(store.entries.value));
    store.connect();
    render(<NetworkPanel store={store} listTabs={listTabs} />, el);
}
