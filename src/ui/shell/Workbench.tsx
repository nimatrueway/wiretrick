import { useSnapshot } from "valtio";
import { startSidebarDrag } from "../panelDock";
import { dockLayout, dockOf, sideOf } from "../state/dock";
import { layout } from "../state/layout";
import { ExplorerSection } from "../explorer/Explorer";
import { MonacoHost } from "./MonacoHost";
import { EditorToolbar, SplitV } from "./EditorToolbar";
import { Welcome } from "../dialogs/Welcome";
import { UserScriptsBanner } from "./UserScriptsBanner";
import { openHelp, openInstall, openSettings } from "../state/dialogs";
import { useInstallDrop } from "../install/drop";

const cls = (...names: (string | false | undefined)[]): string | undefined => names.filter(Boolean).join(" ") || undefined;

/** The explorer and the Code view (#app); PanelDock puts the panel in. */
export function Workbench() {
    const snap = useSnapshot(layout, { sync: true });
    const dock = useSnapshot(dockLayout, { sync: true });
    // files or a link dropped on the explorer open Install Script with them
    const drop = useInstallDrop((d) => openInstall({ drop: d }));
    return (
        <div id="app" className={cls(snap.sidebarHidden && "sidebar-hidden", snap.panelHidden && "panel-hidden")} data-dock={dockOf(dock)} data-side={sideOf(dock)}>
            <aside id="sidebar" className={drop.over ? "install-drop" : undefined} style={snap.sidebarW ? { width: `${snap.sidebarW}px` } : undefined} {...drop.handlers}>
                <div id="brand" title="Drag to move the explorer to the left or right edge" onMouseDown={(e) => startSidebarDrag(e.nativeEvent)}>
                    <h1>Explorer</h1>
                    <div id="toolbar"><button id="btn-help" title="Sample scripts and keyboard shortcuts" aria-label="Help" onClick={() => openHelp()}>?</button>{" "}<button id="btn-settings" title="Settings (⌘,)" aria-label="Settings" onClick={() => openSettings()}>⚙</button></div>
                </div>
                <ExplorerSection />
            </aside>
            <SplitV />
            <main id="editor-pane">
                <EditorToolbar />
                <UserScriptsBanner />
                <div id="editor-area">
                    <Welcome />
                    <MonacoHost />
                </div>
            </main>
        </div>
    );
}
