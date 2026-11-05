import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { explorer } from "../state/explorer";
import { layout } from "../state/layout";
import { attachFrame, preview, previewPrefs, reloadPreview, setPreviewUrl, showPreview, stopPreview, VIEWPORTS } from "../state/preview";

/** the open file, if it's a script (not settings.yaml, a data file or the typings) */
function useOpenScript(): string | null {
    const { selectedId, typingsShown, scripts } = useSnapshot(explorer);
    return !typingsShown && selectedId && scripts.some((s) => s.id === selectedId) ? selectedId : null;
}

function PreviewUrl() {
    const snap = useSnapshot(preview);
    const [text, setText] = useState(snap.url);
    useLayoutEffect(() => setText(snap.url), [snap.url, snap.frameKey]);
    const apply = () => (text.trim() === snap.url ? setText(snap.url) : setPreviewUrl(text));
    return (
        <input
            id="preview-url"
            className="panel-filter"
            type="text"
            placeholder="Page URL (ctx.url)"
            title="The URL the overlay sees as its page (ctx.url); its overlay handlers whose route matches it run. Empty: the first URL its routes name"
            autoComplete="off"
            spellCheck={false}
            disabled={!snap.scriptId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => {
                if (e.key === "Enter") apply();
                else if (e.key === "Escape") setText(snap.url);
            }}
        />
    );
}

/** The Preview tab's tools: the page URL, the viewport, reload, and what doesn't work like on a page. */
export function PreviewTools() {
    const snap = useSnapshot(preview);
    const prefs = useSnapshot(previewPrefs);
    return (
        <>
            <PreviewUrl />{" "}
            <select id="preview-viewport" title="Viewport size" value={prefs.viewport ?? "fit"} onChange={(e) => void (previewPrefs.viewport = e.target.value)}>
                {VIEWPORTS.map((v) => (
                    <option key={v} value={v}>
                        {v === "fit" ? "Fit" : v}
                    </option>
                ))}
            </select>{" "}
            <button id="btn-preview-reload" className="icon-btn" title="Reload the preview" aria-label="Reload the preview" disabled={!snap.scriptId} onClick={() => void reloadPreview()}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></svg>
            </button>
            {snap.status === "ready" && !snap.matching ? (
                <span id="preview-nomatch" className="preview-badge" title={`None of this script's ${snap.handlers} overlay handlers matches this URL: nothing runs. Change the URL.`}>
                    no handler matches
                </span>
            ) : null}
            {snap.bgFetches ? (
                <span id="preview-bg-badge" className="preview-badge" title={`There's no page here: ${snap.bgFetches} page fetch${snap.bgFetches === 1 ? "" : "es"} (fetch, from: "page") ran from the background instead — without the page's cookies or origin`}>
                    fetch runs from the background
                </span>
            ) : null}
        </>
    );
}

const sizeOf = (v: string | undefined) => {
    const m = /^(\d+)×(\d+)$/.exec(v ?? "");
    return m ? { width: `${m[1]}px`, height: `${m[2]}px`, flex: "none", margin: "auto" } : undefined;
};

/**
 * The Preview tab: the open script's overlay in its own `overlay.html`
 * frame over a checkerboard "page" (state/preview.ts hosts it). Runs only
 * while the tab shows.
 */
export function OverlayPreview({ hidden }: { hidden: boolean }) {
    const snap = useSnapshot(preview);
    const prefs = useSnapshot(previewPrefs);
    const { panelHidden } = useSnapshot(layout);
    const script = useOpenScript();
    const active = !hidden && !panelHidden;
    useEffect(() => {
        if (active) showPreview(script);
        else stopPreview();
    }, [active, script]);
    useEffect(() => () => stopPreview(), []);
    // the frame loads again when the panel is docked elsewhere: its nonce is spent
    const loaded = useRef(0);
    const msg = !script ? "Open a script with an overlay handler (wt.onPage with dom: \"overlay\") to preview its overlay here." : snap.status === "error" ? snap.message : "";
    return (
        <div id="preview-view" hidden={hidden}>
            {msg ? <div className="preview-msg">{msg}</div> : null}
            <div className="preview-stage" hidden={!!msg}>
                <div className="preview-page" style={sizeOf(prefs.viewport)}>
                    {active && snap.nonce ? (
                        <iframe
                            key={snap.frameKey}
                            src={`${chrome.runtime.getURL("overlay.html")}#${snap.nonce}`}
                            title={`${snap.name} (preview)`}
                            allowTransparency
                            onLoad={(e) => {
                                if (loaded.current === snap.frameKey) return void reloadPreview();
                                loaded.current = snap.frameKey;
                                attachFrame(e.currentTarget.contentWindow);
                            }}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}
