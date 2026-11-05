/**
 * The install page: opened for a *.wiretrick.ts URL (the background sends
 * such tabs here, like GreaseMonkey's .user.js), from the Explorer's "Install from URL / folder / zip",
 * and to review a held update (`?update=<package id>`).
 */
import { useEffect, useMemo, useState } from "react";
import type { Analysis } from "../../background/engine/packages";
import { describeCapabilities } from "../../shared/packageCaps";
import { entryIds, packageName, type InstalledPackage, type PackageVersion } from "../../shared/packageModel";
import { isManifestPath, MANIFEST_FILE } from "../../shared/packageMetadata";
import { parseSource, sourceLabel } from "../../shared/packageSource";
import { isPackageFile, localPackage, startsIn } from "../../shared/localPackage";
import { diffHunks, lineDiff } from "../../shared/lineDiff";
import { readZip } from "../../shared/zip";
import { fetchFrom, installedTexts, packagesApi, type Fetched } from "./api";

type State =
    | { phase: "pick"; error?: string; local?: { label: string; files: Record<string, string>; entries: string[] } }
    | { phase: "loading"; what: string }
    | { phase: "review"; fetched: Fetched; analysis: Analysis; existing?: InstalledPackage; before?: Record<string, string> }
    | { phase: "pending"; pkg: InstalledPackage; pending: PackageVersion & { reasons: string[]; added: string[] }; before: Record<string, string>; analysis: Analysis }
    | { phase: "nothing"; pkg: InstalledPackage; note?: string }
    | { phase: "done"; pkg: InstalledPackage; verb: string }
    | { phase: "error"; error: string; retry?: () => void };

const closeTab = () => chrome.tabs.getCurrent((t) => (t?.id !== undefined ? chrome.tabs.remove(t.id) : window.close()));
const openEditor = (scriptId: string) => location.assign(chrome.runtime.getURL("editor.html") + `?script=${encodeURIComponent(scriptId)}`);
const errText = (e: any) => String(e?.message || e);
const label = (source: string) => {
    const s = parseSource(source);
    return typeof s === "string" ? source : sourceLabel(s);
};
const versionOf = (h: { version?: string }) => (h.version ? ` ${h.version}` : "");

