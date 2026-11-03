/** ⌘, — the Settings dialog (wired up by editor.ts). */
export function SettingsDialog() {
    return (
        <div id="settings-panel" className="overlay hidden">
            <div className="dialog settings">
                <div className="dialog-head"><h2>Settings</h2><button className="btn-close" data-close="">✕</button></div>
                <div className="settings-layout">
                    <nav className="settings-nav" aria-label="Settings sections">
                        <button data-settings-nav="settings-sec-appearance" className="active">Appearance</button>
                        {" "}
                        <button data-settings-nav="settings-sec-folder">Synced folder</button>
                        {" "}
                        <button data-settings-nav="settings-sec-io">Import / Export</button>
                        {" "}
                        <button data-settings-nav="settings-sec-strategy">Strategies</button>
                        {" "}
                        <button data-settings-nav="settings-sec-helper">Local helper</button>
                        {" "}
                        <button data-settings-nav="settings-sec-logging">Logging</button>
                        {" "}
                        <button data-settings-nav="settings-sec-network">Network</button>
                        {" "}
                        <button data-settings-nav="settings-sec-advanced">Advanced</button>
                        {" "}
                        <button data-settings-nav="settings-sec-about">About</button>
                    </nav>
                    <div className="dialog-body settings-body">
                        <section id="settings-sec-appearance" className="settings-section">
                            <h3>Appearance</h3>
                            <div className="setting" id="settings-theme-row">
                                <label className="setting-label" htmlFor="settings-theme">Theme</label>
                                <div className="setting-control">
                                    <select id="settings-theme">
                                        <option value="system">System</option>
                                        <option value="dark">Dark</option>
                                        <option value="light">Light</option>
                                    </select>
                                    <p className="setting-help">System follows the OS. Applies to the Editor (Code view included) and the popup.</p>
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-folder" className="settings-section">
                            <h3>Synced folder</h3>
                            <div className="setting">
                                <span className="setting-label">Folder</span>
                                <div className="setting-control">
                                    <div id="settings-folder-row" className="setting-inline"><button id="btn-vscode">Scripts Folder…</button>{" "}<span id="folder-state" className="muted" /></div>
                                    <p className="setting-help">Scripts are written there as .ts files; every edit, from either side, syncs instantly.</p>
                                </div>
                            </div>
                            <div className="setting" id="settings-folder-path">
                                <label className="setting-label" htmlFor="settings-vscode-path">Folder path</label>
                                <div className="setting-control">
                                    <input id="settings-vscode-path" type="text" spellCheck={false} placeholder="/Users/you/Wiretrick" title="Absolute path of the synced folder, for the Open in VS Code button" />
                                    <p className="setting-help">Absolute path of that folder, used by the ↗ VS Code button — the browser can't read it, so paste it in. <span id="settings-vscode-path-hint" /></p>
                                    <p id="settings-vscode-path-warn" className="setting-warn" role="alert" hidden />
                                </div>
                            </div>
                            <div className="setting">
                                <label className="setting-label" htmlFor="settings-vscode-launch">Open button</label>
                                <div className="setting-control">
                                    <select id="settings-vscode-launch" defaultValue="vscode">
                                        <option value="vscode">VS Code</option>
                                        <option value="vscode-insiders">VS Code Insiders</option>
                                        <option value="custom">Custom editor (URL)</option>
                                        <option value="off">Nothing — hide the button</option>
                                    </select>
                                    <p className="setting-help">What the ↗ button in the editor toolbar launches.</p>
                                </div>
                            </div>
                            <div className="setting" id="settings-editor-url-row" hidden>
                                <label className="setting-label" htmlFor="settings-editor-url">Editor URL</label>
                                <div className="setting-control">
                                    <input id="settings-editor-url" type="text" spellCheck={false} placeholder={"cursor://file{path}:{line}"} title={"URL the ↗ button opens: {path} = absolute file path, {line} = cursor line"} />
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
                        <section id="settings-sec-io" className="settings-section">
                            <h3>Import / Export</h3>
                            <div className="setting">
                                <span className="setting-label">Bundle</span>
                                <div className="setting-control">
                                    <div id="settings-io-row" className="setting-inline"><button id="btn-export">Export…</button>{" "}<button id="btn-import">Import…</button></div>
                                    <p className="setting-help">Export any subset of scripts (and the global settings) to a YAML bundle. Import a bundle (.yaml/.yml), picking which of its items to take, or a single .ts/.js file.</p>
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-strategy" className="settings-section">
                            <h3>Strategies</h3>
                            <div className="setting">
                                <span className="setting-label" id="settings-strategy-label">Reference</span>
                                <div className="setting-control">
                                    <p className="setting-help">Every handler names the strategy that runs it: <code>{"wt.onRequest({ url, strategy: \"helper\" }, …)"}</code>. There is no default. A handler whose strategy isn't available here doesn't run — it gets a ⚠ and a Log view warning; there is no fallback. <a id="settings-strategy-doc" target="_blank" rel="noopener">Compatibility</a></p>
                                    <table id="settings-strategy-table" className="strategy-table" aria-labelledby="settings-strategy-label" />
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-helper" className="settings-section">
                            <h3>Local helper</h3>
                            <div className="setting">
                                <span className="setting-label">Status</span>
                                <div className="setting-control">
                                    <div id="process-row" className="setting-inline">
                                        <span id="process-state">…</span>
                                        {" "}
                                        <button id="btn-process-copy" hidden>Copy install command</button>
                                        {" "}
                                        <button id="btn-process-retry">Retry</button>
                                        {" "}
                                        <button id="btn-process-trust" hidden>Trust certificate</button>
                                    </div>
                                    <pre id="process-detail" className="setting-pre" />
                                    <p className="setting-help">Handlers using the <code>helper</code> strategy are intercepted by wiretrick-helper, a small local proxy — no debugger banner, every resource type, Chrome only. More robust than <code>page</code>, which only sees the page's own fetch/XHR calls. Your own proxy setting stays in effect for everything else.</p>
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-logging" className="settings-section">
                            <h3>Logging</h3>
                            <div className="setting" id="settings-log-row">
                                <label className="setting-label" htmlFor="settings-log-level">Default level</label>
                                <div className="setting-control">
                                    <select id="settings-log-level">
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
                                    <div className="setting-inline"><input id="settings-log-cap" type="number" min="100" max="10000" step="100" title="Max log lines kept in the panel" />{" "}<span className="muted">entries</span></div>
                                    <p className="setting-help">Log lines kept in the panel (100–10000).</p>
                                </div>
                            </div>
                            <div className="setting">
                                <span className="setting-label">Panel counts</span>
                                <div className="setting-control">
                                    <label className="setting-check"><input id="settings-log-badge" type="checkbox" defaultChecked /> Count current problems in the Problems view, errors/warnings in the Log view and observed/modified requests in the Network view, in the status bar</label>
                                    <p className="setting-help">Problems counts follow the scripts — they drop as problems are fixed. Log and Network counts stay until the view is cleared. Network counts start once the Network view has been opened (that starts recording). Observed: a script handler ran on the request without changing it; modified: a handler changed it.</p>
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-network" className="settings-section">
                            <h3>Network</h3>
                            <div className="setting">
                                <label className="setting-label" htmlFor="settings-body-cap">Body capture</label>
                                <div className="setting-control">
                                    <div className="setting-inline"><input id="settings-body-cap" type="number" min="16" max="16384" step="64" title="Max kB of each body kept in the Network view" />{" "}<span className="muted">kB per body</span></div>
                                    <p className="setting-help">How much of each request/response body the Network view keeps (16–16384 kB); longer bodies are cut. Applies to requests captured afterwards. Large values use more memory.</p>
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-advanced" className="settings-section">
                            <h3>Advanced</h3>
                            <div className="setting">
                                <span className="setting-label">Editor tracing</span>
                                <div className="setting-control">
                                    <label className="setting-check"><input id="settings-monaco-verbose" type="checkbox" /> Verbose Monaco logging</label>
                                    <p className="setting-help">Logs navigation, definition lookups and key/mouse triggers to the Log panel.</p>
                                </div>
                            </div>
                        </section>
                        <section id="settings-sec-about" className="settings-section">
                            <h3>About</h3>
                            <dl id="about-info" />
                            <div className="setting-inline">
                                <button id="btn-about-copy">Copy</button>
                                {" "}
                                <button id="btn-about-help" title="API reference, sample scripts and keyboard shortcuts (the ? in the editor toolbar)">Help…</button>
                                {" "}
                                <button id="btn-diagnostics">Collect diagnostics…</button>
                                {" "}
                                <span id="diagnostics-state" className="muted" />
                                {" "}
                                <button id="btn-diagnostics-copy" hidden>Copy report</button>
                            </div>
                            <p className="setting-help">Set Log level to debug and open the Network tab, reproduce the problem, then collect. Review before sharing — scripts, settings and URLs are included; cookies/authorization headers are redacted.</p>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
