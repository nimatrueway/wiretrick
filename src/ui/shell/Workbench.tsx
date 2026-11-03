import { useSnapshot } from "valtio";
import { startSidebarDrag } from "../panelDock";
import { dockLayout, dockOf, sideOf } from "../state/dock";
import { layout } from "../state/layout";
import { MonacoHost } from "./MonacoHost";

const cls = (...names: (string | false | undefined)[]): string | undefined => names.filter(Boolean).join(" ") || undefined;

/** The explorer and the Code view (#app); PanelDock puts the panel in. Sections not yet in React are filled in by editor.ts through their ids. */
export function Workbench() {
    const snap = useSnapshot(layout, { sync: true });
    const dock = useSnapshot(dockLayout, { sync: true });
    return (
        <div id="app" className={cls(snap.sidebarHidden && "sidebar-hidden", snap.panelHidden && "panel-hidden")} data-dock={dockOf(dock)} data-side={sideOf(dock)}>
            <aside id="sidebar" style={snap.sidebarW ? { width: `${snap.sidebarW}px` } : undefined}>
                <div id="brand" title="Drag to move the explorer to the left or right edge" onMouseDown={(e) => startSidebarDrag(e.nativeEvent)}>
                    <h1>Explorer</h1>
                    <div id="toolbar"><button id="btn-help" title="API reference and sample scripts" aria-label="Help">?</button>{" "}<button id="btn-settings" title="Settings (⌘,)" aria-label="Settings">⚙</button></div>
                </div>
                <div id="explorer-section" role="button" tabIndex={-1} aria-expanded="true" title="Wiretrick scripts, data files and folders">
                    <span className="chevron" aria-hidden="true" />
                    <span className="section-title">Wiretrick</span>
                    <div className="section-actions">
                        <button id="btn-new" title="New Script…" aria-label="New Script">
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M9.5 1.5h-6v13h5M9.5 1.5l3 3v4M9.5 1.5v3h3M12.5 10.5v5M10 13h5" /></svg>
                        </button>
                        {" "}
                        <button id="btn-new-json" title="New JSON File… (a data file)" aria-label="New JSON File">
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M5 2.5c-1.5 0-1.5 1-1.5 2.2s0 2-1.5 2.3c1.5.3 1.5 1.1 1.5 2.3s0 2.2 1.5 2.2M10 13.5v-5M7.5 11h5" /><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M11 2.5c1.5 0 1.5 1 1.5 2.2v1.3" /></svg>
                        </button>
                        {" "}
                        <button id="btn-new-folder" title="New Folder…" aria-label="New Folder">
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" d="M8.5 13.5h-7v-10h4.3l1.5 1.5h7.2v3.5M12 9.5v5M9.5 12h5" /></svg>
                        </button>
                        {" "}
                        <button id="btn-collapse-all" title="Collapse Folders in Explorer" aria-label="Collapse Folders in Explorer">
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M4.5 3.5h9v9M2.5 5.5h9v9h-9zM4.5 10h5" /></svg>
                        </button>
                    </div>
                </div>
                <ul id="script-list" role="tree" tabIndex={0} aria-label="Scripts, data files and folders" />
            </aside>
            <div id="split-v" title="Drag to resize" />
            <main id="editor-pane">
                <div id="editor-toolbar">
                    <label id="script-enabled" hidden title="Run this script (also in the explorer's right-click menu)"><span className="switch" /><span>Enabled</span></label>
                    {" "}
                    <span id="typings-note" hidden title="The wt API typings, read-only. Go Back (Alt+← / ⌃- on macOS) returns to your script."><span className="file-icon dts" aria-hidden="true">d.ts</span>wt-api.d.ts<span className="muted">read-only</span></span>
                    {" "}
                    <span id="editor-status" />
                    {" "}
                    <button id="btn-save" disabled data-state="saved" title="Saved — no unsaved changes"><span className="save-ind" aria-hidden="true" /><span className="save-label">Saved</span></button>
                    {" "}
                    <button id="btn-folder-sync" data-state="off" title="Folder sync is off — click to set it up" aria-label="Folder sync: off">
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v7.5h-13z" fill="none" stroke="currentColor" strokeLinejoin="round" /></svg>
                        <span className="sync-ind" aria-hidden="true" />
                    </button>
                    {" "}
                    <button id="btn-open-vscode" disabled title="Open this script's synced file in VS Code (requires Scripts Folder sync)" aria-label="Open in VS Code">
                        <svg className="ico-custom" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
                        <svg className="ico-vscode" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#007ACC" fillRule="evenodd" d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261a1 1 0 0 0 .011 1.5L4.603 12 .338 15.24a1 1 0 0 0-.011 1.5l1.325 1.199a.999.999 0 0 0 1.276.057l4.129-3.129 9.45 8.628a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 6.004L11.323 12l6.681 3.411z" /></svg>
                    </button>
                    {" "}
                    <span id="layout-controls">
                        <button id="btn-toggle-sidebar" className="layout-btn" title="Toggle Explorer (⌘B)" aria-label="Toggle Explorer" aria-pressed={!snap.sidebarHidden}>
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                                <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
                                <path className="fill" d="M2 3h4v10H2z" />
                                <path d="M6.5 3v10" stroke="currentColor" />
                            </svg>
                        </button>
                        {" "}
                        <button id="btn-toggle-panel" className="layout-btn" title="Toggle Panel (⌘J / ⌘`)" aria-label="Toggle Panel" aria-pressed={!snap.panelHidden}>
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                                <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
                                <path className="fill" d="M2 9h12v4H2z" />
                                <path d="M2 8.5h12" stroke="currentColor" />
                            </svg>
                        </button>
                    </span>
                </div>
                <div id="editor-area">
                    <section id="welcome" hidden aria-labelledby="welcome-title">
                        <div className="welcome-inner">
                            <button id="welcome-close" className="btn-close" title="Close the welcome page" aria-label="Close the welcome page" hidden>✕</button>
                            <h1 id="welcome-title">Welcome to Wiretrick</h1>
                            <p className="welcome-lead">Redirect, block or rewrite the requests your browser makes — headers, API responses, whole pages — with a few lines of TypeScript.</p>
                            <p className="welcome-lead">Pick a sample to start. <b>Try it</b> adds it to your scripts, turns it on and opens its page in a new tab. They all use built-in strategies: nothing to install.</p>
                            <div id="welcome-samples" />
                            <div className="welcome-foot">
                                <button id="welcome-new">New empty script</button>
                                {" "}
                                <button id="welcome-reference">API reference</button>
                                {" "}
                                <span className="muted">Reopen this page from Help (?) → Welcome.</span>
                            </div>
                        </div>
                    </section>
                    <MonacoHost />
                </div>
            </main>
        </div>
    );
}
