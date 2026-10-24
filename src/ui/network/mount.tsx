import { render } from "preact";
import { createNetStore } from "./netStore";
import { NetworkPanel, type TabInfo } from "./NetworkPanel";

async function listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter((t) => t.id !== undefined && t.url && /^(https?|file):/.test(t.url))
        .map((t) => ({ id: t.id!, title: t.title || t.url || `tab ${t.id}` }));
}

export function mountNetworkPanel(el: HTMLElement): void {
    const store = createNetStore();
    store.connect();
    render(<NetworkPanel store={store} listTabs={listTabs} toolsHost={document.getElementById("net-filter-host")} />, el);
}
