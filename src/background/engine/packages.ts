/**
 * Installed packages (see shared/packageModel): install, the update
 * check, applying and rolling back updates. Package files are ordinary
 * scripts and data files written through the script store.
 */
import { compileForStorage } from "../compileHost";
import { addedCapabilities, capabilitiesOf, type Capabilities } from "../../shared/packageCaps";
import { compareVersions, highestVersion, MANIFEST_FILE, minTangiTweakProblem, parseManifest, type PackageMetadata } from "../../shared/packageMetadata";
import {
    PACKAGES_KEY,
    entryIds,
    entryStem,
    isDataPath,
    modifiedFiles,
    naturalPackageFolder,
    packageFolder,
    packageName,
    resolvePackageIcon,
    storeItemOf,
    uniqueEntryName,
    type InstalledFile,
    type InstalledPackage,
    type PackageVersion,
    type PendingUpdate,
    updateSource,
} from "../../shared/packageModel";
import { SCRIPT_FILE_RE, crawl, fetchPackage, filesHash, hashText, isRemote, parseSource, stripInstallHash, webNet } from "../../shared/packageSource";
import { allFolders, isInFolder } from "../../shared/folders";
import { scriptFileKey, scriptFileName } from "../../shared/scriptName";
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
    saveScriptsBatch,
    type Script,
} from "./scriptStore";
import type { DataFile } from "./dataFiles";

/** what an install / update page sends: the crawled files */
export interface FetchedPackage {
    /** where it was installed from; "" = a folder or zip (it updates only from metadata.updateURL) */
    source: string;
    entries: string[];
    files: Record<string, string>;
    revision: string;
}

/** an already-existing script or bundle with the same name/source that installing can upgrade */
export interface ExistingPackageInfo {
    /** InstalledPackage id when already tracked as a package; undefined for unmanaged Explorer files */
    packageId?: string;
    name: string;
    version?: string;
    revision?: string;
    autoUpdate?: boolean;
    /** current file contents keyed by relative package path, for diffing */
    before: Record<string, string>;
    /** folder or script name that "Install as copy" creates if the user chooses not to upgrade */
    copyName: string;
}

