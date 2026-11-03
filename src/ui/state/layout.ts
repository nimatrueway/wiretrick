import { persistedProxy } from "./persist";

export type PanelTab = "problems" | "log" | "network";

/** The Editor's window layout, remembered across sessions. */
export interface PanelLayout {
    sidebarW?: number;
    panelTab?: PanelTab;
    sidebarHidden?: boolean;
    panelHidden?: boolean;
    wordWrap?: boolean;
}

export const layout = persistedProxy<PanelLayout>("resPanelLayout");

/** The view the panel shows (the Log unless Network or Problems was picked). */
export const panelTabOf = (l: PanelLayout): PanelTab => (l.panelTab === "network" || l.panelTab === "problems" ? l.panelTab : "log");
