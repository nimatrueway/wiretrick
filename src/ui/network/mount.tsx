import { render } from "preact";
import { createNetStore } from "./netStore";
import { NetworkPanel, type TabInfo } from "./NetworkPanel";
import type { NetPortMsg } from "../../shared/netTypes";

async function listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter((t) => t.id !== undefined && t.url && /^(https?|file):/.test(t.url))
        .map((t) => ({ id: t.id!, title: t.title || t.url || `tab ${t.id}` }));
}

/** `onMessage` sees every recorder message after the panel applied it (tab badge). */
export function mountNetworkPanel(el: HTMLElement, onMessage?: (msg: NetPortMsg) => void): void {
    const store = createNetStore();
    store.connect(onMessage);
    render(<NetworkPanel store={store} listTabs={listTabs} />, el);
}
