import { useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { flushSync } from "react-dom";
import { currentSide } from "../panelDock";
import { layout } from "../state/layout";
import { settings } from "../state/settings";
import { saveTitle, syncTitle, toolbar } from "../state/toolbar";
import { launchAppName } from "../bundle";
import { actions } from "./actions";

const cls = (...names: (string | false | null | undefined)[]): string | undefined => names.filter(Boolean).join(" ") || undefined;

/** The Code view's toolbar: Enabled switch, typings note, status, Save, folder sync, ↗ and the layout toggles. */
export function EditorToolbar() {
    // sync: the e2e tests (and quick double clicks) see each save state as it is set
    const t = useSnapshot(toolbar, { sync: true });
    const s = useSnapshot(settings);
    const l = useSnapshot(layout, { sync: true });
    const { launchMode, editorUrl } = s;
    const off = launchMode === "off";
    const noUrl = launchMode === "custom" && !editorUrl.trim();
    const app = launchAppName(launchMode);
    const status = t.status;
    return (
        <div id="editor-toolbar">
            <label
                id="script-enabled"
                hidden={t.enabled === null}
                aria-checked={t.enabled === null ? undefined : t.enabled}
                title="Run this script (also in the explorer's right-click menu)"
                onClick={(e) => {
                    e.preventDefault();
                    actions.toggleEnabled();
                }}
            >
                <span className={cls("switch", t.enabled && "on")} />
                <span>Enabled</span>
            </label>
            {" "}
            <span id="typings-note" hidden={!t.typings} title="The tt API typings, read-only. Go Back (Alt+← / ⌃- on macOS) returns to your script.">
                <span className="file-icon dts" aria-hidden="true">d.ts</span>tt-api.d.ts<span className="muted">read-only</span>
            </span>
            {" "}
            <span id="editor-status" className={[status.cls, status.onClick && "clickable"].filter(Boolean).join(" ")} onClick={() => status.onClick?.()}>
                {status.text}
            </span>
            {" "}
            <button id="btn-save" disabled={t.save.disabled} className={cls(t.save.dim && "dim")} data-state={t.save.state} title={saveTitle(t.save.state)} onClick={() => actions.save()}>
                <span className="save-ind" aria-hidden="true" />
                <span className="save-label">{t.save.state === "saved" ? "Saved" : t.save.state === "saving" ? "Saving…" : "Save"}</span>
            </button>
            {" "}
            <button
                id="btn-folder-sync"
                data-state={t.sync.state}
                disabled={!s.folder.supported}
                title={s.folder.supported ? syncTitle(t.sync.state, t.sync.path) : "Folder sync needs the File System Access API (not in Firefox) — use Import/Export"}
                aria-label={`Folder sync: ${t.sync.state}`}
                onClick={() => actions.folderSyncButton()}
            >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v7.5h-13z" fill="none" stroke="currentColor" strokeLinejoin="round" /></svg>
                <span className="sync-ind" aria-hidden="true" />
            </button>
            {" "}
            <button
                id="btn-open-vscode"
                className={cls(launchMode === "vscode-insiders" && "insiders", launchMode === "custom" && "custom")}
                style={off ? { display: "none" } : undefined}
                disabled={off || noUrl || !t.canOpen}
                title={noUrl ? "Set the editor URL in Settings → Open button" : `Open this script's synced file in ${app} (requires a synced folder)`}
                aria-label={`Open in ${app}`}
                onClick={() => actions.openInEditor()}
            >
                <svg className="ico-custom" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
                <svg className="ico-vscode" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#007ACC" fillRule="evenodd" d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261a1 1 0 0 0 .011 1.5L4.603 12 .338 15.24a1 1 0 0 0-.011 1.5l1.325 1.199a.999.999 0 0 0 1.276.057l4.129-3.129 9.45 8.628a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 6.004L11.323 12l6.681 3.411z" /></svg>
            </button>
            {" "}
            <span id="layout-controls">
                <button id="btn-toggle-sidebar" className="layout-btn" title="Toggle Explorer (⌘B)" aria-label="Toggle Explorer" aria-pressed={!l.sidebarHidden} onClick={() => actions.setSidebarHidden(!layout.sidebarHidden)}>
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
                        <path className="fill" d="M2 3h4v10H2z" />
                        <path d="M6.5 3v10" stroke="currentColor" />
                    </svg>
                </button>
                {" "}
                <button id="btn-toggle-panel" className="layout-btn" title="Toggle Panel (⌘J / ⌘`)" aria-label="Toggle Panel" aria-pressed={!l.panelHidden} onClick={() => actions.setPanelHidden(!layout.panelHidden)}>
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
                        <path className="fill" d="M2 9h12v4H2z" />
                        <path d="M2 8.5h12" stroke="currentColor" />
                    </svg>
                </button>
            </span>
        </div>
    );
}

/** The explorer's resize handle: drags the explorer's width (200–620 px), saved when let go. */
export function SplitV() {
    const [dragging, setDragging] = useState(false);
    const handle = useRef<HTMLDivElement>(null);
    return (
        <div
            id="split-v"
            ref={handle}
            className={cls(dragging && "dragging")}
            title="Drag to resize"
            onMouseDown={(e) => {
                e.preventDefault();
                setDragging(true);
                const sidebar = document.getElementById("sidebar")!;
                // straight to the DOM while dragging; the layout store once let go
                const move = (ev: MouseEvent) => {
                    const x = currentSide() === "right" ? window.innerWidth - ev.clientX : ev.clientX;
                    sidebar.style.width = `${Math.min(620, Math.max(200, x))}px`;
                };
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    flushSync(() => {
                        setDragging(false);
                        layout.sidebarW = sidebar.offsetWidth;
                    });
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
            }}
        />
    );
}
