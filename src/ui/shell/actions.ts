import type { PanelTab } from "../state/layout";
import type { Problem } from "../problems";
import type { TreeRow } from "../explorerTree";
import type { NewKind } from "../state/explorer";
import type { LaunchMode } from "../bundle";
import type { QuickOpenItem } from "../quickOpen";
import type { SampleScript } from "../samples";

/**
 * Editor commands the components call; editor.ts fills them in at startup
 * (components can't import editor.ts, which imports them).
 */
export const actions = {
    showPanelTab(_which: PanelTab): void {},
    setPanelHidden(_hidden: boolean): void {},
    setSidebarHidden(_hidden: boolean): void {},
    /** clear the Log and the Network recording */
    clearPanel(): void {},
    runDiagnostics(): void {},
    openProblem(_id: string, _p: Problem): void {},
    /** dismiss a script's runtime error */
    dismissError(_id: string): void {},
    focusEditor(): void {},
    /** status-bar message (`cls`: "error") */
    status(_text: string, _cls?: string): void {},
    // ---- the Code view's toolbar ----
    save(): void {},
    /** turn the open script on / off */
    toggleEnabled(): void {},
    /** reconnects a saved folder, else opens Settings → Synced folder */
    folderSyncButton(): void {},
    /** ↗: open the file in VS Code (or the custom editor) */
    openInEditor(): void {},
    // ---- explorer ----
    /** open a file (asks to discard unsaved changes) */
    select(_id: string): void {},
    /** asks, then deletes */
    deleteRows(_rows: TreeRow[]): void {},
    /** Make Package…: put the entry script and what it imports in a folder of their own, with a header */
    makePackage(_id: string): void {},
    /** rename / move rows */
    moveRows(_plan: { item: TreeRow; to: string }[]): Promise<void> {
        return Promise.resolve();
    },
    /** why `path` can't be the new path of a `kind` item (other than `selfId`), or "" */
    itemPathProblem(_kind: NewKind, _path: string, _selfId?: string): string {
        return "";
    },
    createItem(_kind: NewKind, _path: string): void {},
    /** shows the explorer, then the inline name input */
    startCreate(_kind: NewKind, _folder?: string): void {},
    setScriptEnabled(_id: string, _enabled: boolean): void {},
    // ---- dialogs ----
    /** ⌘P's list: settings.yaml, the scripts, the data files */
    quickOpenItems(): QuickOpenItem[] {
        return [];
    },
    /** a ⌘P pick: open it and focus the editor */
    openQuick(_id: string): void {},
    /** add a sample as a new (enabled) script and open it; resolves with its id */
    addSample(_sample: SampleScript): Promise<string> {
        return Promise.resolve("");
    },
    /** add a sample, wait until it runs, then open its page (`url`) in a new tab */
    trySample(_sample: SampleScript, _url: string | null): Promise<void> {
        return Promise.resolve();
    },
    /** back from the welcome page to the scripts */
    closeWelcome(): void {},
    // ---- settings ----
    /** Settings → Scripts Folder…: start / stop syncing, or reconnect */
    folderButton(): void {},
    setVscodePath(_path: string): void {},
    setLaunchMode(_mode: LaunchMode): void {},
    setEditorUrl(_url: string): void {},
    setMonacoVerbose(_on: boolean): void {},
    /** pick what to export, then download the YAML bundle */
    exportBundle(): void {},
    /** pick a bundle / script file, then what of it to import */
    importBundle(): void {},
};
