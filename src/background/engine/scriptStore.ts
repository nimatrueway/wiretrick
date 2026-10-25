/**
 * chrome.storage.local backed script store.
 */
import { dependantsOf, folderOf } from "../../shared/scriptImports";
import type { ResMeta } from "../../shared/metaParser";
import { compileForStorage, SANDBOX_COMPILE_FAILED } from "../compileHost";
import { dlogLevel } from "../../shared/debugLog";
import { clearScriptErrors, clearScriptTypeErrors } from "./logs";
import { DATA_FILES_KEY, FOLDERS_KEY, MAX_DATA_FILE, setDataFilesSnapshot, type DataFile } from "./dataFiles";
import { allFolders, ancestorFolders, isInFolder, movedPath, stackingOrder } from "../../shared/folders";
import { dataFilePathProblem, folderPathProblem, scriptNameProblem, scriptFileKey } from "../../shared/scriptName";

export interface Script {
    id: string;
    code: string;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    meta: ResMeta;
    /** param definitions from wt.params / wt.defineParam (captured at save time) */
    paramDefs?: Record<string, import("../../shared/scriptDef").ParamDef>;
}

const STORE_KEY = "resScripts";
const ORDER_KEY = "resScriptOrder";
/** the extension version that compiled the stored meta */
const META_VERSION_KEY = "resMetaVersion";

