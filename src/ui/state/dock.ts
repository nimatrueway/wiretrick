import { persistedProxy } from "./persist";

export type Dock = "bottom" | "right" | "left";
export type Side = "left" | "right";

/** Where the panel and the explorer are docked, remembered across sessions. */
export interface DockLayout {
    dock?: Dock;
    /** which window edge the explorer sits on */
    side?: Side;
    /** panel size per dock: height for bottom/left, width for right */
    size?: Partial<Record<Dock, number>>;
}

export const dockLayout = persistedProxy<DockLayout>("resPanelDock");

export const dockOf = (l: DockLayout): Dock => (l.dock === "right" || l.dock === "left" ? l.dock : "bottom");
export const sideOf = (l: DockLayout): Side => (l.side === "right" ? "right" : "left");
