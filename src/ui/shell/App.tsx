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
            <StatusBar />
            <QuickOpen />
            <SettingsDialog />
            <HelpDialog />
        </>
    );
}
