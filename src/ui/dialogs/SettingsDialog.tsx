import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { actions } from "../shell/actions";
import { dialogs, openHelp } from "../state/dialogs";
import { aboutInfo, folderStateText, grantHelperPermission, helperView, queryHelperStatus, refreshAbout, settings, type HelperReport } from "../state/settings";
import { logState } from "../state/log";
import { panel } from "../state/panel";
import { saveTheme, type ThemePref } from "../theme";
import { aboutText } from "../about";
import { cleanFolderPath, copyPathHint, hostOs, type LaunchMode } from "../bundle";
import { BODY_CAP_KEY, BODY_CAP_MAX, BODY_CAP_MIN, DEFAULT_BODY_CAP } from "../../shared/settingsYaml";
import { Overlay, useControl, useFlash } from "./controls";

const SECTIONS: [string, string][] = [
    ["settings-sec-appearance", "Appearance"],
    ["settings-sec-folder", "Synced folder"],
    ["settings-sec-io", "Import / Export"],
    ["settings-sec-helper", "Local helper"],
    ["settings-sec-logging", "Logging"],
    ["settings-sec-network", "Network"],
    ["settings-sec-advanced", "Advanced"],
    ["settings-sec-about", "About"],
];

/** ⌘, — the Settings dialog. */
export function SettingsDialog() {
    const snap = useSnapshot(dialogs);
    const body = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState(SECTIONS[0][0]);
    const show = (id: string): void => {
        document.getElementById(id)?.scrollIntoView({ block: "start" });
        setActive(id);
    };
    const { helper } = useSnapshot(settings);
    // on opening, the helper status is fetched afresh; About (which shows it) follows it
    useEffect(() => void (snap.settings && queryHelperStatus()), [snap.settings]);
    useEffect(() => void (snap.settings && refreshAbout()), [snap.settings, helper]);
    useLayoutEffect(() => {
        if (snap.settings && snap.settingsSection) show(snap.settingsSection.id);
    }, [snap.settings, snap.settingsSection]);
    /** highlight the nav entry of the section at the top of the scrolled body */
    const onScroll = (): void => {
        const b = body.current!;
        const sections = [...b.querySelectorAll<HTMLElement>(".settings-section")];
        const atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - 2;
        const top = b.getBoundingClientRect().top + 24;
        const current = atEnd ? sections[sections.length - 1] : (sections.filter((sec) => sec.getBoundingClientRect().top <= top).pop() ?? sections[0]);
        if (current) setActive(current.id);
    };
    return (
        <Overlay id="settings-panel" open={snap.settings} onClose={() => void (dialogs.settings = false)}>
            <div className="dialog settings">
                <div className="dialog-head"><h2>Settings</h2><button className="btn-close" data-close="">✕</button></div>
                <div className="settings-layout">
                    <nav className="settings-nav" aria-label="Settings sections">
                        {SECTIONS.map(([id, label], i) => (
                            <Fragment key={id}>
                                {i > 0 && " "}
                                <button data-settings-nav={id} className={active === id ? "active" : undefined} onClick={() => show(id)}>{label}</button>
                            </Fragment>
                        ))}
                    </nav>
                    <div className="dialog-body settings-body" ref={body} onScroll={onScroll}>
                        <Appearance />
                        <SyncedFolder />
                        <section id="settings-sec-io" className="settings-section">
                            <h3>Import / Export</h3>
                            <div className="setting">
                                <span className="setting-label">Zip</span>
                                <div className="setting-control">
                                    <div id="settings-io-row" className="setting-inline"><button id="btn-export" onClick={() => actions.exportBundle()}>Export…</button>{" "}<button id="btn-import" onClick={() => actions.importBundle()}>Import…</button></div>
                                    <p className="setting-help">Export any subset of scripts, data files, folders and settings.yaml to a zip laid out like the scripts folder. Import such a zip (or a zipped scripts folder), picking which of its files to take, or a single .ts/.tsx/.js file.</p>
                                </div>
                            </div>
                        </section>
                        <LocalHelper />
                        <Logging />
                        <Network />
                        <Advanced />
                        <About />
                    </div>
                </div>
            </div>
        </Overlay>
    );
}

function Appearance() {
    const snap = useSnapshot(settings);
    const theme = useControl<HTMLSelectElement>(snap.themePref, (el) => saveTheme(el.value as ThemePref));
    return (
        <section id="settings-sec-appearance" className="settings-section">
            <h3>Appearance</h3>
            <div className="setting" id="settings-theme-row">
                <label className="setting-label" htmlFor="settings-theme">Theme</label>
                <div className="setting-control">
                    <select id="settings-theme" ref={theme}>
                        <option value="system">System</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                    </select>
                    <p className="setting-help">System follows the OS. Applies to the Editor (Code view included) and the popup.</p>
                </div>
            </div>
        </section>
    );
}

