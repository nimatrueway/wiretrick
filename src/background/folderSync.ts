/**
 * Background-side scripts-folder sync — the ONLY code that touches the
 * folder. Owns the directory handle and the polling loop (the background
 * never gets timer-throttled, so external edits apply immediately).
 *
 * Model:
 *  - storage is the source of truth for scripts; `owned` records, per
 *    script id, the file it owns and the hash of the content both sides
 *    last agreed on (the merge base).
 *  - storage → disk: every store change (manager save/rename/delete,
 *    import, popup, folder) schedules reconcileToDisk(), which writes,
 *    renames and deletes files to match.
 *  - disk → storage: the poller diffs file signatures against `known`;
 *    every write of ours records the resulting signature in `known`, so
 *    our own writes are never mistaken for external edits.
 *  - a file that vanished is renamed (not deleted + created) only when a
 *    new file carries its exact last-synced content.
 *  - everything runs one-at-a-time through `serial()`: a poll never
 *    interleaves with a write.
 *  - when both sides changed, the newer one wins and the other copy is kept
 *    in .wiretrick-backup/ (nothing is silently lost).
 */
import { computeEvents, contentHash, loadSavedHandle, clearSavedHandle, saveHandle, type FileSig } from "../shared/folderSync";
import { saveScript, deleteScript, newId, listScripts, onScriptsChanged, onScriptRenamed, type Script } from "./engine/scriptStore";
import { getSettingsText, applySettingsText, rememberSettingsText, currentSettingsState, settingsTextParses } from "./settingsFile";
import { SETTINGS_FILE, SCHEMA_FILE } from "../shared/settingsYaml";
import { renameSettingsSection } from "../shared/settingsYamlPatch";
import { settingsSchemaJson } from "../shared/settingsSchema";
import { broadcastToUi } from "./engine/logs";
import { dlogLevel } from "../shared/debugLog";
import { scriptFileName, scriptNameFromFile, legacyScriptFileName } from "../shared/scriptName";
const POLL_MS = 1000;
const SCRIPT_EXT = ".ts";
export const BACKUP_DIR = ".wiretrick-backup";

/** canonical script file name for a display name */
function canonicalFileName(name: string): string {
    return scriptFileName(name);
}

/** legacy <name>.script.ts → canonical <name>.ts */
function canonicalizeFileName(fileName: string): string {
    return fileName.endsWith(".script.ts") ? fileName.replace(/\.script\.ts$/, SCRIPT_EXT) : fileName;
}

const isScriptFile = (name: string) => name.endsWith(".ts") && !name.endsWith(".d.ts");

/** a script's file and the content hash both sides last agreed on */
type Owned = { file: string; hash: string };

let dirHandle: any = null;
/** script files as last seen on disk (or as we just wrote them) */
let known = new Map<string, FileSig>();
/** script id → the file it owns + merge base */
let owned = new Map<string, Owned>();
/** canonical name → actual on-disk name when a legacy file stands in for it */
let realNameOf = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let displayPath = "";
let settingsHooked = false;

// ---- one operation at a time ----
let chain: Promise<unknown> = Promise.resolve();
/** run `fn` after every queued sync operation; never await serial() from inside one */
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
}

function broadcastStatus(): void {
    broadcastToUi({ type: "sync", status: { active: !!dirHandle, path: displayPath } } as any);
}

function describeHandle(handle: any): Promise<string> {
    return (async () => {
        try {
            if (typeof handle.getPath === "function") {
                return await handle.getPath(); // Chrome 129+: full path
            }
        } catch {}
        return handle.name || "(scripts folder)";
    })();
}

async function refreshKnown(): Promise<void> {
    const { seen, aliases } = await scanFolder();
    known = seen;
    realNameOf = aliases;
    await persistState();
}

// ---- persisted sync state ----
// The MV3 service worker can be stopped at any time (idle reaping, browser
// sleep, extension update). Without a persisted snapshot a restarted worker
// would rebuild `known` from the CURRENT folder and silently absorb every
// file added/changed/removed while it was down; without `owned` it would
// lose the merge base and couldn't tell which side changed.
const KNOWN_KEY = "folderSyncKnown";

