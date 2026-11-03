import { ContextMenu } from "../explorer/ContextMenu";
import { PanelDock } from "../panel/PanelDock";
import { HelpDialog } from "./HelpDialog";
import { QuickOpen } from "./QuickOpen";
import { SettingsDialog } from "./SettingsDialog";
import { StatusBar } from "./StatusBar";
import { Workbench } from "./Workbench";

/** The Editor page. */
export function App() {
    return (
        <>
            <Workbench />
            <PanelDock />
            <StatusBar />
            <QuickOpen />
            <SettingsDialog />
            <HelpDialog />
            <ContextMenu />
        </>
    );
}