const pathHelp = copyPathHint(hostOs(navigator.platform));

function SyncedFolder() {
    const snap = useSnapshot(settings);
    const { folder } = snap;
    const row = useRef<HTMLDivElement>(null);
    const path = useControl<HTMLInputElement>(snap.vscodePath, (el) => {
        el.value = cleanFolderPath(el.value);
        actions.setVscodePath(el.value);
    });
    // picking "custom" with no URL yet focuses the URL box once its row shows
    const focusUrl = useRef(false);
    const launch = useControl<HTMLSelectElement>(snap.launchMode, (el) => {
        focusUrl.current = el.value === "custom" && !url.current!.value.trim();
        actions.setLaunchMode(el.value as LaunchMode);
    });
    const url = useControl<HTMLInputElement>(snap.editorUrl, (el) => actions.setEditorUrl(el.value.trim()), "input");
    useEffect(() => {
        if (focusUrl.current && snap.launchMode === "custom") url.current!.focus();
        focusUrl.current = false;
    }, [snap.launchMode]);
    // just picked a folder whose path is missing: draw the eye to it
    useEffect(() => {
        const r = row.current!;
        if (!folder.flash || !folder.pathWarning) return;
        r.classList.remove("flash");
        void r.offsetWidth; // restart the animation
        r.classList.add("flash");
        void r.scrollIntoView({ block: "center", behavior: "smooth" });
        path.current!.focus({ preventScroll: true });
    }, [folder.flash]);
    useLayoutEffect(() => void row.current!.classList.toggle("needs-path", !!folder.pathWarning), [folder.pathWarning]);
    const label = folder.mode === "synced" ? "Change Folder…" : folder.mode === "reconnect" ? "Reconnect" : "Choose Folder…";
    return (
        <section id="settings-sec-folder" className="settings-section">
            <h3>Synced folder</h3>
            <div className="setting">
                <span className="setting-label">Folder</span>
                <div className="setting-control">
                    <div id="settings-folder-row" className="setting-inline">
                        <button
                            id="btn-vscode"
                            disabled={!folder.supported}
                            title={folder.supported ? undefined : "File System Access API unavailable (Firefox) — use Import/Export"}
                            onClick={() => actions.folderButton()}
                        >
                            {label}
                        </button>
                        {folder.mode !== "off" && (
                            <>
                                {" "}
                                <button id="btn-folder-disconnect" title="Stop syncing this folder; its files stay" onClick={() => actions.folderDisconnect()}>
                                    Disconnect
                                </button>
                            </>
                        )}
                        {" "}
                        <span id="folder-state" className="muted">{folderStateText(folder)}</span>
                    </div>
                    <p className="setting-help">Scripts are written there as .ts files; every edit, from either side, syncs instantly.</p>
                </div>
            </div>
            <div className="setting" id="settings-folder-path" ref={row}>
                <label className="setting-label" htmlFor="settings-vscode-path">Folder path</label>
                <div className="setting-control">
                    <input id="settings-vscode-path" ref={path} type="text" spellCheck={false} placeholder={pathHelp.example} title="Absolute path of the synced folder, for the Open in VS Code button" />
                    <p className="setting-help">Absolute path of that folder, used by the ↗ VS Code button — the browser can't read it, so paste it in. <span id="settings-vscode-path-hint">{pathHelp.hint}</span></p>
                    <p id="settings-vscode-path-warn" className="setting-warn" role="alert" hidden={!folder.pathWarning}>{folder.pathWarning}</p>
                </div>
            </div>
            <div className="setting">
                <label className="setting-label" htmlFor="settings-vscode-launch">Open button</label>
                <div className="setting-control">
                    <select id="settings-vscode-launch" ref={launch}>
                        <option value="vscode">VS Code</option>
                        <option value="vscode-insiders">VS Code Insiders</option>
                        <option value="custom">Custom editor (URL)</option>
                        <option value="off">Nothing — hide the button</option>
                    </select>
                    <p className="setting-help">What the ↗ button in the editor toolbar launches.</p>
                </div>
            </div>
            <div className="setting" id="settings-editor-url-row" hidden={snap.launchMode !== "custom"}>
                <label className="setting-label" htmlFor="settings-editor-url">Editor URL</label>
                <div className="setting-control">
                    <input id="settings-editor-url" ref={url} type="text" spellCheck={false} placeholder={"cursor://file{path}:{line}"} title={"URL the ↗ button opens: {path} = absolute file path, {line} = cursor line"} />
                    <p className="setting-help">
                        <code>{"{path}"}</code>
                        {" is the file's absolute path, "}
                        <code>{"{line}"}</code>
                        {" the cursor line. E.g. "}
                        <code>{"cursor://file{path}:{line}"}</code>
                        {", "}
                        <code>{"zed://file{path}:{line}"}</code>
                        {", "}
                        <code>{"idea://open?file={path}&line={line}"}</code>
                        {", "}
                        <code>{"subl://open?url=file://{path}&line={line}"}</code>
                        .
                    </p>
                </div>
            </div>
        </section>
    );
}

