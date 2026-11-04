import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ref, useSnapshot } from "valtio";
import { LogFilterBar, type LogFilter } from "../logFilter";
import { NetworkPanel } from "../network/NetworkPanel";
import { listTabs } from "../network/listTabs";
import { applySize, startPanelDrag, startPanelResize } from "../panelDock";
import { actions } from "../shell/actions";
import { keyHint } from "../shortcuts";
import { dockLayout, dockOf } from "../state/dock";
import { layout, panelTabOf, type PanelTab } from "../state/layout";
import { logSources, logState } from "../state/log";
import { panel } from "../state/panel";
import { LogView } from "./LogView";
import { OverlayPreview, PreviewTools } from "./OverlayPreview";
import { ProblemsView } from "./ProblemsView";

const TABS: { tab: PanelTab; id: string; label: string; title: string; key: string }[] = [
    { tab: "problems", id: "problems-tab", label: "Problems", title: "Problems — what is wrong with your scripts right now; each one goes away once fixed", key: "Alt+Shift+P" },
    { tab: "log", id: "log-header-title", label: "Log", title: "Extension and script log", key: "Alt+Shift+L" },
    { tab: "network", id: "network-tab", label: "Network", title: "Network activity, with what Wiretrick scripts did to each request", key: "Alt+Shift+N" },
    { tab: "preview", id: "preview-tab", label: "Preview", title: "Preview — the open script's overlay (wt.onOverlay), live, over a placeholder page", key: "Alt+Shift+V" },
];

const SCROLL_TITLE = {
    follow: "Turn Auto Scrolling Off",
    locked: "Turn Auto Scrolling On",
    paused: "Auto scrolling paused while you're scrolled up — scroll to the end or click to resume",
};

/** The Log's level picker: a native `change` listener, so a scripted `change` (non-bubbling) applies too. */
function LevelSelect() {
    const snap = useSnapshot(logState);
    const sel = useRef<HTMLSelectElement>(null);
    useEffect(() => {
        const el = sel.current!;
        const apply = () => void (logState.level = el.value);
        el.addEventListener("change", apply);
        return () => el.removeEventListener("change", apply);
    }, []);
    useLayoutEffect(() => {
        if (sel.current!.value !== snap.level) sel.current!.value = snap.level;
    }, [snap.level]);
    return (
        <select id="log-level" ref={sel} title="Minimum log level" defaultValue="info">
            <option value="debug">Debug+</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error only</option>
        </select>
    );
}

function ScrollLock() {
    const { scroll } = useSnapshot(logState);
    return (
        <button id="btn-scroll-lock" className="icon-btn" aria-pressed={scroll !== "follow"} data-lock={scroll} title={SCROLL_TITLE[scroll]} aria-label="Scroll lock" onClick={() => void (logState.scroll = scroll === "follow" ? "locked" : "follow")}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <path className="shackle-open" fill="none" stroke="currentColor" strokeWidth="1.3" d="M5.5 7V4.8a2.5 2.5 0 0 1 5-.3" />
                <path className="shackle-shut" fill="none" stroke="currentColor" strokeWidth="1.3" d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7" />
            </svg>
        </button>
    );
}

function ProblemsFilter() {
    const { problemsFilter } = useSnapshot(panel, { sync: true });
    return (
        <input
            id="problems-filter"
            className="panel-filter"
            type="text"
            placeholder="Filter (e.g. text, script name)"
            title="Show only problems whose message or script name contains this text"
            autoComplete="off"
            spellCheck={false}
            value={problemsFilter}
            onChange={(e) => void (panel.problemsFilter = e.target.value)}
        />
    );
}

const logSuggest = () => ({ sources: logSources() });
const setLogFilter = (f: LogFilter) => void (logState.filter = ref(f));

