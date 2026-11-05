/**
 * Installed packages (see shared/packageModel): install, the update
 * check, applying and rolling back updates. Package files are ordinary
 * scripts and data files written through the script store.
 */
import { compileForStorage } from "../compileHost";
import { addedCapabilities, capabilitiesOf, type Capabilities } from "../../shared/packageCaps";
import { compareVersions, parseHeader, type PackageHeader } from "../../shared/packageHeader";
import {
    PACKAGES_KEY,
    isDataPath,
    modifiedFiles,
    packageFolder,
    packageName,
    storeItemOf,
    uniqueEntryName,
    type InstalledFile,
    type InstalledPackage,
    type PackageVersion,
    type PendingUpdate,
} from "../../shared/packageModel";
import { fetchPackage, hashText, isRemote, parseSource, webNet } from "../../shared/packageSource";
import { allFolders } from "../../shared/folders";
import { log } from "./logs";
import {
    createFolder,
    deleteDataFile,
    deleteScript,
    listDataFiles,
    listFolders,
    listScripts,
    loadAllParamValues,
    newId,
    onScriptsChanged,
    saveDataFile,
    saveScript,
} from "./scriptStore";

/** what an install / update page sends: the crawled files */
export interface FetchedPackage {
    /** where it updates from; "" = a folder or zip (no updates) */
    source: string;
    entry: string;
    files: Record<string, string>;
    revision: string;
}

export interface Analysis {
    name: string;
    header: PackageHeader;
    caps: Capabilities;
    /** the entry's compile error */
    error: string | null;
    /** where it would install ("" = the root) */
    folder: string;
    /** package file → the store item it becomes */
    items: Record<string, { kind: "script" | "data"; name: string }>;
    /** update: what it can do that the installed version can't */
    added?: string[];
    /** update: files changed here since they were installed */
    modified?: string[];
}

function storageGet(key: string): Promise<any> {
    return new Promise((resolve) => chrome.storage.local.get(key, (d) => (void chrome.runtime.lastError, resolve(d?.[key]))));
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((resolve) => chrome.storage.local.set(items, () => (void chrome.runtime.lastError, resolve())));
}

export async function listPackages(): Promise<Record<string, InstalledPackage>> {
    return (await storageGet(PACKAGES_KEY)) || {};
}

async function putPackage(pkg: InstalledPackage): Promise<void> {
    const all = await listPackages();
    all[pkg.id] = pkg;
    await storageSet({ [PACKAGES_KEY]: all });
}

/** one package operation at a time (they read, then write, the store) */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

/** the store names a package's files take, keeping the installed ones' names */
function layout(files: Record<string, string>, entry: string, folder: string, pkg?: InstalledPackage, takenRoot: string[] = []): Analysis["items"] {
    const items: Analysis["items"] = {};
    for (const rel of Object.keys(files)) {
        const kept = pkg?.files[rel];
        items[rel] = kept ? { kind: kept.kind, name: kept.name } : storeItemOf(folder, rel);
    }
    // a root single-file entry steps around a same-named script
    if (!pkg && !folder) items[entry] = { kind: "script", name: uniqueEntryName(items[entry].name, takenRoot) };
    // the entry keeps its id through a rename: it keeps its old name only if its path didn't change
    if (pkg && !pkg.files[entry]) items[entry] = storeItemOf(folder, entry);
    return items;
}