// MV2 browsers don't support promise-based chrome.storage — wrap callbacks.
function storageGet(keys: string | string[] | null): Promise<Record<string, any>> {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys as any, (d) => {
            void chrome.runtime.lastError; // treat as empty
            resolve(d || {});
        });
    });
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set(items, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

const listeners = new Set<() => void>();

export function onScriptsChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

type RenameListener = (oldName: string, newName: string) => void | Promise<void>;
const renameListeners = new Set<RenameListener>();

/** a script's name changed — awaited before the change is announced */
export function onScriptRenamed(fn: RenameListener): () => void {
    renameListeners.add(fn);
    return () => renameListeners.delete(fn);
}

function notify(): void {
    listeners.forEach((fn) => fn());
}

/** every script in stacking order (= explorer order: depth-first, subfolders before a folder's scripts) */
export async function listScripts(): Promise<Script[]> {
    const obj = await storageGet([STORE_KEY, ORDER_KEY, FOLDERS_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    return stackingOrder(
        order.filter((id) => byId[id]).map((id) => byId[id]),
        (s) => s.meta.name,
        obj[FOLDERS_KEY] || []
    );
}

export async function getScript(id: string): Promise<Script | undefined> {
    const obj = await storageGet(STORE_KEY);
    return (obj[STORE_KEY] || {})[id];
}

export async function saveScript(partial: Pick<Script, "id" | "code"> & Partial<Script> & { name?: string }): Promise<Script> {
    const obj = await storageGet([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    const prev = byId[partial.id];
    // the script's name is the manager/file name — keep the previous name when the caller didn't pass one
    // (e.g. setEnabled re-saves the stored script). Resolved BEFORE
    // compiling so sandbox analyze logs identify the script.
    const name = partial.name ?? prev?.meta.name;
    // compile (not just parse) so handler routes and params land in meta;
    // imports resolve against the other stored scripts (a param definition
    // imported from a utility is captured with its real type) and to stubs
    // where they don't resolve — capture must not depend on other scripts
    // loading cleanly (routes built from imports are refined by the
    // reload-time analyze). MV3: compiles in the sandbox page (the SW
    // cannot eval) — see compileHost.
    const allValues = await loadAllParamValues();
    const compiled = await compileForStorage(partial.code, name, allValues[partial.id], { id: partial.id, scripts: plain(byId), paramValues: allValues });
    // MV3 sandbox RPC failure (host unavailable): keep the previous
    // meta/paramDefs rather than corrupting an active script into a
    // utility — the next save recomputes. (The sentinel error string comes
    // from compileHost — matched exactly: user compile errors carry stacks
    // that mention sandbox.js.)
    const rpcFailed = compiled.error === SANDBOX_COMPILE_FAILED;
    if (rpcFailed) dlogLevel("compile", "warn", `saveScript "${name ?? prev?.meta.name}": sandbox compile failed — keeping previous meta/paramDefs`);
    const meta = rpcFailed ? prev?.meta ?? compiled.meta : compiled.meta;
    if (name) meta.name = name;
    const script: Script = {
        id: partial.id,
        code: partial.code,
        enabled: partial.enabled ?? prev?.enabled ?? true,
        createdAt: prev?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        error: rpcFailed ? prev?.error ?? null : compiled.error,
        meta,
        paramDefs: rpcFailed ? prev?.paramDefs ?? compiled.paramDefs : compiled.paramDefs ?? prev?.paramDefs,
    };
    byId[partial.id] = script;
    if (!order.includes(partial.id)) {
        order.push(partial.id);
    }
    // new code/name → the scripts importing it see different exports (or,
    // for a library saved after its importers, see it at all)
    if (!prev || prev.code !== script.code || prev.meta.name !== script.meta.name) {
        const importers = dependantsOf(script.meta.name, plain(byId)).filter((id) => id !== script.id);
        if (prev && prev.meta.name !== script.meta.name) importers.push(...dependantsOf(prev.meta.name, plain(byId)).filter((id) => id !== script.id && !importers.includes(id)));
        await recompileMeta(byId, importers, allValues);
    }
    const items: Record<string, any> = { [STORE_KEY]: byId, [ORDER_KEY]: order };
    // moved out of a folder: the folder stays (as on disk)
    if (prev && folderOf(prev.meta.name) !== folderOf(script.meta.name)) {
        const folders = await keptFolders([prev.meta.name]);
        if (folders) items[FOLDERS_KEY] = folders;
    }
    await storageSet(items);
    if (prev && prev.meta.name !== script.meta.name) {
        for (const fn of renameListeners) await fn(prev.meta.name, script.meta.name);
    }
    // new code → stale runtime errors no longer apply
    if (prev && prev.code !== script.code) {
        void clearScriptErrors(script.id);
        // …for the scripts importing it too: they run the new code from now on
        const all = Object.values(byId).map((x) => ({ id: x.id, name: x.meta.name, code: x.code }));
        for (const id of dependantsOf(script.meta.name, all)) if (id !== script.id) void clearScriptErrors(id);
    }
    notify();
    return script;
}

function plain(byId: { [id: string]: Script }): { id: string; name: string; code: string }[] {
    return Object.values(byId).map((x) => ({ id: x.id, name: x.meta.name, code: x.code }));
}

/**
 * Re-derive stored meta/paramDefs/error of `ids` in place (their code is
 * unchanged, but what they import or their param values changed — e.g. a
 * utility whose handlers register only for some param value becomes a
 * script). Returns the ids that changed. updatedAt is left alone: the
 * code didn't change.
 */
async function recompileMeta(byId: { [id: string]: Script }, ids: string[], allValues: { [scriptId: string]: Record<string, any> }): Promise<string[]> {
    const changed: string[] = [];
    for (const id of ids) {
        const s = byId[id];
        if (!s) continue;
        const c = await compileForStorage(s.code, s.meta.name, allValues[id], { id, scripts: plain(byId), paramValues: allValues });
        if (c.error === SANDBOX_COMPILE_FAILED) continue; // keep what we have
        const meta = { ...c.meta, name: s.meta.name };
        const paramDefs = c.paramDefs ?? s.paramDefs;
        if (JSON.stringify([meta, paramDefs, c.error]) === JSON.stringify([s.meta, s.paramDefs, s.error])) continue;
        byId[id] = { ...s, meta, paramDefs, error: c.error };
        changed.push(id);
    }
    return changed;
}

/**
 * Meta stored by another extension version (route parsing may have
 * changed since — e.g. `binary: false` used to be dropped) or before
 * routes recorded their registration line: recompile it once, at startup.
 */
export async function refreshStaleMeta(): Promise<void> {
    const obj = await storageGet([STORE_KEY, META_VERSION_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const version = chrome.runtime.getManifest().version;
    const otherVersion = obj[META_VERSION_KEY] !== version;
    const stale = Object.values(byId)
        .filter((s) => otherVersion || s.meta.routes?.some((r) => r.line === undefined))
        .map((s) => s.id);
    const changed = stale.length ? await recompileMeta(byId, stale, await loadAllParamValues()) : [];
    if (otherVersion) await storageSet({ [META_VERSION_KEY]: version });
    if (!changed.length) return;
    // re-read: a save may have landed while compiling (MV3: sandbox RPC)
    const fresh: { [id: string]: Script } = (await storageGet(STORE_KEY))[STORE_KEY] || {};
    for (const id of changed) if (fresh[id]?.code === byId[id].code) fresh[id] = { ...fresh[id], meta: byId[id].meta, paramDefs: byId[id].paramDefs, error: byId[id].error };
    await storageSet({ [STORE_KEY]: fresh });
    notify();
}

export async function deleteScript(id: string): Promise<void> {
    void clearScriptErrors(id);
    void clearScriptTypeErrors(id);
    const obj = await storageGet([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || [];
    const gone = byId[id];
    const importers = gone ? dependantsOf(gone.meta.name, plain(byId)).filter((x) => x !== id) : [];
    delete byId[id];
    // its importers' imports now resolve to stubs: drop what came from it (e.g. imported param defs)
    if (importers.length) await recompileMeta(byId, importers, await loadAllParamValues());
    const folders = gone ? await keptFolders([gone.meta.name]) : null;
    await storageSet({
        [STORE_KEY]: byId,
        [ORDER_KEY]: order.filter((x) => x !== id),
        ...(folders ? { [FOLDERS_KEY]: folders } : {}),
    });
    notify();
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
    const script = await getScript(id);
    if (!script) return;
    script.enabled = enabled;
    await saveScript(script);
}

export function newId(): string {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// ---- data files and folders ----

async function loadDataStore(): Promise<{ [id: string]: DataFile }> {
    return (await storageGet(DATA_FILES_KEY))[DATA_FILES_KEY] || {};
}

async function loadFolderList(): Promise<string[]> {
    return (await storageGet(FOLDERS_KEY))[FOLDERS_KEY] || [];
}

/**
 * The explicit folder list plus the folders of `paths` (about to be
 * deleted or moved away — their folders stay, like on disk), or null when
 * nothing needs adding.
 */
async function keptFolders(paths: string[]): Promise<string[] | null> {
    const folders = await loadFolderList();
    const keys = new Set(folders.map((f) => f.toLowerCase()));
    let added = false;
    for (const p of paths) {
        const f = folderOf(p);
        if (f && !keys.has(f.toLowerCase())) {
            folders.push(f);
            keys.add(f.toLowerCase());
            added = true;
        }
    }
    return added ? folders : null;
}

export function newDataFileId(): string {
    return "d_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/** data files sorted by path */
export async function listDataFiles(): Promise<DataFile[]> {
    return Object.values(await loadDataStore()).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

export async function getDataFile(id: string): Promise<DataFile | undefined> {
    return (await loadDataStore())[id];
}

/** every folder path, explicit (empty ones included) and implied by the scripts and data files in it, sorted */
export async function listFolders(): Promise<string[]> {
    const obj = await storageGet([STORE_KEY, DATA_FILES_KEY, FOLDERS_KEY]);
    const scripts: Script[] = Object.values(obj[STORE_KEY] || {});
    const data: DataFile[] = Object.values(obj[DATA_FILES_KEY] || {});
    return allFolders(obj[FOLDERS_KEY] || [], [...scripts.map((s) => s.meta.name), ...data.map((d) => d.path)]);
}

/** a data file's path clash with another data file or a folder (case-insensitive), or "" */
function dataFileClash(path: string, data: { [id: string]: DataFile }, folders: string[], selfId?: string): string {
    const key = path.toLowerCase();
    const other = Object.values(data).find((d) => d.id !== selfId && d.path.toLowerCase() === key);
    if (other) return `a data file "${other.path}" already exists`;
    if (folders.some((f) => f.toLowerCase() === key)) return `a folder "${path}" already exists`;
    const asFolder = ancestorFolders(path).find((f) => Object.values(data).some((d) => d.id !== selfId && d.path.toLowerCase() === f.toLowerCase()));
    if (asFolder) return `"${asFolder}" is a data file, not a folder`;
    return "";
}

/** after data files changed: the snapshot, the importers' meta, storage, errors, listeners */
async function commitDataFiles(byId: { [id: string]: Script }, data: { [id: string]: DataFile }, importers: string[], extra: Record<string, any> = {}): Promise<void> {
    setDataFilesSnapshot(data);
    await recompileMeta(byId, importers, await loadAllParamValues());
    await storageSet({ [STORE_KEY]: byId, [DATA_FILES_KEY]: data, ...extra });
    // they run with the new data from now on
    for (const id of importers) void clearScriptErrors(id);
    notify();
}

/**
 * Create or update a data file (`id` absent: a new one). `path` absent
 * keeps the stored path (a different one renames/moves it), `text` absent
 * the stored text. Its importers (transitively) recompile and hot-apply.
 * Throws on an invalid path, a clash, or a text over MAX_DATA_FILE.
 */
export async function saveDataFile(partial: { id?: string; path?: string; text?: string }): Promise<DataFile> {
    const obj = await storageGet([STORE_KEY, DATA_FILES_KEY, FOLDERS_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const data: { [id: string]: DataFile } = obj[DATA_FILES_KEY] || {};
    const id = partial.id || newDataFileId();
    const prev = data[id];
    const path = partial.path ?? prev?.path;
    const text = partial.text ?? prev?.text ?? "";
    if (!path) throw new Error("a data file needs a path");
    const problem = dataFilePathProblem(path);
    if (problem) throw new Error(`invalid data file path "${path}": ${problem}`);
    if (text.length > MAX_DATA_FILE) throw new Error(`data file "${path}" is too large (${(text.length / 1048576).toFixed(1)} MB; at most 5 MB)`);
    const folders = allFolders(obj[FOLDERS_KEY] || [], [...Object.values(byId).map((s) => s.meta.name), ...Object.values(data).filter((d) => d.id !== id).map((d) => d.path)]);
    const clash = dataFileClash(path, data, folders, id);
    if (clash) throw new Error(clash);
    const file: DataFile = { id, path, text, savedAt: Date.now() };
    data[id] = file;
    const importers = dependantsOf(path, plain(byId), "data");
    if (prev && prev.path !== path) for (const x of dependantsOf(prev.path, plain(byId), "data")) if (!importers.includes(x)) importers.push(x);
    const kept = prev && folderOf(prev.path) !== folderOf(path) ? await keptFolders([prev.path]) : null;
    await commitDataFiles(byId, data, importers, kept ? { [FOLDERS_KEY]: kept } : {});
    return file;
}

export async function deleteDataFile(id: string): Promise<void> {
    const obj = await storageGet([STORE_KEY, DATA_FILES_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const data: { [id: string]: DataFile } = obj[DATA_FILES_KEY] || {};
    const gone = data[id];
    if (!gone) return;
    delete data[id];
    const kept = await keptFolders([gone.path]);
    await commitDataFiles(byId, data, dependantsOf(gone.path, plain(byId), "data"), kept ? { [FOLDERS_KEY]: kept } : {});
}

/** add an (empty) folder; its missing parents are implied. Throws on an invalid path or a clash with a data file. */
export async function createFolder(path: string): Promise<void> {
    const problem = folderPathProblem(path);
    if (problem) throw new Error(`invalid folder name "${path}": ${problem}`);
    const data = await loadDataStore();
    const clash = [path, ...ancestorFolders(path)].find((f) => Object.values(data).some((d) => d.path.toLowerCase() === f.toLowerCase()));
    if (clash) throw new Error(`"${clash}" is a data file`);
    const folders = await loadFolderList();
    if (folders.some((f) => f.toLowerCase() === path.toLowerCase())) return;
    await storageSet({ [FOLDERS_KEY]: [...folders, path] });
    notify();
}

/**
 * Rename/move a folder: every script, data file and subfolder in it moves
 * along (scripts keep their settings.yaml sections, like a script rename).
 * Import specifiers elsewhere are not rewritten. Throws on an invalid
 * target, a move into itself, or a clash.
 */
export async function renameFolder(from: string, to: string): Promise<void> {
    if (from === to) return;
    const problem = folderPathProblem(to);
    if (problem) throw new Error(`invalid folder name "${to}": ${problem}`);
    if (isInFolder(to, from)) throw new Error(`can't move "${from}" into itself`);
    const obj = await storageGet([STORE_KEY, DATA_FILES_KEY, FOLDERS_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const data: { [id: string]: DataFile } = obj[DATA_FILES_KEY] || {};
    const explicit: string[] = obj[FOLDERS_KEY] || [];
    const scripts = Object.values(byId);
    const files = Object.values(data);
    const existing = allFolders(explicit, [...scripts.map((s) => s.meta.name), ...files.map((d) => d.path)]);
    if (!existing.includes(from)) throw new Error(`no folder "${from}"`);
    // only a case change may land on an existing folder (itself)
    if (to.toLowerCase() !== from.toLowerCase() && existing.some((f) => f.toLowerCase() === to.toLowerCase())) throw new Error(`a folder "${to}" already exists`);
    const dataClash = [to, ...ancestorFolders(to)].find((f) => files.some((d) => !isInFolder(d.path, from) && d.path.toLowerCase() === f.toLowerCase()));
    if (dataClash) throw new Error(`"${dataClash}" is a data file`);
    const before = plain(byId);
    const renamed: [string, string][] = [];
    const moved: string[] = [];
    for (const s of scripts) {
        if (!isInFolder(s.meta.name, from)) continue;
        const next = movedPath(s.meta.name, from, to);
        if (scriptNameProblem(next)) throw new Error(`can't move "${s.meta.name}": ${scriptNameProblem(next)}`);
        renamed.push([s.meta.name, next]);
        moved.push(s.id);
    }
    const takenKeys = new Set(scripts.filter((s) => !isInFolder(s.meta.name, from)).map((s) => scriptFileKey(s.meta.name)));
    const taken = renamed.find(([, next]) => takenKeys.has(scriptFileKey(next)));
    if (taken) throw new Error(`a script named "${taken[1]}" already exists`);
    const movedData: [string, string][] = [];
    for (const d of files) {
        if (!isInFolder(d.path, from)) continue;
        const next = movedPath(d.path, from, to);
        movedData.push([d.path, next]);
        data[d.id] = { ...d, path: next };
    }
    for (const s of scripts) if (moved.includes(s.id)) byId[s.id] = { ...s, meta: { ...s.meta, name: movedPath(s.meta.name, from, to) } };
    const after = plain(byId);
    const folders = explicit.map((f) => (f.toLowerCase() === from.toLowerCase() ? to : movedPath(f, from, to)));
    if (!folders.includes(to)) folders.push(to);
    // the moved scripts resolve their relative imports from the new folder;
    // whatever imported the old or imports the new paths recompiles
    const affected = new Set(moved);
    for (const [a, b] of renamed) for (const id of [...dependantsOf(a, before), ...dependantsOf(b, after)]) affected.add(id);
    for (const [a, b] of movedData) for (const id of [...dependantsOf(a, before, "data"), ...dependantsOf(b, after, "data")]) affected.add(id);
    setDataFilesSnapshot(data);
    await recompileMeta(byId, [...affected], await loadAllParamValues());
    await storageSet({ [STORE_KEY]: byId, [DATA_FILES_KEY]: data, [FOLDERS_KEY]: folders });
    for (const [a, b] of renamed) for (const fn of renameListeners) await fn(a, b);
    for (const id of affected) void clearScriptErrors(id);
    notify();
}

/** delete a folder and everything in it; the counts of what went */
export async function deleteFolder(path: string): Promise<{ scripts: number; dataFiles: number; folders: number }> {
    const obj = await storageGet([STORE_KEY, ORDER_KEY, DATA_FILES_KEY, FOLDERS_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    const data: { [id: string]: DataFile } = obj[DATA_FILES_KEY] || {};
    const explicit: string[] = obj[FOLDERS_KEY] || [];
    const inside = (p: string) => isInFolder(p, path);
    const before = plain(byId);
    const goneScripts = Object.values(byId).filter((s) => inside(s.meta.name));
    const goneData = Object.values(data).filter((d) => inside(d.path));
    const subfolders = allFolders(explicit, [...before.map((s) => s.name), ...Object.values(data).map((d) => d.path)]).filter(inside);
    for (const s of goneScripts) {
        delete byId[s.id];
        void clearScriptErrors(s.id);
        void clearScriptTypeErrors(s.id);
    }
    for (const d of goneData) delete data[d.id];
    const importers = new Set<string>();
    for (const s of goneScripts) for (const id of dependantsOf(s.meta.name, before)) if (byId[id]) importers.add(id);
    for (const d of goneData) for (const id of dependantsOf(d.path, before, "data")) if (byId[id]) importers.add(id);
    setDataFilesSnapshot(data);
    if (importers.size) await recompileMeta(byId, [...importers], await loadAllParamValues());
    const folders = explicit.filter((f) => f.toLowerCase() !== path.toLowerCase() && !inside(f));
    // its parent stays
    const parent = folderOf(path);
    if (parent && !folders.some((f) => f.toLowerCase() === parent.toLowerCase())) folders.push(parent);
    await storageSet({
        [STORE_KEY]: byId,
        [ORDER_KEY]: order.filter((id) => byId[id]),
        [DATA_FILES_KEY]: data,
        [FOLDERS_KEY]: folders,
    });
    notify();
    return { scripts: goneScripts.length, dataFiles: goneData.length, folders: subfolders.length };
}

// ---- per-script KV storage ----
const SCRIPT_STORE_PREFIX = "resStore.";

export async function scriptStorageGet(scriptId: string, key: string): Promise<any> {
    const obj = await storageGet(SCRIPT_STORE_PREFIX + scriptId);
    return (obj[SCRIPT_STORE_PREFIX + scriptId] || {})[key];
}

export async function scriptStorageSet(scriptId: string, key: string, value: any): Promise<void> {
    const storeKey = SCRIPT_STORE_PREFIX + scriptId;
    const obj = await storageGet(storeKey);
    const data = obj[storeKey] || {};
    data[key] = value;
    await storageSet({ [storeKey]: data });
}

// ---- per-script parameter values (wt.params / wt.defineParam) ----
const PARAMS_KEY = "resParams";

/** Load all stored param values: { scriptId: { key: value } }. */
export async function loadAllParamValues(): Promise<{ [scriptId: string]: Record<string, any> }> {
    const obj = await storageGet(PARAMS_KEY);
    return obj[PARAMS_KEY] || {};
}

export async function getParamValues(scriptId: string): Promise<Record<string, any>> {
    return (await loadAllParamValues())[scriptId] || {};
}

export async function setParamValue(scriptId: string, key: string, value: any): Promise<void> {
    const all = await loadAllParamValues();
    all[scriptId] = { ...(all[scriptId] || {}), [key]: value };
    await storageSet({ [PARAMS_KEY]: all });
    // handlers/params may depend on param values (a utility that registers
    // handlers only when a param is on turns into a script): refresh the
    // stored meta of the script and its importers
    const obj = await storageGet(STORE_KEY);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const s = byId[scriptId];
    const changed = s ? await recompileMeta(byId, [scriptId, ...dependantsOf(s.meta.name, plain(byId)).filter((id) => id !== scriptId)], all) : [];
    if (changed.length) {
        // re-read: a save may have landed while compiling (MV3: sandbox RPC)
        const fresh: { [id: string]: Script } = (await storageGet(STORE_KEY))[STORE_KEY] || {};
        for (const id of changed) {
            const u = byId[id];
            if (fresh[id]?.code !== u.code) continue;
            // a value the script can't load with (e.g. its `parse` throws) is
            // a compile error: stored below, shown in the Problems view
            fresh[id] = { ...fresh[id], meta: u.meta, paramDefs: u.paramDefs, error: u.error };
        }
        await storageSet({ [STORE_KEY]: fresh });
    }
    notify();
}