/** The panel's header (view tabs, the open view's tools, actions) and its views. */
function Panel() {
    const tab = panelTabOf(useSnapshot(layout, { sync: true }));
    const snap = useSnapshot(panel, { sync: true });
    const diag = snap.diagnostics;
    const net = snap.net && panel.net; // the store itself (a ref), not a snapshot of it
    const [netHost, setNetHost] = useState<HTMLElement | null>(null);
    return (
        <>
            <div id="log-header" onMouseDown={(e) => startPanelDrag(e.nativeEvent)}>
                <span id="panel-tabs" role="tablist" title="Drag to dock: below the Code view, beside it, or under the script list">
                    {TABS.map((t, i) => (
                        <Fragment key={t.tab}>
                            {i ? " " : null}
                            <span id={t.id} className={tab === t.tab ? "panel-tab active" : "panel-tab"} role="tab" data-panel={t.tab} aria-selected={tab === t.tab} title={`${t.title} (${keyHint(t.key)})`} onClick={() => actions.showPanelTab(t.tab)}>
                                {t.label}
                            </span>
                        </Fragment>
                    ))}
                </span>
                {" "}
                <span id="problems-tools" className="panel-tools" hidden={tab !== "problems"}><ProblemsFilter /></span>
                {" "}
                <span id="log-tools" className="panel-tools" hidden={tab !== "log"}>
                    <span id="log-filter-host"><LogFilterBar data={logSuggest} onFilter={setLogFilter} /></span>
                    {" "}
                    <LevelSelect />
                    {" "}
                    <ScrollLock />
                </span>
                {" "}
                <span id="net-tools" className="panel-tools" hidden={tab !== "network"}><span id="net-filter-host" ref={setNetHost} /></span>
                {" "}
                <span id="preview-tools" className="panel-tools" hidden={tab !== "preview"}><PreviewTools /></span>
                {" "}
                <span id="panel-actions">
                    <button id="btn-clear-panel" className="icon-btn" title={`Clear the Log and Network (${keyHint("Alt+Shift+K")})`} aria-label="Clear the Log and Network" onClick={() => actions.clearPanel()}>
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M2.5 4h9M2.5 7.5h9M2.5 11h4.5M9.5 10l3.5 3.5M13 10l-3.5 3.5" /></svg>
                    </button>
                    {" "}
                    <button
                        id="btn-panel-diagnostics"
                        className="icon-btn"
                        title={diag?.title ?? "Download diagnostics — a report with the log, the recorded network requests, scripts and settings. Review before sharing; cookies/authorization headers are redacted."}
                        data-state={diag?.state}
                        disabled={diag?.state === "busy"}
                        aria-label="Download diagnostics"
                        onClick={() => actions.runDiagnostics()}
                    >
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5 9.5h1.5l1-2 1.5 4 1-2H11" /></svg>
                    </button>
                </span>
                {" "}
                <button id="btn-close-panel" className="icon-btn" title="Close Panel (⌘J)" aria-label="Close Panel" onClick={() => actions.setPanelHidden(true)}>
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                </button>
            </div>
            <LogView hidden={tab !== "log"} />
            <div id="network-view" hidden={tab !== "network"}>
                {net ? <NetworkPanel store={net} listTabs={listTabs} toolsHost={netHost} /> : null}
            </div>
            <ProblemsView hidden={tab !== "problems"} />
            {tab === "preview" ? <OverlayPreview hidden={false} /> : null}
        </>
    );
}

const CONTAINER = { bottom: "editor-area", right: "app", left: "sidebar" } as const;

/**
 * The panel (#log-panel) and its splitter (#split-h). Docking moves them
 * between #editor-area, #app and #sidebar, so they are elements of their own
 * (React renders the panel into one through a portal) that a layout effect
 * appends to the dock's container: whose other children must stay static.
 */
export function PanelDock() {
    const snap = useSnapshot(dockLayout, { sync: true });
    const tab = panelTabOf(useSnapshot(layout, { sync: true }));
    const dock = dockOf(snap);
    const [els] = useState(() => {
        const split = Object.assign(document.createElement("div"), { id: "split-h", title: "Drag to resize" });
        const box = Object.assign(document.createElement("div"), { id: "log-panel" });
        return { split, box };
    });
    useLayoutEffect(() => {
        document.getElementById(CONTAINER[dock])!.append(els.split, els.box);
    }, [dock]);
    useLayoutEffect(() => applySize(els.box, dock, snap.size?.[dock]), [dock, snap.size?.[dock]]);
    useLayoutEffect(() => void (els.box.dataset.tab = tab), [tab]);
    useEffect(() => {
        els.split.addEventListener("mousedown", startPanelResize);
        return () => els.split.removeEventListener("mousedown", startPanelResize);
    }, []);
    return createPortal(<Panel />, els.box);
}