function storageLocal(): chrome.storage.LocalStorageArea | null {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

async function persistState(): Promise<void> {
    const area = storageLocal();
    if (!area) return;
    const state = { files: Object.fromEntries(known), owned: Object.fromEntries(owned) };
    await new Promise<void>((r) => area.set({ [KNOWN_KEY]: state }, () => r()));
}

async function loadPersistedState(): Promise<{ files: Map<string, FileSig>; owned: Map<string, Owned> } | null> {
    const area = storageLocal();
    if (!area) return null;
    const obj: any = await new Promise((r) => area.get(KNOWN_KEY, r));
    const st = obj?.[KNOWN_KEY];
    if (!st || typeof st !== "object") return null;
    // pre-`owned` format: the bare file → sig map
    const files = st.files && typeof st.files === "object" ? st.files : st.owned ? {} : st;
    return {
        files: new Map(Object.entries(files) as [string, FileSig][]),
        owned: new Map(Object.entries(st.owned && typeof st.owned === "object" ? st.owned : {}) as [string, Owned][]),
    };
}

async function clearPersistedState(): Promise<void> {
    const area = storageLocal();
    if (!area?.remove) return;
    await new Promise<void>((r) => area.remove(KNOWN_KEY, () => r()));
}

/**
 * List script files as canonical names. Every .ts file is a script file;
 * .d.ts files are ignored. Legacy .script.ts files stand in for their
 * canonical .ts name (canonical wins when both exist) and migrate back.
 */
async function scanFolder(handle: any = dirHandle): Promise<{ seen: Map<string, FileSig>; aliases: Map<string, string> }> {
    const seen = new Map<string, FileSig>();
    const aliases = new Map<string, string>();
    const legacy: { name: string; sig: FileSig }[] = [];
    for await (const entry of handle.values()) {
        if (entry.kind !== "file" || !isScriptFile(entry.name)) continue;
        let f: File;
        try {
            f = await entry.getFile();
        } catch (e: any) {
            // removed/renamed between listing and reading (editor atomic save)
            if (e?.name === "NotFoundError") continue;
            throw e;
        }
        const sig = { lastModified: f.lastModified, size: f.size };
        if (entry.name.endsWith(".script.ts")) legacy.push({ name: entry.name, sig });
        else seen.set(entry.name, sig);
    }
    for (const { name, sig } of legacy) {
        const canonical = canonicalizeFileName(name);
        if (!seen.has(canonical)) {
            seen.set(canonical, sig);
            aliases.set(canonical, name);
        }
    }
    return { seen, aliases };
}

async function readText(fileName: string): Promise<string> {
    const fh = await dirHandle.getFileHandle(realNameOf.get(fileName) || fileName);
    return await (await fh.getFile()).text();
}

/** the file's text, or null when it doesn't exist (any more) */
async function readTextOrNull(fileName: string): Promise<string | null> {
    try {
        return await readText(fileName);
    } catch {
        return null;
    }
}

async function statFile(fileName: string): Promise<FileSig | null> {
    try {
        const f = await (await dirHandle.getFileHandle(realNameOf.get(fileName) || fileName)).getFile();
        return { lastModified: f.lastModified, size: f.size };
    } catch {
        return null;
    }
}

/**
 * Write a file. For script files the resulting signature goes into
 * `known` right away, so the next poll doesn't see our own write as an
 * external edit.
 */
async function writeFile(fileName: string, content: string): Promise<boolean> {
    if (!dirHandle) return false;
    try {
        const fh = await dirHandle.getFileHandle(fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: writing "${fileName}" failed: ${e?.message || e}`);
        return false;
    }
    if (isScriptFile(fileName)) {
        realNameOf.delete(fileName);
        const sig = await statFile(fileName);
        if (sig) known.set(fileName, sig);
    }
    return true;
}

/** remove a script file (and a legacy alias standing in for it) */
async function removeFile(fileName: string): Promise<void> {
    for (const n of new Set([fileName, realNameOf.get(fileName) || fileName])) {
        try {
            await dirHandle.removeEntry(n);
        } catch {}
    }
    known.delete(fileName);
    realNameOf.delete(fileName);
}

/** keep a copy of a version about to be overwritten (both sides had changed) */
async function backup(fileName: string, content: string, why: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${fileName.replace(/\.ts$/, "")} ${stamp}.ts.bak`;
    try {
        const d = await dirHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
        const w = await (await d.getFileHandle(name, { create: true })).createWritable();
        await w.write(content);
        await w.close();
        dlogLevel("sync", "warn", `Folder sync: ${why} — the other version was saved to ${BACKUP_DIR}/${name}`);
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: ${why} — keeping a backup failed: ${e?.message || e}`);
    }
}

/** Legacy <name>.script.ts standing in for <name>.ts → write canonical, drop legacy. */
async function migrateLegacy(fileName: string, content: string): Promise<void> {
    const real = realNameOf.get(fileName);
    if (!real) return;
    realNameOf.delete(fileName);
    if (!(await writeFile(fileName, content))) {
        realNameOf.set(fileName, real);
        return;
    }
    try {
        await dirHandle.removeEntry(real);
        dlogLevel("sync", "info", `Folder sync: migrated legacy "${real}" → "${fileName}"`);
    } catch {}
}

function displayNameFromFile(fileName: string): string {
    return scriptNameFromFile(fileName);
}

/** the script owning a file: by the recorded ownership, else by name */
function ownerOf(file: string, scripts: Script[]): Script | undefined {
    for (const [id, rec] of owned) {
        if (rec.file !== file) continue;
        const s = scripts.find((x) => x.id === id);
        if (s) return s;
    }
    return scripts.find((s) => canonicalFileName(s.meta.name) === file && !owned.has(s.id)) ??
        scripts.find((s) => canonicalFileName(s.meta.name) === file);
}

/** another script's file differs from `file` only by case (a clash on macOS/Windows) */
function caseClash(file: string, scripts: Script[], except?: string): Script | undefined {
    const key = file.toLowerCase();
    return scripts.find((s) => s.id !== except && canonicalFileName(s.meta.name).toLowerCase() === key);
}

// ---- disk → storage ----

/** a file's new text arrives for script `s` (edit on disk, or a re-added file) */
async function pullChange(file: string, text: string, s: Script): Promise<boolean> {
    const h = contentHash(text);
    const rec = owned.get(s.id);
    const storeHash = contentHash(s.code);
    if (h === storeHash) {
        owned.set(s.id, { file, hash: h }); // a touch, or both sides made the same edit
        return false;
    }
    // disk still holds the last-synced text: storage moved on and its write
    // is queued — don't revert storage to the old text
    if (rec && rec.file === file && rec.hash === h) return false;
    if (rec && rec.hash !== storeHash) {
        await backup(file, s.code, `"${file}" changed on disk while script "${s.meta.name}" also changed in the extension; the file wins`);
    }
    owned.set(s.id, { file, hash: h });
    await saveScript({ id: s.id, code: text, name: s.meta.name });
    await migrateLegacy(file, text);
    dlogLevel("sync", "info", `Folder sync: "${file}" changed on disk — script "${s.meta.name}" updated`);
    return true;
}

async function applyEvents(events: ReturnType<typeof computeEvents>): Promise<void> {
    const { changed, added, removed } = events;
    if (!changed.length && !added.length && !removed.length) return;
    let scripts = await listScripts();
    const texts = new Map<string, string | null>();
    const read = async (f: string) => {
        if (!texts.has(f)) texts.set(f, await readTextOrNull(f));
        return texts.get(f)!;
    };
    let touched = false;
    const announce = (file?: string) => {
        touched = true;
        broadcastToUi({ type: "scriptsChanged", source: "folder", file } as any);
    };

    // renames: a vanished file whose last-synced content reappears under a
    // new name (several per poll are fine; content edits + rename are not
    // a rename — they become delete + create)
    const newFiles = [...added];
    const gone = new Set(removed);
    for (const old of removed) {
        const s = ownerOf(old, scripts);
        if (!s) continue;
        const base = owned.get(s.id)?.hash ?? contentHash(s.code);
        for (const f of newFiles) {
            const t = await read(f);
            if (t === null || contentHash(t) !== base || ownerOf(f, scripts)) continue;
            newFiles.splice(newFiles.indexOf(f), 1);
            gone.delete(old);
            const name = displayNameFromFile(f);
            const clash = caseClash(canonicalFileName(name), scripts, s.id);
            if (clash) {
                dlogLevel("sync", "warn", `Folder sync: "${old}" was renamed to "${f}", but script "${clash.meta.name}" already uses that name (letter case is ignored on macOS/Windows) — renaming its script skipped`);
                owned.set(s.id, { file: f, hash: base });
                break;
            }
            owned.set(s.id, { file: canonicalFileName(name), hash: contentHash(t) });
            await saveScript({ id: s.id, code: t, name });
            await adoptCanonicalName(f, name, t);
            dlogLevel("sync", "info", `Folder sync: "${old}" renamed to "${f}" — script renamed to "${name}"`);
            announce(f);
            break;
        }
    }
    if (touched) scripts = await listScripts();

    for (const file of changed) {
        const s = ownerOf(file, scripts);
        const text = s ? await read(file) : null;
        if (s && text !== null && (await pullChange(file, text, s))) announce(file);
    }

    for (const file of newFiles) {
        const text = await read(file);
        if (text === null) continue;
        const s = ownerOf(file, scripts);
        if (s) {
            // a file for an existing script appeared (re-created, or copied over it)
            if (await pullChange(file, text, s)) announce(file);
            continue;
        }
        const name = displayNameFromFile(file);
        const clash = caseClash(canonicalFileName(name), scripts);
        if (clash) {
            dlogLevel("sync", "warn", `Folder sync: "${file}" not imported — script "${clash.meta.name}" already uses that name (letter case is ignored on macOS/Windows)`);
            continue;
        }
        const id = newId();
        owned.set(id, { file: canonicalFileName(name), hash: contentHash(text) });
        await saveScript({ id, code: text, name });
        await migrateLegacy(file, text);
        await adoptCanonicalName(file, name, text);
        scripts = await listScripts();
        dlogLevel("sync", "info", `Folder sync: new file "${file}" imported as script "${name}"`);
        announce(file);
    }

    for (const file of gone) {
        const s = ownerOf(file, scripts);
        if (!s) continue;
        const rec = owned.get(s.id);
        if (rec && rec.hash !== contentHash(s.code)) {
            // the script changed in the extension since the last sync: its
            // edits would be lost — write the file back instead of deleting
            await writeFile(file, s.code);
            owned.set(s.id, { file, hash: contentHash(s.code) });
            dlogLevel("sync", "warn", `Folder sync: "${file}" was deleted on disk, but script "${s.meta.name}" has newer changes in the extension — the file was written back`);
            continue;
        }
        owned.delete(s.id);
        await deleteScript(s.id);
        dlogLevel("sync", "info", `Folder sync: "${file}" deleted on disk — script "${s.meta.name}" removed`);
        announce(file);
    }
}

/**
 * A file whose name doesn't round-trip through the script name (e.g.
 * "a:b.ts" → script "a:b" → "a_b.ts") would never match its script again,
 * so later edits/deletes of it would be ignored. Rename it on disk to the
 * canonical name the manager also uses.
 */
async function adoptCanonicalName(fileName: string, scriptName: string, code: string): Promise<void> {
    const canonical = canonicalFileName(scriptName);
    if (canonical === fileName || realNameOf.has(fileName)) return;
    if (!(await writeFile(canonical, code))) return;
    try {
        await dirHandle.removeEntry(fileName);
    } catch {}
    known.delete(fileName);
    dlogLevel("sync", "info", `Folder sync: renamed "${fileName}" → "${canonical}" to match its script name`);
}

// ---- storage → disk ----

/** delete a file we no longer own — unless it was edited since we last synced it */
async function removeIfUnchanged(rec: Owned, why: string): Promise<void> {
    const cur = await readTextOrNull(rec.file);
    if (cur === null) {
        known.delete(rec.file);
        return;
    }
    if (contentHash(cur) !== rec.hash) {
        dlogLevel("sync", "warn", `Folder sync: "${rec.file}" was left on disk (${why}) — it has edits that never reached the extension`);
        return;
    }
    await removeFile(rec.file);
}

let clashWarned = new Set<string>();

/**
 * Make the folder match storage: write changed scripts, follow renames,
 * delete files of deleted scripts. A file edited on disk since the last
 * poll is left for the poller (which applies it first; the store change
 * then comes back here).
 */
async function reconcileToDisk(): Promise<void> {
    if (!dirHandle) return;
    const scripts = await listScripts();
    const ids = new Set(scripts.map((s) => s.id));
    let wrote = false;
    for (const [id, rec] of [...owned]) {
        if (ids.has(id)) continue;
        owned.delete(id);
        await removeIfUnchanged(rec, "its script was deleted");
        wrote = true;
    }
    const claimed = new Map<string, Script>();
    for (const s of scripts) {
        const file = canonicalFileName(s.meta.name);
        const key = file.toLowerCase();
        const other = claimed.get(key);
        if (other) {
            if (!clashWarned.has(key)) dlogLevel("sync", "warn", `Folder sync: scripts "${other.meta.name}" and "${s.meta.name}" would share one file on macOS/Windows — "${s.meta.name}" is not written to the folder; rename one of them`);
            clashWarned.add(key);
            continue;
        }
        claimed.set(key, s);
        const h = contentHash(s.code);
        const rec = owned.get(s.id);
        if (rec && rec.file !== file) {
            // renamed in the extension: move the file. A case-only rename
            // is the SAME file on macOS/Windows — remove first, or the
            // delete would take the freshly written file with it
            const caseOnly = rec.file.toLowerCase() === key;
            const old = rec;
            if (caseOnly) await removeFile(old.file);
            if (!(await writeFile(file, s.code))) continue;
            if (!caseOnly) await removeIfUnchanged(old, `script renamed to "${s.meta.name}"`);
            owned.set(s.id, { file, hash: h });
            dlogLevel("sync", "info", `Folder sync: "${old.file}" → "${file}" (script renamed)`);
            wrote = true;
            continue;
        }
        if (rec && rec.hash === h) continue; // in sync
        const sig = await statFile(file);
        const seen = known.get(file);
        if (sig && (!seen || seen.lastModified !== sig.lastModified || seen.size !== sig.size)) continue; // unseen external edit: poll first
        const cur = sig ? await readTextOrNull(file) : null;
        if (cur !== null && contentHash(cur) === h) {
            owned.set(s.id, { file, hash: h });
            continue;
        }
        if (cur !== null && !rec) await backup(file, cur, `"${file}" was replaced by script "${s.meta.name}"`);
        if (!(await writeFile(file, s.code))) continue;
        owned.set(s.id, { file, hash: h });
        wrote = true;
    }
    if (wrote) await persistState();
}

/** the settings section follows a renamed script in the synced file too */
async function renameSettingsOnDisk(oldName: string, newName: string): Promise<void> {
    if (!dirHandle) return;
    const f = await readSettingsFile();
    if (!f) return;
    const next = renameSettingsSection(f.text, oldName, newName);
    if (next === f.text) return;
    if (await writeFile(SETTINGS_FILE, next)) settingsSig = (await readSettingsFile())?.sig ?? null;
}

/**
 * Files used to be named by a lossy mapping ("Redirect a URL" →
 * "Redirect_a_URL.ts"); now the file name is the script name. Rename old
 * files whose script has no file under its exact name yet.
 */
async function migrateLegacyNames(seen: Map<string, FileSig>, byFile: Map<string, any>): Promise<void> {
    for (const [canonical, s] of byFile) {
        const legacy = legacyScriptFileName(s.meta.name);
        if (legacy === canonical || seen.has(canonical) || !seen.has(legacy) || byFile.has(legacy)) continue;
        try {
            const text = await readText(legacy);
            await writeFile(canonical, text);
            await dirHandle.removeEntry(realNameOf.get(legacy) || legacy);
            const f = await (await dirHandle.getFileHandle(canonical)).getFile();
            seen.delete(legacy);
            realNameOf.delete(legacy);
            seen.set(canonical, { lastModified: f.lastModified, size: f.size });
            dlogLevel("sync", "info", `Folder sync: renamed "${legacy}" → "${canonical}" (file names now match script names exactly)`);
        } catch (e: any) {
            dlogLevel("sync", "warn", `Folder sync: renaming "${legacy}" → "${canonical}" failed: ${e?.message || e}`);
        }
    }
}

export interface FolderPreview {
    /** files that become new scripts */
    imported: string[];
    /** scripts written out as new files */
    written: string[];
    /** both exist and differ: the newer side wins, the other is backed up */
    conflicts: { name: string; winner: "file" | "script" }[];
}

/**
 * Two-way reconcile when a folder is picked or (re)connected. Files with no
 * script are imported, scripts with no file are written out. When both
 * exist but differ: with a merge base (resume) the side that changed wins;
 * otherwise — or when both changed — the newer one wins and the other copy
 * is kept in the backup folder. `dry`: only report what would happen.
 */
async function initialSync(opts: { dry?: boolean; handle?: any; base?: Map<string, Owned> } = {}): Promise<FolderPreview> {
    const dry = !!opts.dry;
    const handle = opts.handle ?? dirHandle;
    const { seen, aliases } = await scanFolder(handle);
    const scripts = await listScripts();
    const byFile = new Map(scripts.map((s) => [canonicalFileName(s.meta.name), s]));
    const out: FolderPreview = { imported: [], written: [], conflicts: [] };
    const readFrom = async (name: string) => (await (await handle.getFileHandle(aliases.get(name) || name)).getFile()).text();
    if (!dry) {
        realNameOf = aliases;
        await migrateLegacyNames(seen, byFile);
    }
    for (const [fileName, sig] of seen) {
        const text = await readFrom(fileName);
        const s = byFile.get(fileName);
        byFile.delete(fileName);
        if (!s) {
            const name = displayNameFromFile(fileName);
            const clash = caseClash(canonicalFileName(name), scripts);
            if (clash) {
                if (!dry) dlogLevel("sync", "warn", `Folder sync: "${fileName}" not imported — script "${clash.meta.name}" already uses that name (letter case is ignored on macOS/Windows)`);
                continue;
            }
            out.imported.push(fileName);
            if (dry) continue;
            const id = newId();
            owned.set(id, { file: canonicalFileName(name), hash: contentHash(text) });
            await saveScript({ id, code: text, name });
            await migrateLegacy(fileName, text);
            await adoptCanonicalName(fileName, name, text);
            continue;
        }
        const hd = contentHash(text);
        const hs = contentHash(s.code);
        if (hd === hs) {
            if (!dry) {
                owned.set(s.id, { file: fileName, hash: hd });
                await migrateLegacy(fileName, text);
            }
            continue;
        }
        const rec = (opts.base ?? owned).get(s.id);
        const base = rec && rec.file === fileName ? rec.hash : null;
        let pull: boolean;
        let conflict = false;
        if (base === hs) pull = true; // only the file changed
        else if (base === hd) pull = false; // only the script changed
        else {
            pull = sig.lastModified > s.updatedAt;
            conflict = true;
            out.conflicts.push({ name: s.meta.name, winner: pull ? "file" : "script" });
        }
        if (dry) continue;
        if (pull) {
            if (conflict) await backup(fileName, s.code, `script "${s.meta.name}" and "${fileName}" both changed; the newer file wins`);
            owned.set(s.id, { file: fileName, hash: hd });
            await saveScript({ id: s.id, code: text, name: s.meta.name });
            await migrateLegacy(fileName, text);
        } else {
            if (conflict) await backup(fileName, text, `script "${s.meta.name}" and "${fileName}" both changed; the newer script wins`);
            await writeFile(fileName, s.code);
            owned.set(s.id, { file: fileName, hash: hs });
            await migrateLegacy(fileName, s.code);
        }
    }
    for (const [fileName, s] of byFile) {
        if (caseClash(fileName, scripts, s.id) && [...seen.keys()].some((f) => f.toLowerCase() === fileName.toLowerCase())) continue;
        out.written.push(fileName);
        if (dry) continue;
        await writeFile(fileName, s.code);
        owned.set(s.id, { file: fileName, hash: contentHash(s.code) });
    }
    if (dry) return out;
    const live = new Set((await listScripts()).map((s) => s.id));
    for (const id of [...owned.keys()]) if (!live.has(id)) owned.delete(id);
    dlogLevel("sync", "info", `Folder sync: reconciled — ${out.imported.length} file(s) imported, ${out.written.length} file(s) written from scripts, ${out.conflicts.length} conflict(s)`);
    if (out.imported.length || out.conflicts.some((c) => c.winner === "file")) broadcastToUi({ type: "scriptsChanged", source: "folder" } as any);
    return out;
}

/** What picking the saved folder would do (the manager confirms conflicts first). */
export async function previewStoredHandle(): Promise<FolderPreview | null> {
    const handle = await loadSavedHandle("pendingFolder");
    if (!handle) return null;
    // a newly picked folder has no merge base
    return serial(() => initialSync({ dry: true, handle, base: new Map() }));
}

// ---- settings.yaml: canonical text generated from storage ----

let settingsSig: FileSig | null = null;
let settingsBroken = false;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

async function readSettingsFile(): Promise<{ text: string; sig: FileSig } | null> {
    try {
        const f = await (await dirHandle.getFileHandle(SETTINGS_FILE)).getFile();
        return { text: await f.text(), sig: { lastModified: f.lastModified, size: f.size } };
    } catch {
        return null;
    }
}

/**
 * storage → file; patched in place, so an up-to-date file is never
 * rewritten. `base`: text saved in the manager, which wins over the file.
 * A file on disk that doesn't parse is never overwritten by a background
 * change: it holds edits in progress (fixing it re-enables the export).
 */
async function exportSettings(base?: string): Promise<void> {
    if (!dirHandle) return;
    try {
        const existing = await readSettingsFile();
        if (base === undefined && existing && !settingsTextParses(existing.text)) {
            if (!settingsBroken) dlogLevel("sync", "warn", `Folder sync: ${SETTINGS_FILE} on disk has a YAML error — it is not overwritten until it is fixed (changes made meanwhile are written then)`);
            settingsBroken = true;
            return;
        }
        settingsBroken = false;
        const text = await getSettingsText(base ?? existing?.text);
        if (existing?.text !== text) {
            await writeFile(SETTINGS_FILE, text);
            settingsSig = (await readSettingsFile())?.sig ?? null;
        }
        // the file and the manager's settings.yaml are one document
        await rememberSettingsText(text);
        await ensureSchemaFile();
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: writing ${SETTINGS_FILE} failed: ${e?.message || e}`);
    }
}

/** the JSON schema the settings.yaml modeline points at (VS Code YAML extension) */
async function ensureSchemaFile(): Promise<void> {
    if (!dirHandle) return;
    const json = settingsSchemaJson((await currentSettingsState()).scripts);
    try {
        const f = await (await dirHandle.getFileHandle(SCHEMA_FILE)).getFile();
        if ((await f.text()) === json) return;
    } catch {
        // missing → write below
    }
    await writeFile(SCHEMA_FILE, json);
}

/** settings.yaml was saved in the manager: write that text out as-is */
export function exportSettingsFrom(text: string): Promise<void> {
    return serial(() => exportSettings(text));
}

function scheduleReconcile(): void {
    if (!dirHandle) return;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void serial(async () => {
            await reconcileToDisk();
            await exportSettings();
        });
    }, 300);
}

