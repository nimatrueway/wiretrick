import { useState } from "react";
import { useSnapshot } from "valtio";
import { actions } from "../shell/actions";
import { dialogs } from "../state/dialogs";
import { explorer } from "../state/explorer";
import { SAMPLES, sampleStrategies, sampleSummary, sampleTryUrl, type SampleScript } from "../samples";

/** The welcome page (onboarding): replaces the Code view while there are no scripts; Help → Welcome reopens it. */
export function Welcome() {
    const { welcome } = useSnapshot(dialogs);
    const { scripts } = useSnapshot(explorer);
    return (
        <section id="welcome" hidden={!welcome} aria-labelledby="welcome-title">
            <div className="welcome-inner">
                {/* nothing to go back to without scripts: no close button then */}
                <button id="welcome-close" className="btn-close" title="Close the welcome page" aria-label="Close the welcome page" hidden={!scripts.length} onClick={() => actions.closeWelcome()}>✕</button>
                <h1 id="welcome-title">Welcome to Wiretrick</h1>
                <p className="welcome-lead">Redirect, block or rewrite the requests your browser makes — headers, API responses, whole pages — with a few lines of TypeScript.</p>
                <p className="welcome-lead">Pick a sample to start. <b>Try it</b> adds it to your scripts, turns it on and opens its page in a new tab. They all use built-in strategies: nothing to install.</p>
                <div id="welcome-samples">
                    {SAMPLES.map((s) => (
                        <WelcomeCard key={s.name} sample={s} />
                    ))}
                </div>
                <div className="welcome-foot">
                    <button id="welcome-new" onClick={() => actions.startCreate("script")}>New empty script</button>
                    {" "}
                    <span className="muted">Reopen this page from Help (?) → Welcome.</span>
                </div>
            </div>
        </section>
    );
}

function WelcomeCard({ sample }: { sample: SampleScript }) {
    const [busy, setBusy] = useState(false);
    const url = sampleTryUrl(sample.code);
    return (
        <article className="welcome-card" data-sample={sample.name}>
            <div className="welcome-card-name">{sample.name}</div>
            <div className="welcome-card-blurb">{sampleSummary(sample.blurb)}</div>
            <div className="welcome-card-foot">
                <span className="welcome-chips">
                    {sampleStrategies(sample.code).map((s) => (
                        <span key={s} className="welcome-chip" title={s === "onPage" ? "Runs in the page at DOM-ready — no network strategy" : s === "overlay" ? "Draws its own GUI over the page" : `strategy: "${s}"`}>{s}</span>
                    ))}
                </span>
                <button title="Add it to your scripts and open its code" onClick={() => void actions.addSample(sample)}>Open</button>
                <button
                    className="primary welcome-try"
                    disabled={busy}
                    title={url ? `Add it, turn it on and open ${url} in a new tab` : "Add it and turn it on"}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await actions.trySample(sample, url);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    Try it
                </button>
            </div>
        </article>
    );
}