/** compile the entry as it would install, against the package's own files and the stored ones */
async function analyze(fetched: Pick<FetchedPackage, "entry" | "files">, pkg?: InstalledPackage): Promise<Analysis> {
    const { entry, files } = fetched;
    if (!files[entry]) throw new Error(`the package has no ${entry}`);
    if (isDataPath(entry)) throw new Error("the entry must be a .wiretrick.ts file");
    const [scripts, dataFiles, folders] = await Promise.all([listScripts(), listDataFiles(), listFolders()]);
    const taken = [...scripts.map((s) => s.meta.name), ...dataFiles.map((d) => d.path), ...allFolders(folders, [])];
    const folder = pkg ? pkg.folder : packageFolder(entry, files, taken);
    const items = layout(files, entry, folder, pkg, scripts.map((s) => s.meta.name));
    const header = parseHeader(files[entry]);
    const own = new Set(pkg ? Object.values(pkg.files).map((f) => f.id) : []);
    const idOf = (rel: string) => (rel === entry && pkg ? pkg.entryId : pkg?.files[rel]?.id ?? `pkg:${rel}`);
    const pkgScripts = Object.keys(files)
        .filter((rel) => items[rel].kind === "script" && rel !== entry)
        .map((rel) => ({ id: idOf(rel), name: items[rel].name, code: files[rel] }));
    const names = new Set(pkgScripts.map((s) => s.name.toLowerCase()));
    const others = scripts
        .filter((s) => !own.has(s.id) && !names.has(s.meta.name.toLowerCase()))
        .map((s) => ({ id: s.id, name: s.meta.name, code: s.code }));
    const data = Object.keys(files)
        .filter((rel) => items[rel].kind === "data")
        .map((rel) => ({ path: items[rel].name, text: files[rel] }));
    const values = await loadAllParamValues();
    const id = idOf(entry);
    const c = await compileForStorage(files[entry], items[entry].name, values[id], { id, scripts: [...pkgScripts, ...others], paramValues: values, data });
    const caps = capabilitiesOf(c.meta, header, Object.keys(files).filter((rel) => !isDataPath(rel)).map((rel) => files[rel]));
    return { name: packageName(entry, header), header, caps, error: c.error, folder, items };
}

/** the install / update page's preview */
export function analyzePackage(fetched: FetchedPackage, updateOf?: string): Promise<Analysis> {
    return serial(async () => {
        const pkg = updateOf ? (await listPackages())[updateOf] : undefined;
        if (updateOf && !pkg) throw new Error("that package isn't installed anymore");
        const a = await analyze(fetched, pkg);
        if (pkg) {
            a.added = addedCapabilities(pkg.caps, a.caps);
            a.modified = await modifiedNow(pkg);
        }
        return a;
    });
}

async function modifiedNow(pkg: InstalledPackage): Promise<string[]> {
    const [scripts, dataFiles] = await Promise.all([listScripts(), listDataFiles()]);
    const cur = new Map<string, { name: string; text: string }>();
    for (const s of scripts) cur.set(s.id, { name: s.meta.name, text: s.code });
    for (const d of dataFiles) cur.set(d.id, { name: d.path, text: d.text });
    const hashes = new Map<string, string>();
    for (const f of Object.values(pkg.files)) {
        const c = cur.get(f.id);
        if (c) hashes.set(f.id, await hashText(c.text));
    }
    return modifiedFiles(pkg, (f) => {
        const c = cur.get(f.id);
        return c && { name: c.name, hash: hashes.get(f.id)! };
    });
}

/**
 * Write a version's files: data files, then libraries, then the entry
 * (its importers compile against what's there), then drop the files it
 * no longer has. Files keep their store ids.
 */
async function writeFiles(version: Pick<PackageVersion, "entry" | "files">, items: Analysis["items"], folder: string, pkg: InstalledPackage | undefined, enabled: boolean): Promise<{ files: Record<string, InstalledFile>; entryId: string }> {
    const { entry, files } = version;
    if (folder) await createFolder(folder).catch(() => {}); // exists
    const out: Record<string, InstalledFile> = {};
    const rels = Object.keys(files).sort((a, b) => rank(a) - rank(b));
    function rank(rel: string) {
        return rel === entry ? 2 : items[rel].kind === "data" ? 0 : 1;
    }
    for (const rel of rels) {
        const { kind, name } = items[rel];
        const text = files[rel];
        const old = pkg?.files[rel];
        const prev = rel === entry && pkg ? { id: pkg.entryId } : old && old.kind === kind && old.id !== pkg?.entryId ? old : undefined;
        let id: string;
        if (kind === "data") id = (await saveDataFile({ id: prev?.id, path: name, text })).id;
        else id = (await saveScript({ id: prev?.id ?? newId(), name, code: text, ...(prev ? {} : { enabled }) })).id;
        out[rel] = { kind, id, name, hash: await hashText(text) };
    }
    if (pkg) {
        const kept = new Set(Object.values(out).map((f) => f.id));
        for (const f of Object.values(pkg.files)) {
            if (kept.has(f.id)) continue;
            if (f.kind === "data") await deleteDataFile(f.id);
            else await deleteScript(f.id);
        }
    }
    return { files: out, entryId: out[entry].id };
}

