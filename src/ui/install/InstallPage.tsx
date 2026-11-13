/**
 * The install flow: read a package (a URL, a folder, a zip, or a drop of any of
 * them), show what it does, install it; or review a held update. The Editor
 * shows it in its Install Script dialog (dialogs/InstallDialog); install.html
 * shows it as a page, for a *.tangitweak.ts URL (the background sends such tabs
 * there, like GreaseMonkey's .user.js) and `?update=<package id>`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "../../background/engine/packages";
import { describeCapabilities } from "../../shared/packageCaps";
import type { PackageStatus } from "../../shared/packageImports";
import { entryIds, packageName, resolvePackageIcon, updateSource, type InstalledPackage, type PackageVersion } from "../../shared/packageModel";
import { compareVersions, isManifestPath, MANIFEST_FILE } from "../../shared/packageMetadata";
import { parseSource, readPackageBrowserFile, sourceLabel, type DownloadProgress } from "../../shared/packageSource";
import { isPackageFile, localPackage, startsIn, unzipPackage } from "../../shared/localPackage";
import { isDataSpec, isImageDataPath, packageUrls } from "../../shared/scriptImports";
import { diffHunks, lineDiff } from "../../shared/lineDiff";
import { fetchFrom, installedTexts, packagesApi, type Fetched } from "./api";
import { useInstallDrop, type Dropped } from "./drop";

/** what to start with: a URL to read, an update to review, or a drop; else the picker */
export interface InstallRequest {
    url?: string;
    update?: string;
    drop?: Promise<Dropped>;
}

/** where the flow runs: the Editor's dialog (`embedded`: its head names it) or the install page */
export interface InstallHost {
    embedded?: boolean;
    close(): void;
    openEditor(scriptId: string): void;
}

type State =
    | { phase: "pick"; error?: string; local?: { label: string; files: Record<string, string>; entries: string[] } }
    | { phase: "loading"; what: string; progress?: DownloadProgress }
    | { phase: "review"; fetched: Fetched; analysis: Analysis }
    | { phase: "pending"; pkg: InstalledPackage; pending: PackageVersion & { reasons: string[]; added: string[] }; before: Record<string, string>; analysis: Analysis }
    | { phase: "nothing"; pkg: InstalledPackage; iconUrl?: string; note?: string }
    | { phase: "done"; pkg: InstalledPackage; verb: string; iconUrl?: string }
    | { phase: "error"; error: string; retry?: () => void };

const errText = (e: any) => String(e?.message || e);
const label = (source: string) => {
    const s = parseSource(source);
    return typeof s === "string" ? source : sourceLabel(s);
};
const versionOf = (h: { version?: string }) => (h.version ? ` ${h.version}` : "");

const pageHost: InstallHost = {
    close: () => chrome.tabs.getCurrent((t) => (t?.id !== undefined ? chrome.tabs.remove(t.id) : window.close())),
    openEditor: (scriptId) => location.assign(chrome.runtime.getURL("editor.html") + `?script=${encodeURIComponent(scriptId)}`),
};

/** install.html: the flow as a page; a drop anywhere on it starts over with what was dropped */
export function InstallPage() {
    const first = useMemo(() => new URLSearchParams(location.search), []);
    const [req, setReq] = useState<InstallRequest & { n: number }>(() => ({ n: 0, url: first.get("url") || undefined, update: first.get("update") || undefined }));
    const { over, handlers } = useInstallDrop((drop) => setReq((r) => ({ n: r.n + 1, drop })));
    return (
        <div className={"install-page" + (over ? " dropping" : "")} {...handlers}>
            <InstallFlow key={req.n} request={req} host={pageHost} />
        </div>
    );
}