/** Test seam: run pending storage → disk work and one poll now. */
export async function flush(): Promise<void> {
    if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
        await serial(async () => {
            await reconcileToDisk();
            await exportSettings();
        });
    }
    await pollOnce();
}

/** file → storage, when settings.yaml changed on disk; then re-canonicalize */
async function pollSettings(): Promise<void> {
    const f = await readSettingsFile();
    if (!f) return;
    if (settingsSig && settingsSig.lastModified === f.sig.lastModified && settingsSig.size === f.sig.size) return;
    settingsSig = f.sig;
    const { error } = await applySettingsText(f.text);
    if (error) {
        dlogLevel("sync", "warn", `Folder sync: ${SETTINGS_FILE} has an error and was not applied: ${error}`);
        return;
    }
    dlogLevel("sync", "info", `Folder sync: ${SETTINGS_FILE} changed on disk — reloaded the whole file`);
    await exportSettings();
}

let pollQueued = false;
let lastPollError = "";

/** one poll (skipped when one is already waiting in the queue) */
function pollOnce(): Promise<void> {
    if (!dirHandle || pollQueued) return Promise.resolve();
    pollQueued = true;
    return serial(async () => {
        pollQueued = false;
        await pollNow();
    });
}

async function pollNow(): Promise<void> {
    if (!dirHandle) return;
    try {
        await pollSettings();
        const { seen, aliases } = await scanFolder();
        const events = computeEvents(known, seen);
        known = seen;
        realNameOf = aliases;
        await applyEvents(events);
        if (events.changed.length || events.added.length || events.removed.length) await persistState();
        lastPollError = "";
    } catch (e: any) {
        if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
            pause(`Folder sync paused: lost access to "${displayPath}" — open the manager and click the folder button to re-grant`);
        } else {
            const msg = String(e?.message || e);
            // the same failure repeats every second; report it once
            if (msg !== lastPollError) dlogLevel("sync", "warn", `Folder sync: scanning "${displayPath}" failed: ${msg}`);
            lastPollError = msg;
        }
    }
}