function LocalHelper() {
    const { helper } = useSnapshot(settings);
    const view = helper && helperView(helper as HelperReport);
    const [copied, flash] = useFlash();
    return (
        <section id="settings-sec-helper" className="settings-section">
            <h3>Local helper</h3>
            <div className="setting">
                <span className="setting-label">Status</span>
                <div className="setting-control">
                    <div id="process-row" className="setting-inline">
                        <span id="process-state">{view ? view.state : "…"}</span>
                        {" "}
                        <button id="btn-process-grant" hidden={!view?.grant} onClick={grantHelperPermission}>
                            Allow
                        </button>
                        {" "}
                        <button
                            id="btn-process-copy"
                            hidden={!view?.installCommand}
                            data-cmd={view?.installCommand ?? ""}
                            onClick={async () => {
                                await navigator.clipboard.writeText(view?.installCommand || "").catch(() => {});
                                flash("Copied ✓");
                            }}
                        >
                            {copied ?? "Copy install command"}
                        </button>
                        {" "}
                        <button id="btn-process-retry" hidden={view ? !view.retry : false} onClick={() => queryHelperStatus("processRetry")}>Retry</button>
                        {" "}
                        <button id="btn-process-trust" hidden={!view?.trust} onClick={() => chrome.runtime.sendMessage({ type: "processTrustCa" }, () => void chrome.runtime.lastError)}>Trust certificate</button>
                    </div>
                    <pre id="process-detail" className="setting-pre">{view?.detail ?? ""}</pre>
                    <p className="setting-help">Handlers using the <code>helper</code> strategy are intercepted by tangitweak-helper, a small local proxy — no debugger banner, every resource type, Chrome only. More robust than <code>page</code>, which only sees the page's own fetch/XHR calls. Your own proxy setting stays in effect for everything else.</p>
                </div>
            </div>
        </section>
    );
}

function Logging() {
    const log = useSnapshot(logState);
    const { statusBar } = useSnapshot(panel);
    const level = useControl<HTMLSelectElement>(log.level, (el) => {
        chrome.storage.local.set({ resLogLevel: el.value });
        logState.level = el.value;
    });
    const cap = useControl<HTMLInputElement>(String(log.cap), (el) => {
        const n = Math.max(100, Math.min(10000, Number(el.value) || 500));
        el.value = String(n);
        logState.cap = n;
        chrome.storage.local.set({ resLogCap: n });
    });
    const badge = useControl<HTMLInputElement>(statusBar, (el) => {
        panel.statusBar = el.checked;
        chrome.storage.local.set({ resLogBadge: el.checked });
    });
    return (
        <section id="settings-sec-logging" className="settings-section">
            <h3>Logging</h3>
            <div className="setting" id="settings-log-row">
                <label className="setting-label" htmlFor="settings-log-level">Default level</label>
                <div className="setting-control">
                    <select id="settings-log-level" ref={level}>
                        <option value="debug">Debug+</option>
                        <option value="info">Info+</option>
                        <option value="warn">Warn+</option>
                        <option value="error">Error only</option>
                    </select>
                    <p className="setting-help">Minimum level shown in the Log panel (its filter box narrows further).</p>
                </div>
            </div>
            <div className="setting">
                <label className="setting-label" htmlFor="settings-log-cap">Panel history</label>
                <div className="setting-control">
                    <div className="setting-inline"><input id="settings-log-cap" ref={cap} type="number" min="100" max="10000" step="100" title="Max log lines kept in the panel" />{" "}<span className="muted">entries</span></div>
                    <p className="setting-help">Log lines kept in the panel (100–10000).</p>
                </div>
            </div>
            <div className="setting">
                <span className="setting-label">Panel counts</span>
                <div className="setting-control">
                    <label className="setting-check"><input id="settings-log-badge" ref={badge} type="checkbox" /> Count current problems in the Problems view, errors/warnings in the Log view and observed/modified requests in the Network view, in the status bar</label>
                    <p className="setting-help">Problems counts follow the scripts — they drop as problems are fixed. Log and Network counts stay until the view is cleared. Network counts start once the Network view has been opened (that starts recording). Observed: a script handler ran on the request without changing it; modified: a handler changed it.</p>
                </div>
            </div>
        </section>
    );
}

