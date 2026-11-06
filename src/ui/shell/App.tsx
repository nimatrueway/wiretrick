import { useEffect } from "react";
import { ContextMenu } from "../explorer/ContextMenu";
import { PanelDock } from "../panel/PanelDock";
import { BundlePicker } from "../dialogs/BundlePicker";
import { ConflictDialog } from "../dialogs/ConflictDialog";
import { HelpDialog } from "../dialogs/HelpDialog";
import { QuickOpen } from "../dialogs/QuickOpen";
import { SettingsDialog } from "../dialogs/SettingsDialog";
import { closeDialogs } from "../state/dialogs";
import { StatusBar } from "./StatusBar";
import { Workbench } from "./Workbench";

/** The Editor page. */
export function App() {
    // Esc closes Settings, Help and Quick Open (the conflict dialog and the export/import picker take theirs first)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => void (e.key === "Escape" && closeDialogs());
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);
    return (
        <>
            <Workbench />
            <PanelDock />
            <StatusBar />
            <QuickOpen />
            <SettingsDialog />
            <HelpDialog />
            <ContextMenu />
            <ConflictDialog />
            <BundlePicker />
        </>
    );
}
