/** ⌘P: go to a script, data file or settings.yaml (driven by quickOpen.ts). */
export function QuickOpen() {
    return (
        <div id="quick-open" className="overlay hidden">
            <div className="dialog qo-dialog"><input id="qo-input" type="text" placeholder="Go to a script or settings.yaml…" autoComplete="off" /><ul id="qo-list" /></div>
        </div>
    );
}
