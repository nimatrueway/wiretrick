import type { PanelTab } from "../state/layout";
import type { Problem } from "../problems";

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
};