export function InstallFlow({ request, host }: { request: InstallRequest; host: InstallHost }) {
    const [state, setState] = useState<State>({ phase: "loading", what: "" });
    const runSeq = useRef(0);
    const { close } = host;

    useEffect(() => () => void runSeq.current++, []);

    async function analyzeWithProgress(fetched: Fetched, myRun: number, updateOf?: string, wasDownloading = false): Promise<Analysis> {
        const urls = [...new Set(Object.entries(fetched.files).filter(([p]) => !isDataSpec(p)).flatMap(([, code]) => packageUrls(code)))];
        let timer: ReturnType<typeof setInterval> | undefined;
        try {
            if (urls.length) {
                const initial = await packagesApi.packageStatus(urls).catch(() => undefined);
                if (runSeq.current !== myRun) return packagesApi.analyze(fetched, updateOf);
                const pendingCount = (st: Record<string, PackageStatus> | undefined) =>
                    urls.filter((u) => {
                        const s = st?.[u]?.state;
                        return !s || s === "missing" || s === "downloading";
                    }).length;
                const left0 = pendingCount(initial?.statuses);
                if (left0 > 0) {
                    const show = (left: number) => {
                        if (runSeq.current !== myRun) return;
                        const done = urls.length - left;
                        setState({
                            phase: "loading",
                            what: "Downloading packages…",
                            progress: { done, total: urls.length, detail: `${done} / ${urls.length} packages` },
                        });
                    };
                    show(left0);
                    timer = setInterval(() => {
                        void packagesApi.packageStatus(urls).then(
                            (res) => timer !== undefined && show(pendingCount(res?.statuses)),
                            () => {}
                        );
                    }, 150);
                } else {
                    setState({ phase: "loading", what: "Checking what it does…", ...(wasDownloading ? { progress: { done: 1, total: 1 } } : {}) });
                }
            } else {
                setState({ phase: "loading", what: "Checking what it does…", ...(wasDownloading ? { progress: { done: 1, total: 1 } } : {}) });
            }
            return await packagesApi.analyze(fetched, updateOf);
        } finally {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        }
    }

    async function review(fetched: Fetched, myRun: number, wasDownloading = false) {
        const analysis = await analyzeWithProgress(fetched, myRun, undefined, wasDownloading);
        if (runSeq.current !== myRun) return;
        setState({ phase: "review", fetched, analysis });
    }

    async function load(source: string) {
        const myRun = ++runSeq.current;
        const what = `Downloading ${label(source)}…`;
        setState({ phase: "loading", what, progress: {} });
        try {
            const fetched = await fetchFrom(source, (progress) => {
                if (runSeq.current === myRun) setState({ phase: "loading", what, progress });
            });
            if (runSeq.current !== myRun) return;
            await review(fetched, myRun, true);
        } catch (e) {
            if (runSeq.current === myRun) setState({ phase: "error", error: errText(e), retry: () => void load(source) });
        }
    }

    async function loadUpdate(id: string) {
        const myRun = ++runSeq.current;
        setState({ phase: "loading", what: "Reading the update…" });
        try {
            const pkg = (await packagesApi.list())[id];
            if (runSeq.current !== myRun) return;
            if (!pkg) throw new Error("That package isn't installed anymore.");
            if (!pkg.pending) {
                const files = await installedTexts(pkg);
                if (runSeq.current !== myRun) return;
                return setState({ phase: "nothing", pkg, iconUrl: resolvePackageIcon({ entries: pkg.entries, files, metadata: pkg.metadata }) });
            }
            const fetched: Fetched = { source: pkg.source, entries: pkg.pending.entries, files: pkg.pending.files, revision: pkg.pending.revision, missing: [], bare: [] };
            const analysis = await analyzeWithProgress(fetched, myRun, id);
            if (runSeq.current !== myRun) return;
            const before = await installedTexts(pkg);
            if (runSeq.current !== myRun) return;
            setState({ phase: "pending", pkg, pending: pkg.pending, before, analysis });
        } catch (e) {
            if (runSeq.current === myRun) setState({ phase: "error", error: errText(e) });
        }
    }

    async function onDrop(drop: Promise<Dropped>) {
        const myRun = ++runSeq.current;
        setState({ phase: "loading", what: "Reading what you dropped…" });
        const d = await drop;
        if (runSeq.current !== myRun) return;
        if ("url" in d) await load(d.url);
        else if ("zip" in d) await onZip(d.zip);
        else if ("files" in d) await pickLocal(d.label, d.files, myRun);
        else setState({ phase: "pick", error: d.error });
    }

    useEffect(() => {
        if (request.drop) void onDrop(request.drop);
        else if (request.update) void loadUpdate(request.update);
        else if (request.url) void load(request.url);
        else setState({ phase: "pick" });
    }, []);

    async function pickLocal(label: string, files: Record<string, string>, myRun = ++runSeq.current) {
        const entries = startsIn(Object.keys(files));
        if (!entries.length) return setState({ phase: "pick", error: `${label} has no script or ${MANIFEST_FILE} to install.` });
        const top = entries.filter((e) => e.split("/").length === entries[0].split("/").length);
        // a metadata.json at the top is the bundle to install
        const bundle = top.find(isManifestPath);
        if (top.length > 1 && !bundle) return setState({ phase: "pick", local: { label, files, entries } });
        await installLocal(files, bundle ?? entries[0], myRun);
    }

    async function installLocal(files: Record<string, string>, start: string, myRun = ++runSeq.current) {
        try {
            const p = await localPackage(files, start);
            if (runSeq.current !== myRun) return;
            await review({ source: "", entries: p.entries, files: p.files, revision: p.revision, missing: p.missing, bare: p.bare }, myRun, false);
        } catch (e) {
            if (runSeq.current === myRun) setState({ phase: "pick", error: errText(e) });
        }
    }

    async function onFolder(list: FileList | null) {
        if (!list?.length) return;
        const myRun = ++runSeq.current;
        setState({ phase: "loading", what: "Reading the folder…" });
        const files: Record<string, string> = {};
        let root = "";
        for (const f of Array.from(list)) {
            const rel = (f as any).webkitRelativePath || f.name;
            root = rel.split("/")[0];
            const inner = rel.split("/").slice(1).join("/") || rel;
            if (isPackageFile(inner)) files[inner] = await readPackageBrowserFile(inner, f);
        }
        if (runSeq.current !== myRun) return;
        await pickLocal(`The folder "${root}"`, files, myRun);
    }

    async function onZip(file: File | undefined) {
        if (!file) return;
        const myRun = ++runSeq.current;
        setState({ phase: "loading", what: `Reading ${file.name}…` });
        try {
            const files = await unzipPackage(await file.arrayBuffer());
            if (runSeq.current !== myRun) return;
            await pickLocal(file.name, files, myRun);
        } catch (e) {
            if (runSeq.current === myRun) setState({ phase: "pick", error: errText(e) });
        }
    }

    return <div className="install-flow">{body()}</div>;

    function body() {
        switch (state.phase) {
            case "loading": {
                const p = state.progress;
                const determinate = p !== undefined && p.total !== undefined && p.total > 0 && p.done !== undefined;
                const pct = determinate ? Math.max(0, Math.min(100, Math.round((p.done! / p.total!) * 100))) : undefined;
                return (
                    <main className="center dim install-loading">
                        {state.what && <div>{state.what}</div>}
                        {p && (
                            <>
                                <div
                                    className={"install-progress" + (determinate ? "" : " indeterminate")}
                                    role="progressbar"
                                    aria-label={state.what || "Downloading"}
                                    aria-valuemin={determinate ? 0 : undefined}
                                    aria-valuemax={determinate ? 100 : undefined}
                                    aria-valuenow={pct}
                                >
                                    <div className="install-progress-bar" style={determinate ? { width: `${pct}%` } : undefined} />
                                </div>
                                {p.detail && <div className="install-progress-detail small">{p.detail}</div>}
                            </>
                        )}
                    </main>
                );
            }
            case "error":
                return (
                    <main>
                        <h1>Can't install this</h1>
                        <p className="err">{state.error}</p>
                        {/file URLs/i.test(state.error) && (
                            <p className="dim">
                                Turn on <b>Allow access to file URLs</b> on TangiTweak's page in <code>chrome://extensions</code>, or use <b>Choose a folder…</b> below.
                            </p>
                        )}
                        <div className="actions">
                            {state.retry && <button onClick={state.retry}>Try again</button>}
                            <button onClick={() => setState({ phase: "pick" })}>Install something else…</button>
                            <button onClick={close}>Close</button>
                        </div>
                    </main>
                );
            case "pick":
                return <Picker state={state} embedded={host.embedded} onUrl={(u) => void load(u)} onFolder={(l) => void onFolder(l)} onZip={(f) => void onZip(f)} onEntry={(files, e) => void installLocal(files, e)} />;
            case "nothing":
                return (
                    <main>
                        <Header name={packageName(state.pkg)} metadata={state.pkg.metadata} scripts={state.pkg.entries} source={state.pkg.source} iconUrl={state.iconUrl} />
                        <p>{state.note ?? "No update is waiting for review."}</p>
                        <div className="actions">
                            {updateSource(state.pkg) && (
                                <button
                                    className="primary"
                                    onClick={async () => {
                                        const myRun = ++runSeq.current;
                                        const prevPkg = state.pkg;
                                        setState({ phase: "loading", what: "Checking for updates…", progress: {} });
                                        try {
                                            await packagesApi.check(prevPkg.id);
                                            if (runSeq.current !== myRun) return;
                                            const pkg = (await packagesApi.list())[prevPkg.id];
                                            if (runSeq.current !== myRun) return;
                                            if (pkg?.pending) return void loadUpdate(pkg.id);
                                            const nextPkg = pkg ?? prevPkg;
                                            const files = await installedTexts(nextPkg);
                                            if (runSeq.current !== myRun) return;
                                            const iconUrl = resolvePackageIcon({ entries: nextPkg.entries, files, metadata: nextPkg.metadata });
                                            setState({ phase: "nothing", pkg: nextPkg, iconUrl, note: pkg?.lastError ? `Checking failed: ${pkg.lastError}` : pkg && pkg.updatedAt > prevPkg.updatedAt ? "It updated to the latest version." : "It's up to date." });
                                        } catch (e) {
                                            if (runSeq.current === myRun) setState({ phase: "error", error: errText(e) });
                                        }
                                    }}
                                >
                                    Check now
                                </button>
                            )}
                            <button onClick={close}>Close</button>
                        </div>
                    </main>
                );
            case "done":
                return (
                    <main>
                        <h1 className="done-title">
                            <PackageIcon src={state.iconUrl} className="pkg-icon-done" />
                            <span>
                                {state.verb} “{packageName(state.pkg)}”{versionOf(state.pkg.metadata)}
                            </span>
                        </h1>
                        <p className="dim">{state.pkg.folder ? <>Its files are in the Explorer's <b>{state.pkg.folder}</b> folder.</> : <>It's in the Explorer's root.</>}</p>
                        <div className="actions">
                            <button className="primary" onClick={() => host.openEditor(entryIds(state.pkg)[0])}>
                                Open in the Editor
                            </button>
                            <button onClick={close}>Close</button>
                        </div>
                    </main>
                );
            case "review":
                return <Review state={state} setState={setState} close={close} />;
            case "pending":
                return <PendingReview state={state} setState={setState} close={close} />;
        }
    }
}

function Picker(props: {
    state: Extract<State, { phase: "pick" }>;
    embedded?: boolean;
    onUrl: (url: string) => void;
    onFolder: (l: FileList | null) => void;
    onZip: (f: File | undefined) => void;
    onEntry: (files: Record<string, string>, entry: string) => void;
}) {
    const [url, setUrl] = useState("");
    const { local, error } = props.state;
    return (
        <main>
            {!props.embedded && <h1>Install a script</h1>}
            <p className="dim">
                A script's URL (<code>.ts</code>), a bundle's <code>{MANIFEST_FILE}</code>, a <code>.zip</code>, a GitHub repository or folder, or a gist. It installs with the files it imports and can keep itself up to date.
            </p>
            <form
                className="row"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (url.trim()) props.onUrl(url.trim());
                }}
            >
                <input id="install-url" autoFocus placeholder="https://github.com/you/scripts/blob/main/dark.tangitweak.ts" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="primary" type="submit">
                    Read
                </button>
            </form>
            <div id="install-drop" className="drop-zone">
                <svg viewBox="0 0 16 16" width="28" height="28" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM2.5 4.5L8 7.5l5.5-3M8 7.5v7" /></svg>
                <div>Drop a script, a folder, a <code>.zip</code> or a link here</div>
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
            </div>
            <p className="dim small">
                Scripts from a folder or zip update themselves only when their metadata has an <code>updateURL</code>.
            </p>
            {error && <p className="err">{error}</p>}
            {local && (
                <div>
                    <p>{local.label} has more than one script (and no {MANIFEST_FILE} listing them) — which one?</p>
                    <ul className="entries">
                        {local.entries.map((e) => {
                            const entryIcon = resolvePackageIcon({ entries: [e], files: local.files });
                            return (
                                <li key={e}>
                                    <button className="link entry-pick" onClick={() => props.onEntry(local.files, e)}>
                                        <PackageIcon src={entryIcon} className="pkg-icon-entry" />
                                        <span>{e}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </main>
    );
}

function PackageIcon({ src, className = "pkg-icon" }: { src?: string; className?: string }) {
    const [broken, setBroken] = useState(false);
    useEffect(() => setBroken(false), [src]);
    if (!src || broken) return null;
    return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

function Header(props: { name: string; metadata: Analysis["metadata"]; scripts: string[]; source: string; iconUrl?: string }) {
    const { metadata: header } = props;
    return (
        <header className="install-header">
            <PackageIcon src={props.iconUrl} />
            <div className="install-header-body">
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
                    {header.updateURL && header.updateURL !== props.source && <> · updates from {label(header.updateURL)}</>}
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
            </div>
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

function diffCounts(files: Record<string, string>, before: Record<string, string>) {
    let changed = 0;
    let added = 0;
    let same = 0;
    for (const rel of Object.keys(files)) {
        if (!(rel in before)) added++;
        else if (before[rel] === files[rel]) same++;
        else changed++;
    }
    const removed = Object.keys(before).filter((r) => !(r in files)).length;
    return { changed, added, removed, same, identical: changed === 0 && added === 0 && removed === 0 };
}

function Files(props: { files: Record<string, string>; analysis: Analysis; before?: Record<string, string> }) {
    const { files, analysis, before } = props;
    const statusOf = (rel: string): "" | "added" | "changed" | "same" => (!before ? "" : !(rel in before) ? "added" : before[rel] === files[rel] ? "same" : "changed");
    const rankOf = (s: "" | "added" | "changed" | "same") => (s === "changed" ? 0 : s === "added" ? 1 : 2);
    const rels = Object.keys(files).sort((a, b) => (before ? rankOf(statusOf(a)) - rankOf(statusOf(b)) : 0) || a.localeCompare(b));
    const gone = before ? Object.keys(before).filter((r) => !(r in files)).sort() : [];
    let autoOpened = 0;
    return (
        <section>
            <h2>Files</h2>
            {rels.map((rel) => {
                const status = statusOf(rel);
                const img = isImageDataPath(rel);
                const openByDefault = status === "changed" && !img && autoOpened++ < 5;
                return (
                    <details key={rel} className={`file ${status}`} open={openByDefault || undefined}>
                        <summary>
                            <code>{fileLabel(analysis.items[rel])}</code>
                            {status && <span className={`tag ${status}`}>{status === "same" ? "unchanged" : status}</span>}
                            <span className="dim small">{img ? "image" : `${files[rel].split("\n").length} lines`}</span>
                        </summary>
                        {img ? (
                            <div className="file-img">
                                <img src={files[rel]} alt={rel} />
                            </div>
                        ) : status === "changed" ? (
                            <Diff before={before![rel]} after={files[rel]} />
                        ) : (
                            <pre>{files[rel]}</pre>
                        )}
                    </details>
                );
            })}
            {gone.map((rel) => {
                const img = isImageDataPath(rel);
                return (
                    <details key={rel} className="file removed">
                        <summary>
                            <code>{analysis.folder ? `${analysis.folder}/${rel}` : rel}</code>
                            <span className="tag removed">removed</span>
                            <span className="dim small">{img ? "image" : `${before![rel].split("\n").length} lines`}</span>
                        </summary>
                        {img ? (
                            <div className="file-img">
                                <img src={before![rel]} alt={rel} />
                            </div>
                        ) : (
                            <pre className="diff">
                                {before![rel].split("\n").map((t, k) => (
                                    <div key={k} className="del">
                                        - {t}
                                    </div>
                                ))}
                            </pre>
                        )}
                    </details>
                );
            })}
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

function UpgradePrompt(props: { analysis: Analysis; fetched: Fetched }) {
    const existing = props.analysis.existing;
    if (!existing) return null;
    const oldVer = existing.version || (existing.revision ? existing.revision.slice(0, 8) : "unversioned");
    const newVer = props.analysis.metadata.version || (props.fetched.revision ? props.fetched.revision.slice(0, 8) : "unversioned");
    const bothVersioned = !!(existing.version && props.analysis.metadata.version);
    const cmp = bothVersioned ? compareVersions(props.analysis.metadata.version, existing.version) : undefined;
    const counts = diffCounts(props.fetched.files, existing.before);
    const summary = counts.identical
        ? `All ${counts.same} ${counts.same === 1 ? "file matches" : "files match"} the installed copy.`
        : [
              counts.changed ? `${counts.changed} changed` : "",
              counts.added ? `${counts.added} added` : "",
              counts.removed ? `${counts.removed} removed` : "",
              counts.same ? `${counts.same} unchanged` : "",
          ]
              .filter(Boolean)
              .join(" · ");
    return (
        <div className="note upgrade-prompt" role="region" aria-label="Existing script comparison">
            <div className="upgrade-title">
                <b>“{existing.name}” already exists.</b> Would you like to upgrade it in place (keeping your settings and parameter values)?
            </div>
            <div className="upgrade-meta">
                <span>
                    Version: <code>{oldVer}</code> → <code>{newVer}</code>
                </span>
                {cmp !== undefined && (
                    <span className={`tag ${cmp > 0 ? "added" : cmp < 0 ? "removed" : "same"}`}>{cmp > 0 ? "newer" : cmp < 0 ? "downgrade" : "same version"}</span>
                )}
                <span className="dim">·</span>
                <span>Files: {summary}</span>
            </div>
        </div>
    );
}

function Review(props: { state: Extract<State, { phase: "review" }>; setState: (s: State) => void; close: () => void }) {
    const { fetched, analysis } = props.state;
    const existing = analysis.existing;
    const updatable = !!(fetched.source || analysis.metadata.updateURL);
    const [autoUpdate, setAutoUpdate] = useState(existing?.autoUpdate ?? updatable);
    const [busy, setBusy] = useState(false);
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
            props.setState({ phase: "done", pkg, verb: "Installed", iconUrl: analysis.iconUrl });
        });
    const upgrade = () =>
        run(async () => {
            const pkg = await packagesApi.upgrade(fetched, autoUpdate, existing?.packageId);
            props.setState({ phase: "done", pkg, verb: "Upgraded", iconUrl: analysis.iconUrl });
        });
    return (
        <main>
            <Header name={analysis.name} metadata={analysis.metadata} scripts={fetched.entries} source={fetched.source} iconUrl={analysis.iconUrl} />
            <UpgradePrompt analysis={analysis} fetched={fetched} />
            <Capabilities analysis={analysis} added={analysis.added} />
            <Warnings analysis={analysis} fetched={fetched} modified={analysis.modified} />
            <Files files={fetched.files} analysis={analysis} before={existing?.before} />
            <footer>
                {updatable ? (
                    <label className="check">
                        <input id="install-auto-update" type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} /> Keep it up to date (updates that can do more wait for your review)
                    </label>
                ) : (
                    <span className="dim small">Installed from local files, it won't update itself.</span>
                )}
                <div className="actions">
                    {existing ? (
                        <>
                            <button id="install-confirm" className="primary" disabled={busy || !!analysis.error} onClick={upgrade}>
                                Upgrade
                            </button>
                            <button id="install-copy" disabled={busy || !!analysis.error} onClick={() => install(true)}>
                                Install as “{existing.copyName}”
                            </button>
                        </>
                    ) : (
                        <>
                            <button id="install-confirm" className="primary" disabled={busy || !!analysis.error} onClick={() => install(true)}>
                                Install
                            </button>
                            <button id="install-disabled" disabled={busy || !!analysis.error} onClick={() => install(false)}>
                                Install turned off
                            </button>
                        </>
                    )}
                    <button onClick={props.close}>Cancel</button>
                </div>
            </footer>
        </main>
    );
}

function PendingReview(props: { state: Extract<State, { phase: "pending" }>; setState: (s: State) => void; close: () => void }) {
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
            <Header name={analysis.name} metadata={pending.metadata} scripts={pending.entries} source={pkg.source} iconUrl={analysis.iconUrl} />
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
                                props.setState({ phase: "done", pkg: next, verb: "Updated", iconUrl: analysis.iconUrl });
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
                                const files = await installedTexts(pkg);
                                const iconUrl = resolvePackageIcon({ entries: pkg.entries, files, metadata: pkg.metadata });
                                props.setState({ phase: "nothing", pkg, iconUrl, note: "Skipped — the next newer version will be offered." });
                            })
                        }
                    >
                        Skip this version
                    </button>
                    <button onClick={props.close}>Cancel</button>
                </div>
            </footer>
        </main>
    );
}