export interface Analysis {
    name: string;
    metadata: PackageMetadata;
    /** resolved `<img src>` URL when the script or bundle declares an icon */
    iconUrl?: string;
    /** a bundle (a metadata.json lists its scripts) */
    bundle: boolean;
    caps: Capabilities;
    /** an entry's compile error */
    error: string | null;
    /** warning when `minTangiTweakVersion` is newer than the running TangiTweak */
    versionWarning?: string | null;
    /** where it would install ("" = the root) */
    folder: string;
    /** package file → the store item it becomes */
    items: Record<string, { kind: "script" | "data"; name: string }>;
    /** present when a script or bundle with the same source or name already exists */
    existing?: ExistingPackageInfo;
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
    const all: Record<string, InstalledPackage> = (await storageGet(PACKAGES_KEY)) || {};
    // records from before bundles (an unreleased shape) are dropped
    for (const k of Object.keys(all)) if (!Array.isArray(all[k]?.entries)) delete all[k];
    return all;
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

/**
 * The installed file a version's file replaces (it keeps that one's store
 * id: its params, stores and enabled state): the one at the same path, or
 * — a single-entry package whose entry was renamed — the old entry.
 */
function priorOf(pkg: InstalledPackage | undefined, version: Pick<PackageVersion, "entries" | "files">, rel: string): InstalledFile | undefined {
    if (!pkg) return undefined;
    const old = pkg.files[rel];
    if (old) return old;
    const [was] = pkg.entries;
    if (pkg.entries.length === 1 && version.entries.length === 1 && rel === version.entries[0] && !(was in version.files)) return pkg.files[was];
    return undefined;
}

/** the store names a package's files take, keeping the installed ones' names */
function layout(version: Pick<PackageVersion, "entries" | "files">, folder: string, pkg?: InstalledPackage, takenRoot: string[] = []): Analysis["items"] {
    const items: Analysis["items"] = {};
    for (const rel of Object.keys(version.files)) {
        const kept = pkg?.files[rel];
        // a renamed entry takes its new name
        items[rel] = kept ? { kind: kept.kind, name: kept.name } : storeItemOf(folder, rel);
    }
    // a root single-file entry steps around a same-named script
    const [only] = version.entries;
    if (!pkg && !folder) items[only] = { kind: "script", name: uniqueEntryName(items[only].name, takenRoot) };
    return items;
}

/** compile the entries as they would install, against the package's own files and the stored ones */
async function analyze(version: Pick<FetchedPackage, "entries" | "files">, pkg?: InstalledPackage): Promise<Analysis> {
    const { entries, files } = version;
    if (!entries.length) throw new Error("the package has no script to run");
    for (const e of entries) {
        if (files[e] === undefined) throw new Error(`the package has no ${e}`);
        if (!SCRIPT_FILE_RE.test(e)) throw new Error(`${e}: a package's scripts are .ts or .tsx files`);
    }
    const manifest = files[MANIFEST_FILE] !== undefined ? parseManifest(files[MANIFEST_FILE]) : undefined;
    const [scripts, dataFiles, folders] = await Promise.all([listScripts(), listDataFiles(), listFolders()]);
    const taken = [...scripts.map((s) => s.meta.name), ...dataFiles.map((d) => d.path), ...allFolders(folders, [])];
    const folder = pkg ? pkg.folder : packageFolder({ entries, files, bundleName: manifest?.name }, taken);
    const items = layout(version, folder, pkg, scripts.map((s) => s.meta.name));
    const own = new Set(pkg ? Object.values(pkg.files).map((f) => f.id) : []);
    const idOf = (rel: string) => priorOf(pkg, version, rel)?.id ?? `pkg:${rel}`;
    const pkgScripts = Object.keys(files)
        .filter((rel) => items[rel].kind === "script")
        .map((rel) => ({ rel, id: idOf(rel), name: items[rel].name, code: files[rel] }));
    const names = new Set(pkgScripts.map((s) => s.name.toLowerCase()));
    const others = scripts
        .filter((s) => !own.has(s.id) && !names.has(s.meta.name.toLowerCase()))
        .map((s) => ({ id: s.id, name: s.meta.name, code: s.code }));
    const data = Object.keys(files)
        .filter((rel) => items[rel].kind === "data")
        .map((rel) => ({ path: items[rel].name, text: files[rel] }));
    const values = await loadAllParamValues();
    const compiled = [];
    for (const e of entries) {
        const id = idOf(e);
        const libs = pkgScripts.filter((s) => s.rel !== e).map(({ id, name, code }) => ({ id, name, code }));
        compiled.push({ e, c: await compileForStorage(files[e], items[e].name, values[id], { id, scripts: [...libs, ...others], paramValues: values, data }) });
    }
    const declared = compiled.map(({ c }) => c.meta.metadata);
    let metadata: PackageMetadata;
    if (manifest) {
        const { scripts: _, ...m } = manifest;
        const minVer = highestVersion([m.minTangiTweakVersion, ...declared.map((d) => d?.minTangiTweakVersion)]);
        metadata = {
            ...m,
            ...(minVer ? { minTangiTweakVersion: minVer } : {}),
            connect: [...new Set([...m.connect, ...declared.flatMap((d) => d?.connect ?? [])])],
        };
    } else metadata = declared[0] ?? { connect: [] };
    const failed = compiled.find(({ c }) => c.error);
    const error = failed ? (entries.length > 1 ? `${failed.e}: ${failed.c.error}` : failed.c.error) : null;
    const versionWarning = minTangiTweakProblem(metadata.minTangiTweakVersion);
    const caps = capabilitiesOf(
        compiled.flatMap(({ c }) => c.meta.routes ?? []),
        metadata.connect,
        Object.keys(files).filter((rel) => !isDataPath(rel)).map((rel) => files[rel])
    );
    const iconUrl = resolvePackageIcon(
        { entries, files, metadata },
        declared.map((d) => d?.icon),
        dataFiles
    );
    return { name: packageName({ entries, metadata }), metadata, ...(iconUrl ? { iconUrl } : {}), bundle: !!manifest, caps, error, ...(versionWarning ? { versionWarning } : {}), folder, items };
}

const normSource = (u: string): string => stripInstallHash(u).replace(/\/+$/, "");

interface MatchedTarget {
    pkg: InstalledPackage;
    managed: boolean;
    copyName: string;
}

async function synthesizeFolderTarget(
    dir: string,
    scripts: Script[],
    dataFiles: DataFile[],
    incomingFiles: Record<string, string>
): Promise<InstalledPackage> {
    const dirScripts = scripts.filter((s) => isInFolder(s.meta.name, dir));
    const dirData = dataFiles.filter((d) => isInFolder(d.path, dir));
    const allTexts: Record<string, string> = {};
    const byLower = new Map<string, string>();
    for (const s of dirScripts) {
        const rel = scriptFileName(s.meta.name.slice(dir.length + 1));
        allTexts[rel] = s.code;
        byLower.set(rel.toLowerCase(), rel);
    }
    for (const d of dirData) {
        const rel = d.path.slice(dir.length + 1);
        allTexts[rel] = d.text;
        byLower.set(rel.toLowerCase(), rel);
    }

    let metadata: PackageMetadata = { connect: [] };
    let entries: string[] = [];
    let hasValidManifest = false;
    const mf = dirData.find((d) => d.path.slice(dir.length + 1).toLowerCase() === MANIFEST_FILE);
    if (mf) {
        try {
            const parsed = parseManifest(mf.text);
            const { scripts: sList, ...rest } = parsed;
            entries = sList;
            metadata = rest;
            hasValidManifest = true;
        } catch {
            // malformed local metadata.json: fall back to discovered entries
        }
    }
    if (!entries.length) {
        const active = dirScripts.filter((s) => s.meta.active !== false);
        entries = (active.length ? active : dirScripts).map((s) => scriptFileName(s.meta.name.slice(dir.length + 1)));
        if (dirScripts.length === 1 && dirScripts[0].meta.metadata) metadata = dirScripts[0].meta.metadata;
    }

    // Crawl the local package so unimported companion files (README.md, unused
    // helpers) aren't falsely shown as removed or deleted on Upgrade.
    const incomingByLower = new Map(Object.keys(incomingFiles).map((r) => [r.toLowerCase(), r]));
    const includedLower = new Set<string>(incomingByLower.keys());
    if (mf) includedLower.add(MANIFEST_FILE);
    const readLocal = (useManifest: boolean) => async (p: string) => {
        if (!useManifest && p.toLowerCase() === MANIFEST_FILE) return entries.length ? JSON.stringify({ scripts: entries }) : null;
        const k = byLower.get(p.toLowerCase());
        return k !== undefined ? allTexts[k] : null;
    };
    let crawled = false;
    for (const useManifest of hasValidManifest ? [true, false] : [false]) {
        if (!useManifest && !entries.length) break;
        try {
            const c = await crawl(MANIFEST_FILE, readLocal(useManifest));
            for (const p of Object.keys(c.files)) {
                if (!useManifest && p.toLowerCase() === MANIFEST_FILE) continue;
                includedLower.add(p.toLowerCase());
            }
            crawled = true;
            break;
        } catch {
            // e.g. local manifest lists a missing script; retry from discovered entries
        }
    }
    if (!crawled) for (const k of byLower.keys()) includedLower.add(k);

    const pkgScripts = dirScripts.filter((s) => includedLower.has(scriptFileName(s.meta.name.slice(dir.length + 1)).toLowerCase()));
    const pkgData = dirData.filter((d) => includedLower.has(d.path.slice(dir.length + 1).toLowerCase()));
    if (hasValidManifest) {
        metadata = { ...metadata, connect: [...new Set([...metadata.connect, ...pkgScripts.flatMap((s) => s.meta.metadata?.connect ?? [])])] };
    }

    const files: Record<string, InstalledFile> = {};
    const rawTexts: Record<string, string> = {};
    for (const s of pkgScripts) {
        const localRel = scriptFileName(s.meta.name.slice(dir.length + 1));
        const rel = incomingByLower.get(localRel.toLowerCase()) ?? localRel;
        files[rel] = { kind: "script", id: s.id, name: s.meta.name, hash: await hashText(s.code) };
        rawTexts[rel] = s.code;
    }
    for (const d of pkgData) {
        const localRel = d.path.slice(dir.length + 1);
        const rel = incomingByLower.get(localRel.toLowerCase()) ?? localRel;
        files[rel] = { kind: "data", id: d.id, name: d.path, hash: await hashText(d.text) };
        rawTexts[rel] = d.text;
    }

    const caps = capabilitiesOf(
        pkgScripts.flatMap((s) => s.meta.routes ?? []),
        metadata.connect,
        pkgScripts.map((s) => s.code)
    );
    const now = Date.now();
    return {
        id: newId(),
        source: "",
        folder: dir,
        entries,
        revision: await filesHash(rawTexts),
        metadata: { ...metadata, name: metadata.name || dir },
        caps,
        files,
        autoUpdate: false,
        installedAt: now,
        updatedAt: now,
    };
}

async function synthesizeScriptTarget(s: Script, entryRel: string): Promise<InstalledPackage> {
    const metadata: PackageMetadata = s.meta.metadata ?? { connect: [] };
    const caps = capabilitiesOf(s.meta.routes ?? [], metadata.connect, [s.code]);
    const now = Date.now();
    return {
        id: newId(),
        source: "",
        folder: "",
        entries: [entryRel],
        revision: await hashText(s.code),
        metadata,
        caps,
        files: { [entryRel]: { kind: "script", id: s.id, name: s.meta.name, hash: await hashText(s.code) } },
        autoUpdate: false,
        installedAt: now,
        updatedAt: now,
    };
}

async function findExistingTarget(
    fetched: FetchedPackage,
    incomingNameHint?: string
): Promise<MatchedTarget | undefined> {
    const [allPkgs, scripts, dataFiles, folders] = await Promise.all([listPackages(), listScripts(), listDataFiles(), listFolders()]);
    const liveIds = new Set([...scripts.map((s) => s.id), ...dataFiles.map((d) => d.id)]);
    const livePkgs = Object.values(allPkgs).filter((p) => Object.values(p.files).some((f) => liveIds.has(f.id)));
    const manifest = fetched.files[MANIFEST_FILE] !== undefined ? parseManifest(fetched.files[MANIFEST_FILE]) : undefined;
    const wantFolder = naturalPackageFolder({ entries: fetched.entries, files: fetched.files, bundleName: manifest?.name });
    const onlyEntry = fetched.entries[0] ?? "";
    const wantEntry = wantFolder ? "" : storeItemOf("", onlyEntry).name;
    const taken = [...scripts.map((s) => s.meta.name), ...dataFiles.map((d) => d.path), ...allFolders(folders, [])];
    const copyName = wantFolder
        ? packageFolder({ entries: fetched.entries, files: fetched.files, bundleName: manifest?.name }, taken)
        : uniqueEntryName(wantEntry, scripts.map((s) => s.meta.name));

    const srcKey = fetched.source ? normSource(fetched.source) : "";
    if (srcKey) {
        const bySrc =
            livePkgs.find((p) => p.source && normSource(p.source) === srcKey) ??
            livePkgs.find((p) => updateSource(p) && normSource(updateSource(p)) === srcKey);
        if (bySrc) return { pkg: bySrc, managed: true, copyName };
    }

    const wantedName = (incomingNameHint || manifest?.name || "").trim().toLowerCase();
    const byPkg = livePkgs.find((p) => {
        if (wantedName && packageName(p).toLowerCase() === wantedName) return true;
        if (wantFolder && p.folder && scriptFileKey(p.folder) === scriptFileKey(wantFolder)) return true;
        if (!wantFolder && !p.folder && p.entries[0] && p.files[p.entries[0]]) {
            const existingName = p.files[p.entries[0]].name;
            if (scriptFileKey(existingName) === scriptFileKey(wantEntry)) return true;
            if (scriptFileKey(entryStem(existingName)) === scriptFileKey(entryStem(onlyEntry))) return true;
        }
        return false;
    });
    if (byPkg) return { pkg: byPkg, managed: true, copyName };

    // Unmanaged Explorer folder/bundle or root script with the same name
    if (wantFolder) {
        const topDirs = allFolders(folders, [...scripts.map((s) => s.meta.name), ...dataFiles.map((d) => d.path)]).filter((f) => !f.includes("/"));
        const dir = topDirs.find((d) => {
            if (scriptFileKey(d) === scriptFileKey(wantFolder)) return true;
            if (!wantedName) return false;
            const mf = dataFiles.find((df) => df.path.toLowerCase() === `${d.toLowerCase()}/${MANIFEST_FILE}`);
            if (!mf) return false;
            try {
                return parseManifest(mf.text).name?.toLowerCase() === wantedName;
            } catch {
                return false;
            }
        });
        if (dir) {
            const hasFiles = scripts.some((s) => isInFolder(s.meta.name, dir)) || dataFiles.some((d) => isInFolder(d.path, dir));
            if (hasFiles) return { pkg: await synthesizeFolderTarget(dir, scripts, dataFiles, fetched.files), managed: false, copyName };
        }
    } else if (onlyEntry) {
        const rootScripts = scripts.filter((s) => !s.meta.name.includes("/"));
        const hit =
            rootScripts.find((s) => scriptFileKey(s.meta.name) === scriptFileKey(wantEntry)) ??
            rootScripts.find((s) => scriptFileKey(entryStem(s.meta.name)) === scriptFileKey(entryStem(onlyEntry))) ??
            (wantedName ? rootScripts.find((s) => s.meta.metadata?.name?.toLowerCase() === wantedName) : undefined);
        if (hit) return { pkg: await synthesizeScriptTarget(hit, onlyEntry), managed: false, copyName };
    }
    return undefined;
}

/** the install / update page's preview */
export function analyzePackage(fetched: FetchedPackage, updateOf?: string): Promise<Analysis> {
    return serial(async () => {
        if (updateOf) {
            const pkg = (await listPackages())[updateOf];
            if (!pkg) throw new Error("that package isn't installed anymore");
            const a = await analyze(fetched, pkg);
            a.added = addedCapabilities(pkg.caps, a.caps);
            a.modified = await modifiedNow(pkg);
            return a;
        }
        let match = await findExistingTarget(fetched);
        let a = await analyze(fetched, match?.pkg);
        if (!match && a.name) {
            match = await findExistingTarget(fetched, a.name);
            if (match) a = await analyze(fetched, match.pkg);
        }
        if (match) {
            const snap = await snapshot(match.pkg);
            a.added = addedCapabilities(match.pkg.caps, a.caps);
            a.modified = match.managed ? await modifiedNow(match.pkg) : [];
            a.existing = {
                ...(match.managed ? { packageId: match.pkg.id, autoUpdate: match.pkg.autoUpdate } : {}),
                name: packageName(match.pkg),
                version: match.pkg.metadata.version,
                revision: match.pkg.revision,
                before: snap.files,
                copyName: match.copyName,
            };
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
 * Write a version's files: data files, then libraries, then the entries
 * (they compile against what's there), then drop the files it no longer
 * has. Files keep their store ids; a new entry of an installed bundle
 * starts turned on.
 */
async function writeFiles(version: Pick<PackageVersion, "entries" | "files">, items: Analysis["items"], folder: string, pkg: InstalledPackage | undefined, enabled: boolean): Promise<Record<string, InstalledFile>> {
    const { entries, files } = version;
    if (folder) await createFolder(folder).catch(() => {}); // exists
    const [curScripts, curData] = await Promise.all([listScripts(), listDataFiles()]);
    const scriptByKey = new Map(curScripts.map((s) => [scriptFileKey(s.meta.name), s.id]));
    const dataByPath = new Map(curData.map((d) => [d.path.toLowerCase(), d.id]));
    const out: Record<string, InstalledFile> = {};
    const rels = Object.keys(files).sort((a, b) => rank(a) - rank(b));
    function rank(rel: string) {
        return entries.includes(rel) ? 2 : items[rel].kind === "data" ? 0 : 1;
    }
    const scriptBatch: { rel: string; id: string; name: string; code: string; enabled?: boolean }[] = [];
    for (const rel of rels) {
        const { kind, name } = items[rel];
        const text = files[rel];
        const old = priorOf(pkg, version, rel);
        const prev = old && old.kind === kind ? old : undefined;
        if (kind === "data") {
            const id = (await saveDataFile({ id: prev?.id ?? dataByPath.get(name.toLowerCase()), path: name, text })).id;
            out[rel] = { kind, id, name, hash: await hashText(text) };
        } else {
            scriptBatch.push({ rel, id: prev?.id ?? scriptByKey.get(scriptFileKey(name)) ?? newId(), name, code: text, ...(prev ? {} : { enabled }) });
        }
    }
    if (scriptBatch.length) {
        await saveScriptsBatch(scriptBatch.map(({ id, name, code, enabled }) => ({ id, name, code, ...(enabled !== undefined ? { enabled } : {}) })));
        for (const s of scriptBatch) {
            out[s.rel] = { kind: "script", id: s.id, name: s.name, hash: await hashText(s.code) };
        }
    }
    if (pkg) {
        const kept = new Set(Object.values(out).map((f) => f.id));
        for (const f of Object.values(pkg.files)) {
            if (kept.has(f.id)) continue;
            if (f.kind === "data") await deleteDataFile(f.id);
            else await deleteScript(f.id);
        }
    }
    return out;
}

export function installPackage(fetched: FetchedPackage, opts: { enabled: boolean; autoUpdate: boolean }): Promise<InstalledPackage> {
    return serial(async () => {
        const a = await analyze(fetched);
        const files = await writeFiles(fetched, a.items, a.folder, undefined, opts.enabled);
        const now = Date.now();
        const pkg: InstalledPackage = {
            id: newId(),
            source: fetched.source,
            folder: a.folder,
            entries: fetched.entries,
            revision: fetched.revision,
            metadata: a.metadata,
            caps: a.caps,
            files,
            autoUpdate: opts.autoUpdate && !!(fetched.source || a.metadata.updateURL),
            installedAt: now,
            updatedAt: now,
        };
        await putPackage(pkg);
        // not ending in the URL: the Network view would take it for the package's request
        const from = updateSource(pkg);
        log(-1, `[packages] installed "${a.name}"${a.metadata.version ? ` ${a.metadata.version}` : ""}${fetched.source ? ` from ${fetched.source}` : ""}${from ? `${from !== fetched.source ? `, updating from ${from}` : ""} (auto-update ${pkg.autoUpdate ? "on" : "off"})` : ""}`, "info", entryIds(pkg)[0]);
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
    return { revision: pkg.revision, entries: pkg.entries, files, metadata: pkg.metadata, caps: pkg.caps };
}

/**
 * Upgrade an existing same-named package or unmanaged Explorer folder/script
 * in place: keeps store ids (params, stores, enabled state) and saves a
 * rollback snapshot in `previous`.
 */
export function upgradePackage(fetched: FetchedPackage, opts: { packageId?: string; autoUpdate: boolean }): Promise<InstalledPackage> {
    return serial(async () => {
        let target: InstalledPackage | undefined;
        if (opts.packageId) target = (await listPackages())[opts.packageId];
        if (!target) {
            const a0 = await analyze(fetched);
            const match = (await findExistingTarget(fetched, a0.name)) ?? (await findExistingTarget(fetched));
            target = match?.pkg;
        }
        if (!target) throw new Error("that script or package isn't installed anymore");
        const a = await analyze(fetched, target);
        if (a.error) throw new Error(`doesn't compile: ${a.error.split("\n")[0]}`);
        const previous = await snapshot(target);
        const files = await writeFiles(fetched, a.items, target.folder, target, true);
        const source = fetched.source || target.source;
        const autoUpdate = opts.autoUpdate && !!(source || a.metadata.updateURL);
        const out: InstalledPackage = {
            ...target,
            source,
            entries: fetched.entries,
            revision: fetched.revision,
            metadata: a.metadata,
            caps: a.caps,
            files,
            autoUpdate,
            updatedAt: Date.now(),
            pending: undefined,
            skipped: undefined,
            lastError: undefined,
            previous,
        };
        await putPackage(out);
        const v = a.metadata.version ? ` ${a.metadata.version}` : "";
        log(-1, `[packages] upgraded "${a.name}" to${v || ` revision ${fetched.revision.slice(0, 8)}`}`, "info", entryIds(out)[0]);
        return out;
    });
}
/** replace the installed files with `next`; the current ones become `previous` (unless rolling back) */
async function apply(pkg: InstalledPackage, next: PackageVersion, rollback = false): Promise<InstalledPackage> {
    const a = await analyze(next, pkg);
    const previous = rollback ? undefined : await snapshot(pkg);
    const files = await writeFiles(next, a.items, pkg.folder, pkg, true);
    const out: InstalledPackage = {
        ...pkg,
        entries: next.entries,
        revision: next.revision,
        metadata: a.metadata,
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
    const v = a.metadata.version ? ` ${a.metadata.version}` : "";
    log(-1, rollback ? `[packages] rolled "${a.name}" back to${v || " the previous version"} (auto-update is off now)` : `[packages] updated "${a.name}" to${v || ` revision ${next.revision.slice(0, 8)}`}`, "info", entryIds(out)[0]);
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
    // the same files under another revision (a commit elsewhere in the repository, the first check of a new updateURL)
    if (await sameFiles(pkg, fetched)) {
        const same = { ...checked, revision: fetched.revision, pending: undefined };
        await putPackage(same);
        return same;
    }
    const a = await analyze(fetched, pkg);
    if (a.error) {
        const failed = { ...checked, lastError: `the update (${a.metadata.version || fetched.revision.slice(0, 8)}) doesn't compile: ${a.error.split("\n")[0]}` };
        await putPackage(failed);
        return failed;
    }
    const added = addedCapabilities(pkg.caps, a.caps);
    const modified = await modifiedNow(pkg);
    const reasons: string[] = [];
    if (a.versionWarning) reasons.push(a.versionWarning.replace(/\.$/, ""));
    if (added.length) reasons.push(`it can do more: ${added.join("; ")}`);
    if (modified.length) reasons.push(`changed here since installed: ${modified.join(", ")}`);
    if (compareVersions(a.metadata.version, pkg.metadata.version) < 0) reasons.push(`the version goes down (${pkg.metadata.version} → ${a.metadata.version})`);
    const from = updateSource({ source: pkg.source, metadata: a.metadata });
    if (from !== updateSource(pkg)) reasons.push(from ? `it updates from somewhere else: ${from}` : "it stops updating");
    const next: PackageVersion = { revision: fetched.revision, entries: fetched.entries, files: fetched.files, metadata: a.metadata, caps: a.caps };
    if (reasons.length || !pkg.autoUpdate) {
        const pending: PendingUpdate = { ...next, reasons, added, at: Date.now() };
        const held = { ...checked, pending };
        await putPackage(held);
        if (!manual) log(-1, `[packages] an update to "${a.name}" waits for review — ${reasons.join("; ")} (right-click it in the Explorer → Review Update…)`, "warn", entryIds(pkg)[0]);
        return held;
    }
    return apply(checked, next);
}

async function sameFiles(pkg: InstalledPackage, fetched: Pick<FetchedPackage, "entries" | "files">): Promise<boolean> {
    const rels = Object.keys(fetched.files);
    if (rels.length !== Object.keys(pkg.files).length || fetched.entries.join("\0") !== pkg.entries.join("\0")) return false;
    for (const rel of rels) if (pkg.files[rel]?.hash !== (await hashText(fetched.files[rel]))) return false;
    return true;
}

/** fetch where a package updates from: https here; file: URLs only from an extension page (the Editor offers them) */
async function fetchSource(pkg: InstalledPackage): Promise<FetchedPackage | null> {
    const from = updateSource(pkg);
    if (!from) return null; // installed from a folder or zip, no updateURL
    const src = parseSource(from);
    if (typeof src === "string") throw new Error(src);
    if (!isRemote(src)) return null;
    const p = await fetchPackage(src, webNet);
    return { source: pkg.source, entries: p.entries, files: p.files, revision: p.revision };
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

/** a package whose every entry script was deleted is gone */
async function prune(): Promise<void> {
    const all = await listPackages();
    if (!Object.keys(all).length) return;
    const ids = new Set((await listScripts()).map((s) => s.id));
    const gone = Object.keys(all).filter((k) => !entryIds(all[k]).some((id) => ids.has(id)));
    if (!gone.length) return;
    for (const k of gone) delete all[k];
    await storageSet({ [PACKAGES_KEY]: all });
}

export const UPDATE_ALARM = "wtPackageUpdates"; // the extension's former name (Wiretrick): kept so stored data survives
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