export function InstallPage() {
    const params = useMemo(() => new URLSearchParams(location.search), []);
    const [state, setState] = useState<State>({ phase: "loading", what: "" });

    async function review(fetched: Fetched) {
        setState({ phase: "loading", what: "Checking what it does…" });
        const all = await packagesApi.list();
        const existing = fetched.source ? Object.values(all).find((p) => p.source === fetched.source) : undefined;
        const analysis = await packagesApi.analyze(fetched, existing?.id);
        const before = existing ? await installedTexts(existing) : undefined;
        setState({ phase: "review", fetched, analysis, existing, before });
    }

    async function load(source: string) {
        setState({ phase: "loading", what: `Reading ${label(source)}…` });
        try {
            await review(await fetchFrom(source));
        } catch (e) {
            setState({ phase: "error", error: errText(e), retry: () => void load(source) });
        }
    }

    async function loadUpdate(id: string) {
        setState({ phase: "loading", what: "Reading the update…" });
        try {
            const pkg = (await packagesApi.list())[id];
            if (!pkg) throw new Error("That package isn't installed anymore.");
            if (!pkg.pending) return setState({ phase: "nothing", pkg });
            const fetched: Fetched = { source: pkg.source, entries: pkg.pending.entries, files: pkg.pending.files, revision: pkg.pending.revision, missing: [], bare: [] };
            const analysis = await packagesApi.analyze(fetched, id);
            setState({ phase: "pending", pkg, pending: pkg.pending, before: await installedTexts(pkg), analysis });
        } catch (e) {
            setState({ phase: "error", error: errText(e) });
        }
    }

    useEffect(() => {
        const url = params.get("url");
        const update = params.get("update");
        if (update) void loadUpdate(update);
        else if (url) void load(url);
        else setState({ phase: "pick" });
    }, []);

    async function pickLocal(label: string, files: Record<string, string>) {
        const entries = startsIn(Object.keys(files));
        if (!entries.length) return setState({ phase: "pick", error: `${label} has no script or ${MANIFEST_FILE} to install.` });
        const top = entries.filter((e) => e.split("/").length === entries[0].split("/").length);
        // a metadata.json at the top is the bundle to install
        const bundle = top.find(isManifestPath);
        if (top.length > 1 && !bundle) return setState({ phase: "pick", local: { label, files, entries } });
        await installLocal(files, bundle ?? entries[0]);
    }

    async function installLocal(files: Record<string, string>, start: string) {
        try {
            const p = await localPackage(files, start);
            await review({ source: "", entries: p.entries, files: p.files, revision: p.revision, missing: p.missing, bare: p.bare });
        } catch (e) {
            setState({ phase: "pick", error: errText(e) });
        }
    }

    async function onFolder(list: FileList | null) {
        if (!list?.length) return;
        setState({ phase: "loading", what: "Reading the folder…" });
        const files: Record<string, string> = {};
        let root = "";
        for (const f of Array.from(list)) {
            const rel = (f as any).webkitRelativePath || f.name;
            root = rel.split("/")[0];
            const inner = rel.split("/").slice(1).join("/") || rel;
            if (isPackageFile(inner)) files[inner] = await f.text();
        }
        await pickLocal(`The folder "${root}"`, files);
    }

    async function onZip(file: File | undefined) {
        if (!file) return;
        setState({ phase: "loading", what: `Reading ${file.name}…` });
        try {
            const raw = await readZip(await file.arrayBuffer(), isPackageFile);
            const utf8 = new TextDecoder();
            let files: Record<string, string> = {};
            for (const [p, bytes] of Object.entries(raw)) files[p] = utf8.decode(bytes);
            // a zip of a folder: drop the folder
            const tops = new Set(Object.keys(files).map((p) => (p.includes("/") ? p.split("/")[0] : "")));
            if (tops.size === 1 && !tops.has("")) {
                const top = [...tops][0].length + 1;
                files = Object.fromEntries(Object.entries(files).map(([p, t]) => [p.slice(top), t]));
            }
            await pickLocal(file.name, files);
        } catch (e) {
            setState({ phase: "pick", error: errText(e) });
        }
    }

    switch (state.phase) {
        case "loading":
            return <main className="center dim">{state.what}</main>;
        case "error":
            return (
                <main>
                    <h1>Can't install this</h1>
                    <p className="err">{state.error}</p>
                    {/file URLs/i.test(state.error) && (
                        <p className="dim">
                            Turn on <b>Allow access to file URLs</b> on Wiretrick's page in <code>chrome://extensions</code>, or use <b>Choose a folder…</b> below.
                        </p>
                    )}
                    <div className="actions">
                        {state.retry && <button onClick={state.retry}>Try again</button>}
                        <button onClick={() => setState({ phase: "pick" })}>Install something else…</button>
                        <button onClick={closeTab}>Close</button>
                    </div>
                </main>
            );
        case "pick":
            return <Picker state={state} onUrl={(u) => void load(u)} onFolder={(l) => void onFolder(l)} onZip={(f) => void onZip(f)} onEntry={(files, e) => void installLocal(files, e)} />;
        case "nothing":
            return (
                <main>
                    <Header name={packageName(state.pkg)} metadata={state.pkg.metadata} scripts={state.pkg.entries} source={state.pkg.source} />
                    <p>{state.note ?? "No update is waiting for review."}</p>
                    <div className="actions">
                        {state.pkg.source && (
                            <button
                                className="primary"
                                onClick={async () => {
                                    setState({ phase: "loading", what: "Checking for updates…" });
                                    try {
                                        await packagesApi.check(state.pkg.id);
                                        const pkg = (await packagesApi.list())[state.pkg.id];
                                        if (pkg?.pending) return void loadUpdate(pkg.id);
                                        setState({ phase: "nothing", pkg: pkg ?? state.pkg, note: pkg?.lastError ? `Checking failed: ${pkg.lastError}` : pkg && pkg.updatedAt > state.pkg.updatedAt ? "It updated to the latest version." : "It's up to date." });
                                    } catch (e) {
                                        setState({ phase: "error", error: errText(e) });
                                    }
                                }}
                            >
                                Check now
                            </button>
                        )}
                        <button onClick={closeTab}>Close</button>
                    </div>
                </main>
            );
        case "done":
            return (
                <main>
                    <h1>
                        {state.verb} “{packageName(state.pkg)}”{versionOf(state.pkg.metadata)}
                    </h1>
                    <p className="dim">{state.pkg.folder ? <>Its files are in the Explorer's <b>{state.pkg.folder}</b> folder.</> : <>It's in the Explorer's root.</>}</p>
                    <div className="actions">
                        <button className="primary" onClick={() => openEditor(entryIds(state.pkg)[0])}>
                            Open in the Editor
                        </button>
                        <button onClick={closeTab}>Close</button>
                    </div>
                </main>
            );
        case "review":
            return <Review state={state} setState={setState} />;
        case "pending":
            return <PendingReview state={state} setState={setState} />;
    }
}

function Picker(props: {
    state: Extract<State, { phase: "pick" }>;
    onUrl: (url: string) => void;
    onFolder: (l: FileList | null) => void;
    onZip: (f: File | undefined) => void;
    onEntry: (files: Record<string, string>, entry: string) => void;
}) {
    const [url, setUrl] = useState("");
    const { local, error } = props.state;
    return (
        <main>
            <h1>Install a script</h1>
            <p className="dim">
                A script's URL (<code>.ts</code>), a bundle's <code>{MANIFEST_FILE}</code>, a GitHub repository or folder, or a gist. It installs with the files it imports and can keep itself up to date.
            </p>
            <form
                className="row"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (url.trim()) props.onUrl(url.trim());
                }}
            >
                <input id="install-url" autoFocus placeholder="https://github.com/you/scripts/blob/main/dark.wiretrick.ts" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="primary" type="submit">
                    Read
                </button>
            </form>
            <div className="row">
                <label className="button">
                    Choose a folder…
                    <input id="install-folder" type="file" hidden {...({ webkitdirectory: "" } as any)} onChange={(e) => props.onFolder(e.target.files)} />
                </label>
                <label className="button">
                    Choose a .zip…
                    <input id="install-zip" type="file" hidden accept=".zip,application/zip" onChange={(e) => props.onZip(e.target.files?.[0])} />
                </label>
            </div>
            <p className="dim small">Scripts from a folder or zip don't update themselves.</p>
            {error && <p className="err">{error}</p>}
            {local && (
                <div>
                    <p>{local.label} has more than one script (and no {MANIFEST_FILE} listing them) — which one?</p>
                    <ul className="entries">
                        {local.entries.map((e) => (
                            <li key={e}>
                                <button className="link" onClick={() => props.onEntry(local.files, e)}>
                                    {e}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </main>
    );
}

function Header(props: { name: string; metadata: Analysis["metadata"]; scripts: string[]; source: string }) {
    const { metadata: header } = props;
    return (
        <header>
            <h1>
                {props.name}
                {header.version && <span className="version">{header.version}</span>}
            </h1>
            {header.description && <p className="desc">{header.description}</p>}
            {props.scripts.length > 1 && (
                <p className="meta">
                    A bundle of {props.scripts.length} scripts: {props.scripts.join(", ")}
                </p>
            )}
            <p className="meta dim">
                {props.source ? <>From {label(props.source)}</> : <>From local files</>}
                {header.author && <> · by {header.author}</>}
                {header.license && <> · {header.license}</>}
                {header.homepage && /^https?:\/\//i.test(header.homepage) && (
                    <>
                        {" "}
                        ·{" "}
                        <a href={header.homepage} target="_blank" rel="noreferrer">
                            homepage
                        </a>
                    </>
                )}
            </p>
        </header>
    );
}

function Capabilities(props: { analysis: Analysis; added?: string[] }) {
    return (
        <section>
            <h2>What it does</h2>
            {!!props.added?.length && (
                <ul className="caps">
                    {props.added.map((a) => (
                        <li key={a} className="risk-new">
                            New in this version: {a}
                        </li>
                    ))}
                </ul>
            )}
            <ul className="caps">
                {describeCapabilities(props.analysis.caps).map((c) => (
                    <li key={c.text} className={`risk-${c.risk}`}>
                        {c.text}
                    </li>
                ))}
            </ul>
        </section>
    );
}

function Warnings(props: { analysis: Analysis; fetched?: Fetched; modified?: string[] }) {
    const { analysis, fetched } = props;
    const items: string[] = [];
    if (analysis.error) items.push(`It doesn't compile: ${analysis.error.split("\n")[0]}`);
    for (const m of fetched?.missing ?? []) items.push(`${m.from} imports "${m.spec}", which isn't in the package.`);
    for (const b of fetched?.bare ?? []) items.push(`${b.from} imports "${b.spec}" from your own scripts (it resolves from the Explorer's root) — the package doesn't bring it.`);
    if (props.modified?.length) items.push(`You changed ${props.modified.join(", ")} since it was installed — updating replaces your changes (Roll back brings them back).`);
    if (!items.length) return null;
    return (
        <section>
            <ul className="warnings">
                {items.map((w) => (
                    <li key={w}>{w}</li>
                ))}
            </ul>
        </section>
    );
}

function fileLabel(item: { kind: "script" | "data"; name: string }): string {
    return item.kind === "data" || /\.tsx$/i.test(item.name) ? item.name : `${item.name}.ts`;
}

function Files(props: { files: Record<string, string>; analysis: Analysis; before?: Record<string, string> }) {
    const { files, analysis, before } = props;
    const rels = Object.keys(files).sort();
    const gone = before ? Object.keys(before).filter((r) => !(r in files)) : [];
    return (
        <section>
            <h2>Files</h2>
            {rels.map((rel) => {
                const status = !before ? "" : !(rel in before) ? "added" : before[rel] === files[rel] ? "same" : "changed";
                return (
                    <details key={rel} className={`file ${status}`}>
                        <summary>
                            <code>{fileLabel(analysis.items[rel])}</code>
                            {status && status !== "same" && <span className={`tag ${status}`}>{status}</span>}
                            <span className="dim small">{files[rel].split("\n").length} lines</span>
                        </summary>
                        {status === "changed" ? <Diff before={before![rel]} after={files[rel]} /> : <pre>{files[rel]}</pre>}
                    </details>
                );
            })}
            {gone.map((rel) => (
                <div key={rel} className="file removed">
                    <code>{rel}</code> <span className="tag removed">removed</span>
                </div>
            ))}
        </section>
    );
}

function Diff(props: { before: string; after: string }) {
    const lines = lineDiff(props.before, props.after);
    if (!lines) return <pre>{props.after}</pre>;
    return (
        <pre className="diff">
            {diffHunks(lines).map((l, k) =>
                l ? (
                    <div key={k} className={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}>
                        {l.op} {l.text}
                    </div>
                ) : (
                    <div key={k} className="gap">
                        ⋯
                    </div>
                )
            )}
        </pre>
    );
}

function Review(props: { state: Extract<State, { phase: "review" }>; setState: (s: State) => void }) {
    const { fetched, analysis, existing, before } = props.state;
    const [autoUpdate, setAutoUpdate] = useState(existing?.autoUpdate ?? !!fetched.source);
    const [busy, setBusy] = useState(false);
    const same = existing && existing.revision === fetched.revision && !existing.pending;
    async function run(fn: () => Promise<void>) {
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            props.setState({ phase: "error", error: errText(e) });
        }
    }
    const install = (enabled: boolean) =>
        run(async () => {
            const pkg = await packagesApi.install(fetched, enabled, autoUpdate);
            props.setState({ phase: "done", pkg, verb: "Installed" });
        });
    const update = () =>
        run(async () => {
            let pkg = await packagesApi.offer(existing!.id, fetched, true);
            if (!pkg) throw new Error("That package isn't installed anymore.");
            if (pkg.pending) pkg = await packagesApi.apply(pkg.id);
            if (autoUpdate !== pkg.autoUpdate) await packagesApi.setAutoUpdate(pkg.id, autoUpdate);
            props.setState({ phase: "done", pkg, verb: "Updated" });
        });
    return (
        <main>
            <Header name={analysis.name} metadata={analysis.metadata} scripts={fetched.entries} source={fetched.source} />
            {existing && (
                <p className="note">
                    {same ? "This version is already installed." : <>Installed: {existing.metadata.version || existing.revision.slice(0, 8)} — installing this updates it in place (its settings stay).</>}
                </p>
            )}
            <Capabilities analysis={analysis} added={analysis.added} />
            <Warnings analysis={analysis} fetched={fetched} modified={analysis.modified} />
            <Files files={fetched.files} analysis={analysis} before={before} />
            <footer>
                {fetched.source ? (
                    <label className="check">
                        <input id="install-auto-update" type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} /> Keep it up to date (updates that can do more wait for your review)
                    </label>
                ) : (
                    <span className="dim small">Installed from local files, it won't update itself.</span>
                )}
                <div className="actions">
                    {existing ? (
                        <button id="install-confirm" className="primary" disabled={busy || same || !!analysis.error} onClick={update}>
                            Update
                        </button>
                    ) : (
                        <>
                            <button id="install-confirm" className="primary" disabled={busy} onClick={() => install(true)}>
                                Install
                            </button>
                            <button id="install-disabled" disabled={busy} onClick={() => install(false)}>
                                Install turned off
                            </button>
                        </>
                    )}
                    <button onClick={closeTab}>Cancel</button>
                </div>
            </footer>
        </main>
    );
}

function PendingReview(props: { state: Extract<State, { phase: "pending" }>; setState: (s: State) => void }) {
    const { pkg, pending, before, analysis } = props.state;
    const [busy, setBusy] = useState(false);
    async function run(fn: () => Promise<void>) {
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            props.setState({ phase: "error", error: errText(e) });
        }
    }
    return (
        <main>
            <Header name={analysis.name} metadata={pending.metadata} scripts={pending.entries} source={pkg.source} />
            <p className="note">
                An update from {pkg.metadata.version || pkg.revision.slice(0, 8)} to {pending.metadata.version || pending.revision.slice(0, 8)} waits for your review
                {pending.reasons.length ? <>: {pending.reasons.join("; ")}.</> : "."}
            </p>
            <Capabilities analysis={analysis} added={analysis.added} />
            <Warnings analysis={analysis} modified={analysis.modified} />
            <Files files={pending.files} analysis={analysis} before={before} />
            <footer>
                <span />
                <div className="actions">
                    <button
                        id="update-apply"
                        className="primary"
                        disabled={busy || !!analysis.error}
                        onClick={() =>
                            run(async () => {
                                const next = await packagesApi.apply(pkg.id);
                                props.setState({ phase: "done", pkg: next, verb: "Updated" });
                            })
                        }
                    >
                        Update
                    </button>
                    <button
                        id="update-skip"
                        disabled={busy}
                        onClick={() =>
                            run(async () => {
                                await packagesApi.dismiss(pkg.id);
                                props.setState({ phase: "nothing", pkg, note: "Skipped — the next newer version will be offered." });
                            })
                        }
                    >
                        Skip this version
                    </button>
                    <button onClick={closeTab}>Cancel</button>
                </div>
            </footer>
        </main>
    );
}
