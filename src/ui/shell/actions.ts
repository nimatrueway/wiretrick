import type { PanelTab } from "../state/layout";
import type { Problem } from "../problems";
import type { TreeRow } from "../explorerTree";
import type { NewKind } from "../state/explorer";

/**
 * Editor commands the components call; editor.ts fills them in at startup
 * (components can't import editor.ts, which imports them).
 */
export const actions = {
    showPanelTab(_which: PanelTab): void {},
    setPanelHidden(_hidden: boolean): void {},
    /** clear the Log and the Network recording */
    clearPanel(): void {},
    runDiagnostics(): void {},
    openProblem(_id: string, _p: Problem): void {},
    openSettings(_section?: string): void {},
    /** dismiss a script's runtime error */
    dismissError(_id: string): void {},
    focusEditor(): void {},
    /** status-bar message (`cls`: "error") */
    status(_text: string, _cls?: string): void {},
    // ---- explorer ----
    /** open a file (asks to discard unsaved changes) */
    select(_id: string): void {},
    /** asks, then deletes */
    deleteRows(_rows: TreeRow[]): void {},
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
};
