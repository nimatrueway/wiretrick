import { Fragment, useEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { actions } from "../shell/actions";
import { dialogs, showHelpTab, type HelpTab } from "../state/dialogs";
import { API_REFERENCE } from "../apiReference";
import { SAMPLES } from "../samples";
import { SHORTCUTS, filterShortcuts, formatKey, keysFor } from "../shortcuts";
import { Overlay, matchesFilter } from "./controls";
import { STRATEGIES } from "../../shared/route";
import { STRATEGY_DOC_URL, STRATEGY_INFO, strategyUnsupported } from "../../shared/strategyInfo";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const strategyEnv = { firefox: typeof (globalThis as any).browser?.webRequest?.filterResponseData === "function", mv3: __MV3__ };
const strategyText = STRATEGIES.map((s) => `${s} ${STRATEGY_INFO[s].pros} ${STRATEGY_INFO[s].cons}`).join(" ");

/** every strategy's pros and cons; the ones this browser can't run are greyed out with why */
function StrategyTable() {
    return (
        <>
            <table id="help-strategy-table" className="strategy-table">
                <tbody>
                    <tr>
                        <th>Strategy</th>
                        <th>Pros</th>
                        <th>Cons</th>
                    </tr>
                    {STRATEGIES.map((s) => {
                        const why = strategyUnsupported(s, strategyEnv);
                        return (
                            <tr key={s} className={why ? "unavailable" : undefined}>
                                <td>
                                    <code>{s}</code>
                                    {why && <div className="strategy-why">{why}</div>}
                                </td>
                                <td>{STRATEGY_INFO[s].pros}</td>
                                <td>{STRATEGY_INFO[s].cons}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <p className="muted strategy-doc">
                Which strategy works in which browser:{" "}
                <a id="help-strategy-doc" href={STRATEGY_DOC_URL} target="_blank" rel="noopener">
                    Compatibility
                </a>
            </p>
        </>
    );
}

const TABS: [HelpTab, string][] = [
    ["reference", "Reference"],
    ["samples", "Samples"],
    ["shortcuts", "Shortcuts"],
];

/** Help (?): API reference, samples and keyboard shortcuts. */
export function HelpDialog() {
    const snap = useSnapshot(dialogs);
    const tab = snap.helpTab;
    const [filter, setFilter] = useState<Record<HelpTab, string>>({ reference: "", samples: "", shortcuts: "" });
    const inputs = useRef<Partial<Record<HelpTab, HTMLInputElement | null>>>({});
    // a tab shown: its filter takes the keyboard
    useEffect(() => {
        if (!snap.helpShown) return;
        const t = setTimeout(() => inputs.current[dialogs.helpTab]?.focus());
        return () => clearTimeout(t);
    }, [snap.helpShown]);
    const filterBox = (pane: HelpTab, id: string, placeholder: string) => (
        <input
            id={id}
            ref={(el) => void (inputs.current[pane] = el)}
            className="help-filter"
            type="search"
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={filter[pane]}
            onChange={(e) => setFilter({ ...filter, [pane]: e.target.value })}
        />
    );
    const reference = API_REFERENCE.map((s) => ({ s, shown: matchesFilter(s.title + s.body + (s.table === "strategies" ? strategyText : ""), filter.reference) }));
    // a card's text (as the filter sees it) includes its button
    const samples = SAMPLES.map((s) => ({ s, shown: matchesFilter(s.name + "Use this" + s.blurb + s.code, filter.samples) }));
    const shortcuts = filterShortcuts(SHORTCUTS, filter.shortcuts, isMac);
    return (
        <Overlay id="help-panel" open={snap.help} onClose={() => void (dialogs.help = false)}>
            <div className="dialog wide">
                <div className="dialog-head">
                    <div className="dialog-tabs" role="tablist">
                        {TABS.map(([id, label], i) => (
                            <Fragment key={id}>
                                {i > 0 && " "}
                                <button role="tab" data-help-tab={id} className={tab === id ? "active" : undefined} aria-selected={tab === id} onClick={() => showHelpTab(id)}>{label}</button>
                            </Fragment>
                        ))}
                    </div>
                    <span className="dialog-head-actions">
                        <button
                            id="btn-help-welcome"
                            className="btn-link"
                            title="Show the welcome page: try a sample in one click"
                            onClick={() => {
                                dialogs.help = false;
                                dialogs.welcome = true;
                            }}
                        >
                            Welcome
                        </button>
                        {" "}
                        <button className="btn-close" data-close="">✕</button>
                    </span>
                </div>
                <div className="dialog-body" id="help-body" data-pane="reference" hidden={tab !== "reference"}>
                    {filterBox("reference", "help-filter", "Type to search the API reference (e.g. replaceResponse, onDocument, strategy)")}
                    <div id="help-list">
                        {reference.map(({ s, shown }) => (
                            <div key={s.title} className="api-section" hidden={!shown}>
                                <div className="api-title">{s.title}</div>
                                <pre>{s.body}</pre>
                                {s.table === "strategies" && <StrategyTable />}
                            </div>
                        ))}
                    </div>
                    <p id="help-empty" className="muted" hidden={reference.some((r) => r.shown)}>No matching sections.</p>
                </div>
                <div className="dialog-body" id="samples-body" data-pane="samples" hidden={tab !== "samples"}>
                    {filterBox("samples", "samples-filter", "Type to search samples (e.g. cors, replace, headers)")}
                    <div id="samples-list">
                        {samples.map(({ s, shown }) => (
                            <div key={s.name} className="sample" hidden={!shown}>
                                <div className="sample-head">
                                    <span className="sample-name">{s.name}</span>
                                    <button
                                        className="btn-use"
                                        onClick={async () => {
                                            await actions.addSample(s);
                                            dialogs.help = false;
                                        }}
                                    >
                                        Use this
                                    </button>
                                </div>
                                <div className="sample-blurb">{s.blurb}</div>
                                <pre>{s.code}</pre>
                            </div>
                        ))}
                    </div>
                    <p id="samples-empty" className="muted" hidden={samples.some((r) => r.shown)}>No matching samples.</p>
                </div>
                <div className="dialog-body" id="shortcuts-body" data-pane="shortcuts" hidden={tab !== "shortcuts"}>
                    {filterBox("shortcuts", "shortcuts-filter", "Type to search keybindings (e.g. panel, ctrl+j, explorer)")}
                    <table id="shortcuts-table">
                        <thead>
                            <tr>
                                <th>Command</th>
                                <th>Keybinding</th>
                                <th>When</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shortcuts.map((s, i) => (
                                <tr key={i}>
                                    <td>{s.action}</td>
                                    <td>
                                        {keysFor(s, isMac).map((k, i) => (
                                            <Fragment key={k}>
                                                {i > 0 && " / "}
                                                <kbd>{formatKey(k, isMac)}</kbd>
                                            </Fragment>
                                        ))}
                                    </td>
                                    <td className="muted">{s.where}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p id="shortcuts-empty" className="muted" hidden={shortcuts.length > 0}>No matching shortcuts.</p>
                </div>
            </div>
        </Overlay>
    );
}
