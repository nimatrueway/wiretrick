import { proxy, ref } from "valtio";
import type { PickItem } from "../pickTree";

export type HelpTab = "samples" | "shortcuts";

export type ConflictChoice = "overwrite" | "theirs" | "cancel";
/** `kind`/`language`: a data file is a "data file" shown as "json" (default: a script, "typescript") */
export interface ConflictOptions {
    name: string;
    theirs: string | null;
    mine: string;
    kind?: string;
    language?: string;
}

export interface PickOptions {
    title: string;
    intro?: string;
    /** shown as a tree (by path) */
    items: PickItem[];
    confirm: string;
    /** `checked`: item indices */
    warn?: (checked: number[]) => { text: string; fix?: number[] } | null;
}

type Request<O, R> = { n: number; opts: O; resolve: (r: R) => void };

/**
 * The Editor's dialogs (all `.overlay`s): which are open and what they show.
 * The save-conflict dialog and the import/export picker are requests that
 * resolve with the user's choice.
 */
export const dialogs = proxy({
    settings: false,
    /** scroll Settings to this section; `n` makes a repeat count */
    settingsSection: null as { id: string; n: number } | null,
    help: false,
    helpTab: "samples" as HelpTab,
    /** bumped when a Help tab is shown, to focus its filter */
    helpShown: 0,
    quickOpen: false,
    /** the welcome page, in place of the Code view */
    welcome: false,
    conflict: null as Request<ConflictOptions, ConflictChoice> | null,
    picker: null as Request<PickOptions, number[] | null> | null,
});

let requests = 0;

/** Settings; `section` scrolls to e.g. "settings-sec-about". */
export function openSettings(section?: string): void {
    dialogs.settings = true;
    if (section) dialogs.settingsSection = { id: section, n: ++requests };
}

/** Help on `tab` (default: the tab it showed last). */
export function openHelp(tab: HelpTab = dialogs.helpTab): void {
    dialogs.help = true;
    showHelpTab(tab);
}

export function showHelpTab(tab: HelpTab): void {
    dialogs.helpTab = tab;
    dialogs.helpShown++;
}

/** Esc: close Settings, Help and Quick Open (the conflict dialog and the picker handle their own keys). */
export function closeDialogs(): void {
    dialogs.settings = dialogs.help = dialogs.quickOpen = false;
}

/** Save conflict: the stored copy changed since the editor loaded it. Resolves with the user's choice. */
export function resolveConflict(opts: ConflictOptions): Promise<ConflictChoice> {
    return new Promise((resolve) => void (dialogs.conflict = ref({ n: ++requests, opts, resolve })));
}

/** Tree of checkboxes for partial import/export. Resolves with the checked item indices, or null when cancelled. */
export function pickItems(opts: PickOptions): Promise<number[] | null> {
    return new Promise((resolve) => void (dialogs.picker = ref({ n: ++requests, opts, resolve })));
}