/** stop watching but keep the saved handle so the manager can re-grant */
function pause(reason: string): void {
    if (timer) clearInterval(timer);
    timer = null;
    dirHandle = null;
    stopKeepAlive();
    const alarms = alarmsApi();
    if (__MV3__ && alarms) alarms.clear(SYNC_ALARM);
    broadcastStatus();
    dlogLevel("sync", "warn", reason);
}

function startPolling(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void pollOnce(), POLL_MS);
}

// ---- MV3 SW liveness ----
// The MV3 service worker idles out after ~30s, which would kill the poller.
// Any extension API call resets that idle timer, so a 25s keep-alive ping
// holds the SW open while folder sync is active; a 30s alarm is the fallback
// that wakes the SW for a catch-up poll if it is reaped anyway.
const SYNC_ALARM = "folderSyncPoll";
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function alarmsApi(): typeof chrome.alarms | null {
    return typeof chrome !== "undefined" && (chrome as any).alarms ? chrome.alarms : null;
}

function startKeepAlive(): void {
    if (!__MV3__ || keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    }, 25_000);
}

function stopKeepAlive(): void {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

if (__MV3__) {
    // registered at module scope so the alarm wakes/dispatches even into a
    // freshly started SW (vitest defines __MV3__ as false and skips this)
    const alarms = alarmsApi();
    if (alarms) {
        alarms.onAlarm.addListener((a) => {
            if (a.name === SYNC_ALARM && dirHandle) void pollOnce();
        });
    }
}

async function ensureSyncAlarm(): Promise<void> {
    const alarms = alarmsApi();
    if (!__MV3__ || !alarms) return;
    alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
}

/**
 * Start watching the handle stored in IDB.
 * fresh: the user just picked this folder — two-way initial sync. Otherwise
 * this is a resume (worker restart, permission re-grant): diff against the
 * persisted snapshot so changes made while not watching are applied.
 */
export function startFromStoredHandle(opts: { fresh?: boolean } = {}): Promise<boolean> {
    return serial(() => start(opts));
}

async function start(opts: { fresh?: boolean }): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    const resumingSame = !opts.fresh && dirHandle !== null && timer !== null;
    dirHandle = handle;
    displayPath = await describeHandle(handle);
    lastPollError = "";
    clashWarned = new Set();
    if (opts.fresh) {
        owned = new Map(); // a different folder: no merge base
        await initialSync();
        await refreshKnown();
    } else if (!resumingSame) {
        const persisted = await loadPersistedState();
        if (persisted) {
            known = persisted.files;
            owned = persisted.owned;
            await pollNow(); // catch up on changes made while not watching
        }
        // reconcile what the snapshot can't see: files whose script is gone
        // (or never existed in this profile) and scripts with no file
        await initialSync();
        await refreshKnown();
    }
    startPolling();
    startKeepAlive();
    void ensureSyncAlarm();
    if (!settingsHooked) {
        settingsHooked = true;
        onScriptsChanged(scheduleReconcile);
        onScriptRenamed((oldName, newName) => {
            if (dirHandle) void serial(() => renameSettingsOnDisk(oldName, newName));
        });
        chrome.storage.onChanged.addListener((c) => {
            if (c.resLogLevel || c.resLogCap || c.resStrategy) scheduleReconcile();
        });
    }
    settingsSig = null;
    settingsBroken = false;
    if (await readSettingsFile()) await pollSettings();
    else await exportSettings();
    broadcastStatus();
    dlogLevel("sync", "info", `Folder sync: watching "${displayPath}"`);
    return true;
}