export function installPackage(fetched: FetchedPackage, opts: { enabled: boolean; autoUpdate: boolean }): Promise<InstalledPackage> {
    return serial(async () => {
        const a = await analyze(fetched);
        const { files, entryId } = await writeFiles(fetched, a.items, a.folder, undefined, opts.enabled);
        const now = Date.now();
        const pkg: InstalledPackage = {
            id: newId(),
            source: fetched.source,
            folder: a.folder,
            entry: fetched.entry,
            entryId,
            revision: fetched.revision,
            header: a.header,
            caps: a.caps,
            files,
            autoUpdate: opts.autoUpdate && !!fetched.source,
            installedAt: now,
            updatedAt: now,
        };
        await putPackage(pkg);
        // not ending in the URL: the Network view would take it for the package's request
        log(-1, `[packages] installed "${a.name}"${a.header.version ? ` ${a.header.version}` : ""}${fetched.source ? ` from ${fetched.source} (auto-update ${pkg.autoUpdate ? "on" : "off"})` : ""}`, "info", entryId);
        return pkg;
    });
}

async function snapshot(pkg: InstalledPackage): Promise<PackageVersion> {
    const [scripts, dataFiles] = await Promise.all([listScripts(), listDataFiles()]);
    const text = new Map<string, string>();
    for (const s of scripts) text.set(s.id, s.code);
    for (const d of dataFiles) text.set(d.id, d.text);
    const files: Record<string, string> = {};
    for (const [rel, f] of Object.entries(pkg.files)) {
        const t = text.get(f.id);
        if (t !== undefined) files[rel] = t;
    }
    return { revision: pkg.revision, entry: pkg.entry, files, header: pkg.header, caps: pkg.caps };
}

/** replace the installed files with `next`; the current ones become `previous` (unless rolling back) */
async function apply(pkg: InstalledPackage, next: PackageVersion, rollback = false): Promise<InstalledPackage> {
    const a = await analyze(next, pkg);
    const previous = rollback ? undefined : await snapshot(pkg);
    const { files, entryId } = await writeFiles(next, a.items, pkg.folder, pkg, true);
    const out: InstalledPackage = {
        ...pkg,
        entry: next.entry,
        entryId,
        revision: next.revision,
        header: a.header,
        caps: a.caps,
        files,
        updatedAt: Date.now(),
        pending: undefined,
        skipped: undefined,
        lastError: undefined,
        previous,
        ...(rollback ? { autoUpdate: false } : {}),
    };
    await putPackage(out);
    const v = a.header.version ? ` ${a.header.version}` : "";
    log(-1, rollback ? `[packages] rolled "${a.name}" back to${v || " the previous version"} (auto-update is off now)` : `[packages] updated "${a.name}" to${v || ` revision ${next.revision.slice(0, 8)}`}`, "info", entryId);
    return out;
}

/**
 * A newer revision came in: apply it, or hold it for review when it can
 * do more, when files were changed here, when it goes down a version or
 * when auto-update is off. One that doesn't compile is refused. `manual`:
 * the user asked (no log entry for a held update).
 */
async function offer(pkg: InstalledPackage, fetched: FetchedPackage, manual: boolean): Promise<InstalledPackage> {
    const checked = { ...pkg, lastChecked: Date.now(), lastError: undefined };
    if (fetched.revision === pkg.revision || (!manual && fetched.revision === pkg.skipped)) {
        await putPackage({ ...checked, pending: undefined });
        return checked;
    }
    if (pkg.pending?.revision === fetched.revision) {
        await putPackage(checked);
        return checked;
    }
    const a = await analyze(fetched, pkg);
    if (a.error) {
        const failed = { ...checked, lastError: `the update (${a.header.version || fetched.revision.slice(0, 8)}) doesn't compile: ${a.error.split("\n")[0]}` };
        await putPackage(failed);
        return failed;
    }
    const added = addedCapabilities(pkg.caps, a.caps);
    const modified = await modifiedNow(pkg);
    const reasons: string[] = [];
    if (added.length) reasons.push(`it can do more: ${added.join("; ")}`);
    if (modified.length) reasons.push(`changed here since installed: ${modified.join(", ")}`);
    if (compareVersions(a.header.version, pkg.header.version) < 0) reasons.push(`the version goes down (${pkg.header.version} → ${a.header.version})`);
    const next: PackageVersion = { revision: fetched.revision, entry: fetched.entry, files: fetched.files, header: a.header, caps: a.caps };
    if (reasons.length || !pkg.autoUpdate) {
        const pending: PendingUpdate = { ...next, reasons, added, at: Date.now() };
        const held = { ...checked, pending };
        await putPackage(held);
        if (!manual) log(-1, `[packages] an update to "${a.name}" waits for review — ${reasons.join("; ")} (right-click it in the Explorer → Review Update…)`, "warn", pkg.entryId);
        return held;
    }
    return apply(checked, next);
}

