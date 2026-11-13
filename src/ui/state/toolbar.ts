import { proxy } from "valtio";

export type SaveState = "saved" | "unsaved" | "saving";
/** the folder sync button: off / saved folder awaiting a permission click / synced / busy */
export type SyncState = "off" | "disconnected" | "connected" | "sending" | "receiving";

/** The Code view's toolbar, which editor.ts drives. */
export const toolbar = proxy({
    /** the Save button is the save indicator: ● unsaved, spinner while saving, ✓ saved */
    save: { state: "saved" as SaveState, disabled: true, dim: false },
    /** the open script's Enabled switch; null hides it (settings.json, data files, libraries, the typings) */
    enabled: null as boolean | null,
    /** tt-api.d.ts is shown read-only */
    typings: false,
    /** the status line; with `onClick` it is a link-like action */
    status: { text: "", cls: "", onClick: null as (() => void) | null },
    sync: { state: "off" as SyncState, path: "" },
    /** folder sync is on and a file is open: ↗ can open it */
    canOpen: false,
});

const SYNC_TITLE: Record<SyncState, (where: string) => string> = {
    off: () => "Folder sync is off — click to set it up",
    disconnected: () => "Folder sync disconnected — click to reconnect",
    connected: (w) => `Synced with${w || " the folder"} — click for folder sync settings`,
    sending: (w) => `Writing changes to${w || " the folder"}…`,
    receiving: (w) => `Reading changes from${w || " the folder"}…`,
};

/** the folder sync button's tooltip */
export function syncTitle(state: SyncState, path: string): string {
    return SYNC_TITLE[state](path ? ` "${path}"` : "");
}

export function saveTitle(state: SaveState): string {
    return state === "saved" ? "Saved — no unsaved changes" : state === "saving" ? "Saving…" : "Unsaved changes — Save (⌘S)";
}