/** Stop timers only, keeping persisted state — as when the worker dies (test seam). */
export function halt(): void {
    if (timer) clearInterval(timer);
    timer = null;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    stopKeepAlive();
}

export function stop(): Promise<void> {
    return serial(stopNow);
}

async function stopNow(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    dirHandle = null;
    displayPath = "";
    settingsSig = null;
    known = new Map();
    owned = new Map();
    await clearPersistedState();
    stopKeepAlive();
    const alarms = alarmsApi();
    if (__MV3__ && alarms) alarms.clear(SYNC_ALARM);
    await clearSavedHandle();
    broadcastStatus();
}

export function getStatus(): { active: boolean; path: string } {
    return { active: !!dirHandle, path: displayPath };
}

/** On background start: reconnect silently if the grant is still valid. */
export async function initFromStorage(): Promise<void> {
    const handle = await loadSavedHandle();
    if (!handle) return;
    try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") {
            dlogLevel("sync", "warn", `Folder sync paused: the browser needs permission for "${handle.name}" again — open the manager and click the folder button to re-grant`);
            broadcastStatus();
            return;
        }
        await startFromStoredHandle();
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync could not resume: ${e?.message || e}`);
    }
}

/** Test/e2e seam: adopt an arbitrary directory handle (e.g. OPFS). */
export async function adoptHandle(handle: any): Promise<void> {
    await saveHandle(handle);
    await startFromStoredHandle({ fresh: true });
}
