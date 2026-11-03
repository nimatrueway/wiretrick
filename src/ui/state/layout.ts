import { proxy, subscribe } from "valtio";

export type PanelTab = "problems" | "log" | "network";

/** The Editor's window layout, remembered across sessions. */
export interface PanelLayout {
    sidebarW?: number;
    panelTab?: PanelTab;
    sidebarHidden?: boolean;
    panelHidden?: boolean;
    wordWrap?: boolean;
}

const KEY = "resPanelLayout";

function load(): PanelLayout {
    try {
        const l = JSON.parse(localStorage.getItem(KEY) || "{}");
        return l && typeof l === "object" ? l : {};
    } catch {
        return {};
    }
}

export const layout = proxy<PanelLayout>(load());

// write only what changed over what is stored: another Editor tab may have saved other keys since
let last: PanelLayout = { ...layout };
subscribe(
    layout,
    () => {
        const l = load() as Record<string, unknown>;
        for (const k of Object.keys(layout) as (keyof PanelLayout)[]) if (layout[k] !== last[k]) l[k] = layout[k];
        last = { ...layout };
        try {
            localStorage.setItem(KEY, JSON.stringify(l));
        } catch {}
    },
    true
);