/** fetch a package's source: https here; file: URLs only from an extension page (the Editor offers them) */
async function fetchSource(pkg: InstalledPackage): Promise<FetchedPackage | null> {
    if (!pkg.source) return null; // installed from a folder or zip
    const src = parseSource(pkg.source);
    if (typeof src === "string") throw new Error(src);
    if (!isRemote(src)) return null;
    const p = await fetchPackage(src, webNet);
    return { source: pkg.source, entry: p.entry, files: p.files, revision: p.revision };
}

/** check one (`id`, the Explorer's "Check for updates") or every auto-updating package */
export function checkPackages(id?: string): Promise<Record<string, InstalledPackage>> {
    return serial(async () => {
        const all = await listPackages();
        const ids = id ? [id] : Object.keys(all).filter((k) => all[k].autoUpdate);
        for (const k of ids) {
            const pkg = all[k];
            if (!pkg) continue;
            try {
                const fetched = await fetchSource(pkg);
                if (fetched) all[k] = await offer(pkg, fetched, !!id);
            } catch (e: any) {
                all[k] = { ...pkg, lastChecked: Date.now(), lastError: String(e?.message || e) };
                await putPackage(all[k]);
            }
        }
        return listPackages();
    });
}

/** the Editor read a local (file:) package's files */
export function offerPackage(id: string, fetched: FetchedPackage, manual: boolean): Promise<InstalledPackage | null> {
    return serial(async () => {
        const pkg = (await listPackages())[id];
        return pkg ? offer(pkg, fetched, manual) : null;
    });
}

export function applyPending(id: string): Promise<InstalledPackage> {
    return serial(async () => {
        const pkg = (await listPackages())[id];
        if (!pkg?.pending) throw new Error("no update waits for that package");
        return apply(pkg, pkg.pending);
    });
}

export function dismissPending(id: string): Promise<void> {
    return serial(async () => {
        const pkg = (await listPackages())[id];
        if (pkg?.pending) await putPackage({ ...pkg, pending: undefined, skipped: pkg.pending.revision });
    });
}

export function rollbackPackage(id: string): Promise<InstalledPackage> {
    return serial(async () => {
        const pkg = (await listPackages())[id];
        if (!pkg?.previous) throw new Error("there's no previous version to roll back to");
        return apply(pkg, pkg.previous, true);
    });
}

export function setAutoUpdate(id: string, on: boolean): Promise<void> {
    return serial(async () => {
        const pkg = (await listPackages())[id];
        if (pkg) await putPackage({ ...pkg, autoUpdate: on });
    });
}

/** stop tracking a package; its files stay */
export function forgetPackage(id: string): Promise<void> {
    return serial(async () => {
        const all = await listPackages();
        delete all[id];
        await storageSet({ [PACKAGES_KEY]: all });
    });
}

/** a package whose entry script was deleted is gone */
async function prune(): Promise<void> {
    const all = await listPackages();
    if (!Object.keys(all).length) return;
    const ids = new Set((await listScripts()).map((s) => s.id));
    const gone = Object.keys(all).filter((k) => !ids.has(all[k].entryId));
    if (!gone.length) return;
    for (const k of gone) delete all[k];
    await storageSet({ [PACKAGES_KEY]: all });
}

export const UPDATE_ALARM = "wtPackageUpdates";
const DAY = 24 * 60 * 60 * 1000;

/** daily update checks (and one at startup when they're overdue) */
export function startPackageUpdates(): void {
    onScriptsChanged(() => void serial(prune));
    const alarms = (chrome as any).alarms;
    if (alarms) {
        // the service worker restarts often: creating it again would push it back each time
        alarms.get(UPDATE_ALARM, (a: unknown) => {
            void chrome.runtime.lastError;
            if (!a) alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 24 * 60 });
        });
        alarms.onAlarm.addListener((a: { name: string }) => {
            if (a.name === UPDATE_ALARM) void checkPackages();
        });
    }
    setTimeout(async () => {
        const all = Object.values(await listPackages());
        if (all.some((p) => p.autoUpdate && Date.now() - (p.lastChecked ?? p.updatedAt) > DAY)) void checkPackages();
    }, 30_000);
}