function Network() {
    const { bodyCap } = useSnapshot(settings);
    const cap = useControl<HTMLInputElement>(String(bodyCap), (el) => {
        const n = Math.max(BODY_CAP_MIN, Math.min(BODY_CAP_MAX, Math.round(Number(el.value)) || DEFAULT_BODY_CAP));
        el.value = String(n);
        settings.bodyCap = n;
        if (n === DEFAULT_BODY_CAP) chrome.storage.local.remove(BODY_CAP_KEY);
        else chrome.storage.local.set({ [BODY_CAP_KEY]: n });
    });
    return (
        <section id="settings-sec-network" className="settings-section">
            <h3>Network</h3>
            <div className="setting">
                <label className="setting-label" htmlFor="settings-body-cap">Body capture</label>
                <div className="setting-control">
                    <div className="setting-inline"><input id="settings-body-cap" ref={cap} type="number" min="16" max="16384" step="64" title="Max kB of each body kept in the Network view" />{" "}<span className="muted">kB per body</span></div>
                    <p className="setting-help">How much of each request/response body the Network view keeps (16–16384 kB); longer bodies are cut. Applies to requests captured afterwards. Large values use more memory.</p>
                </div>
            </div>
        </section>
    );
}

function Advanced() {
    const { monacoVerbose } = useSnapshot(settings);
    const verbose = useControl<HTMLInputElement>(monacoVerbose, (el) => actions.setMonacoVerbose(el.checked));
    return (
        <section id="settings-sec-advanced" className="settings-section">
            <h3>Advanced</h3>
            <div className="setting">
                <span className="setting-label">Editor tracing</span>
                <div className="setting-control">
                    <label className="setting-check"><input id="settings-monaco-verbose" ref={verbose} type="checkbox" /> Verbose Monaco logging</label>
                    <p className="setting-help">Logs navigation, definition lookups and key/mouse triggers to the Log panel.</p>
                </div>
            </div>
        </section>
    );
}

function About() {
    const { about, diagnostics } = useSnapshot(settings);
    const [copied, flashCopy] = useFlash();
    const [reportCopied, flashReport] = useFlash();
    const copy = (text: string, flash: (t: string) => void) =>
        navigator.clipboard.writeText(text).then(
            () => flash("Copied ✓"),
            () => flash("Copy failed")
        );
    const { latest } = about;
    return (
        <section id="settings-sec-about" className="settings-section">
            <h3>About</h3>
            <dl id="about-info">
                {aboutInfo(about).map(([k, v]) => (
                    <Fragment key={k}>
                        <dt>{k}</dt>
                        <dd className={k === "Commit" || k === "Extension ID" ? "mono" : k === "Latest" && latest.url && latest.update ? "about-update" : undefined}>
                            {v}
                            {k === "Latest" && latest.url && (
                                <>
                                    {" · "}
                                    <a href={latest.url} target="_blank" rel="noopener">{latest.update ? "download" : "releases"}</a>
                                </>
                            )}
                        </dd>
                    </Fragment>
                ))}
            </dl>
            <div className="setting-inline">
                <button
                    id="btn-about-copy"
                    onClick={async () => {
                        if (!settings.about.rows.length) await refreshAbout();
                        await copy(aboutText(aboutInfo(settings.about)), flashCopy);
                    }}
                >
                    {copied ?? "Copy"}
                </button>
                {" "}
                <button
                    id="btn-about-help"
                    title="Sample scripts and keyboard shortcuts (the ? in the editor toolbar)"
                    onClick={() => {
                        dialogs.settings = false;
                        openHelp();
                    }}
                >
                    Help…
                </button>
                {" "}
                <button id="btn-diagnostics" disabled={diagnostics.busy} onClick={() => actions.runDiagnostics()}>Collect diagnostics…</button>
                {" "}
                <span id="diagnostics-state" className="muted" title={diagnostics.title || undefined}>{diagnostics.text}</span>
                {" "}
                <button id="btn-diagnostics-copy" hidden={!diagnostics.report} onClick={() => void copy(settings.diagnostics.report, flashReport)}>{reportCopied ?? "Copy report"}</button>
            </div>
            <p className="setting-help">Set Log level to debug and open the Network tab, reproduce the problem, then collect. Review before sharing — scripts, settings and URLs are included; cookies/authorization headers are redacted.</p>
        </section>
    );
}
