/** Help (?): API reference, samples and keyboard shortcuts (wired up by editor.ts). */
export function HelpDialog() {
    return (
        <div id="help-panel" className="overlay hidden">
            <div className="dialog wide">
                <div className="dialog-head">
                    <div className="dialog-tabs" role="tablist">
                        <button role="tab" data-help-tab="reference" className="active">Reference</button>
                        {" "}
                        <button role="tab" data-help-tab="samples">Samples</button>
                        {" "}
                        <button role="tab" data-help-tab="shortcuts">Shortcuts</button>
                    </div>
                    <span className="dialog-head-actions"><button id="btn-help-welcome" className="btn-link" title="Show the welcome page: try a sample in one click">Welcome</button>{" "}<button className="btn-close" data-close="">✕</button></span>
                </div>
                <div className="dialog-body" id="help-body" data-pane="reference">
                    <input id="help-filter" className="help-filter" type="search" placeholder="Type to search the API reference (e.g. replaceResponse, onDocument, strategy)" autoComplete="off" spellCheck={false} />
                    <div id="help-list" />
                    <p id="help-empty" className="muted" hidden>No matching sections.</p>
                </div>
                <div className="dialog-body" id="samples-body" data-pane="samples" hidden>
                    <input id="samples-filter" className="help-filter" type="search" placeholder="Type to search samples (e.g. cors, replace, headers)" autoComplete="off" spellCheck={false} />
                    <div id="samples-list" />
                    <p id="samples-empty" className="muted" hidden>No matching samples.</p>
                </div>
                <div className="dialog-body" id="shortcuts-body" data-pane="shortcuts" hidden>
                    <input id="shortcuts-filter" className="help-filter" type="search" placeholder="Type to search keybindings (e.g. panel, ctrl+j, explorer)" autoComplete="off" spellCheck={false} />
                    <table id="shortcuts-table">
                        <thead>
                            <tr>
                                <th>Command</th>
                                <th>Keybinding</th>
                                <th>When</th>
                            </tr>
                        </thead>
                        <tbody />
                    </table>
                    <p id="shortcuts-empty" className="muted" hidden>No matching shortcuts.</p>
                </div>
            </div>
        </div>
    );
}
