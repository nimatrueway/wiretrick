/**
 * Background-side scripts-folder watcher. Owns the directory handle and
 * the polling loop — the persistent background page never gets timer-
 * throttled, so external file changes apply immediately no matter which
 * tab is focused (or whether the manager is open).
 */
import { computeEvents, loadSavedHandle, clearSavedHandle, saveHandle, type FileSig } from "../shared/folderSync";
import { saveScript, deleteScript, newId, listScripts, onScriptsChanged } from "./engine/scriptStore";
import { getSettingsText, applySettingsText } from "./settingsFile";
import { SETTINGS_FILE, SCHEMA_FILE } from "../shared/settingsYaml";
import { SETTINGS_SCHEMA_JSON } from "../shared/settingsSchema";
import { broadcastToUi } from "./engine/logs";
import { dlogLevel } from "../shared/debugLog";
const POLL_MS = 1000;
const SCRIPT_EXT = ".ts";

/** canonical script file name for a display name */
function canonicalFileName(name: string): string {
    return safeName(name) + SCRIPT_EXT;
}

/** legacy <name>.script.ts → canonical <name>.ts */
function canonicalizeFileName(fileName: string): string {
    return fileName.endsWith(".script.ts") ? fileName.replace(/\.script\.ts$/, SCRIPT_EXT) : fileName;
}

let dirHandle: any = null;
let known = new Map<string, FileSig>();
/** canonical name → actual on-disk name when a legacy file stands in for it */
let realNameOf = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let displayPath = "";
let settingsHooked = false;
/** contents we wrote ourselves — the poller skips its own echo */
const lastWritten = new Map<string, string>();

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
    await persistKnown();
}

// ---- persisted folder snapshot ----
// The MV3 service worker can be stopped at any time (idle reaping, browser
// sleep, extension update). Without a persisted snapshot a restarted worker
// would rebuild `known` from the CURRENT folder and silently absorb every
// file added/changed/removed while it was down. Persisting it lets the
// first poll after a restart diff against what was last applied.
const KNOWN_KEY = "folderSyncKnown";

function storageLocal(): chrome.storage.LocalStorageArea | null {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

async function persistKnown(): Promise<void> {
    const area = storageLocal();
    if (!area) return;
    await new Promise<void>((r) => area.set({ [KNOWN_KEY]: Object.fromEntries(known) }, () => r()));
}

async function loadPersistedKnown(): Promise<Map<string, FileSig> | null> {
    const area = storageLocal();
    if (!area) return null;
    const obj: any = await new Promise((r) => area.get(KNOWN_KEY, r));
    const files = obj?.[KNOWN_KEY];
    return files && typeof files === "object" ? new Map(Object.entries(files) as [string, FileSig][]) : null;
}

async function clearPersistedKnown(): Promise<void> {
    const area = storageLocal();
    if (!area?.remove) return;
    await new Promise<void>((r) => area.remove(KNOWN_KEY, () => r()));
}

/**
 * List script files as canonical names. Every .ts file is a script file;
 * .d.ts files are ignored. Legacy .script.ts files stand in for their
 * canonical .ts name (canonical wins when both exist) and migrate back.
 */
async function scanFolder(): Promise<{ seen: Map<string, FileSig>; aliases: Map<string, string> }> {
    const seen = new Map<string, FileSig>();
    const aliases = new Map<string, string>();
    const legacy: { name: string; sig: FileSig }[] = [];
    for await (const entry of dirHandle.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
        const f = await entry.getFile();
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

/** Legacy <name>.script.ts standing in for <name>.ts → write canonical, drop legacy. */
async function migrateLegacy(fileName: string, content: string): Promise<void> {
    const real = realNameOf.get(fileName);
    if (!real) return;
    await writeBack(fileName, content);
    try {
        await dirHandle.removeEntry(real);
        dlogLevel("sync", "info", `Folder sync: migrated legacy "${real}" → "${fileName}"`);
    } catch {}
    realNameOf.delete(fileName);
}

/** Script-id lookup: filename → enabled script (fileNameFor is name-based). */
async function findScriptByFile(fileName: string) {
    const nameNoExt = fileName.replace(/\.ts$/, "");
    const scripts = await listScripts();
    return scripts.find((s) => sanitize(s.meta.name) === nameNoExt) || null;
}

function safeName(name: string): string {
    return (name || "script").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "script";
}

function sanitize(displayName: string): string {
    return safeName(displayName);
}

function displayNameFromFile(fileName: string): string {
    return fileName.replace(/\.ts$/, "").replace(/_/g, " ").slice(0, 60) || "Imported script";
}

async function applyEvents(events: ReturnType<typeof computeEvents>): Promise<void> {
    const { changed, added, removed } = events;
    let rename = events.rename;
    // the add+remove pair is only a rename when the vanished file belonged
    // to a script; otherwise it's an unrelated delete plus a new file
    if (rename && !(await findScriptByFile(rename.oldName))) rename = null;

    for (const fileName of changed) {
        if (rename && fileName === rename.oldName) continue;
        const text = await readText(fileName);
        if (lastWritten.get(fileName) === text) {
            lastWritten.delete(fileName); // our own write-back echo
            continue;
        }
        const target = await findScriptByFile(fileName);
        if (!target) continue;
        await saveScript({ id: target.id, code: text, name: target.meta.name });
        await migrateLegacy(fileName, text);
        dlogLevel("sync", "info", `Folder sync: "${fileName}" changed on disk — script "${target.meta.name}" updated`);
        broadcastToUi({ type: "scriptsChanged", source: "folder", file: fileName } as any);
    }

    for (const fileName of added) {
        if (rename) continue;
        const text = await readText(fileName);
        if (lastWritten.get(fileName) === text) {
            lastWritten.delete(fileName); // echo of a manager-created script
            continue;
        }
        const existing = await findScriptByFile(fileName);
        const code = text;
        if (existing) {
            // a file for an existing script appeared (manager wrote the
            // canonical name, or the user copied a file over it) — apply
            // its content if it differs, then migrate any legacy alias
            if (existing.code !== code) {
                await saveScript({ id: existing.id, code, name: existing.meta.name });
                dlogLevel("sync", "info", `Folder sync: "${fileName}" replaced script "${existing.meta.name}"`);
                broadcastToUi({ type: "scriptsChanged", source: "folder", file: fileName } as any);
            }
            await migrateLegacy(fileName, code);
            continue;
        }
        const name = displayNameFromFile(fileName);
        await saveScript({ id: newId(), code, name });
        await migrateLegacy(fileName, code);
        await adoptCanonicalName(fileName, name, code);
        dlogLevel("sync", "info", `Folder sync: new file "${fileName}" imported as script "${name}"`);
        broadcastToUi({ type: "scriptsChanged", source: "folder", file: fileName } as any);
    }

    for (const fileName of removed) {
        if (rename) continue;
        if (lastWritten.delete(fileName)) continue; // echo of a manager delete
        const target = await findScriptByFile(fileName);
        if (!target) continue;
        await deleteScript(target.id);
        dlogLevel("sync", "info", `Folder sync: "${fileName}" deleted on disk — script "${target.meta.name}" removed`);
        broadcastToUi({ type: "scriptsChanged", source: "folder", file: fileName } as any);
    }

    if (rename) {
        const text = await readText(rename.newName);
        if (lastWritten.get(rename.newName) === text) {
            lastWritten.delete(rename.newName);
        } else {
            const target = await findScriptByFile(rename.oldName);
            if (target) {
                const name = displayNameFromFile(rename.newName);
                await saveScript({ id: target.id, code: text, name });
                await adoptCanonicalName(rename.newName, name, text);
                dlogLevel("sync", "info", `Folder sync: "${rename.oldName}" renamed to "${rename.newName}" — script renamed to "${name}"`);
                broadcastToUi({ type: "scriptsChanged", source: "folder", file: rename.newName } as any);
            }
        }
    }
}

/**
 * A file whose name doesn't round-trip through the script name (e.g.
 * "my script (copy).ts" → script "my script (copy)" → "my_script_copy_.ts")
 * would never match its script again, so later edits/deletes of it would be
 * ignored. Rename it on disk to the canonical name the manager also uses.
 */
async function adoptCanonicalName(fileName: string, scriptName: string, code: string): Promise<void> {
    const canonical = canonicalFileName(scriptName);
    if (canonical === fileName || realNameOf.has(fileName)) return;
    await writeBack(canonical, code);
    try {
        await dirHandle.removeEntry(fileName);
    } catch {}
    try {
        const f = await (await dirHandle.getFileHandle(canonical)).getFile();
        known.delete(fileName);
        known.set(canonical, { lastModified: f.lastModified, size: f.size });
        lastWritten.delete(canonical);
    } catch {}
    dlogLevel("sync", "info", `Folder sync: renamed "${fileName}" → "${canonical}" to match its script name`);
}

/**
 * Two-way sync when a folder is picked or (re)connected: files with no script are
 * imported, scripts with no file are written out, and when both exist but
 * differ the newer one wins (file mtime vs. the script's last save).
 */
async function initialSync(): Promise<void> {
    const { seen, aliases } = await scanFolder();
    realNameOf = aliases;
    const scripts = await listScripts();
    const byFile = new Map(scripts.map((s) => [canonicalFileName(s.meta.name), s]));
    let pulled = 0;
    let pushed = 0;
    let imported = 0;
    for (const [fileName, sig] of seen) {
        const text = await readText(fileName);
        const s = byFile.get(fileName);
        byFile.delete(fileName);
        if (!s) {
            const name = displayNameFromFile(fileName);
            await saveScript({ id: newId(), code: text, name });
            await migrateLegacy(fileName, text);
            await adoptCanonicalName(fileName, name, text);
            imported++;
        } else if (s.code !== text) {
            if (sig.lastModified > s.updatedAt) {
                await saveScript({ id: s.id, code: text, name: s.meta.name });
                await migrateLegacy(fileName, text);
                pulled++;
            } else {
                await writeBack(fileName, s.code);
                await migrateLegacy(fileName, s.code);
                pushed++;
            }
        } else {
            await migrateLegacy(fileName, text);
        }
    }
    for (const [fileName, s] of byFile) {
        await writeBack(fileName, s.code);
        pushed++;
    }
    lastWritten.clear(); // the snapshot below absorbs our own writes
    dlogLevel("sync", "info", `Folder sync: reconciled — ${imported} file(s) imported, ${pulled} script(s) updated from newer files, ${pushed} file(s) written from scripts`);
    if (imported || pulled) broadcastToUi({ type: "scriptsChanged", source: "folder" } as any);
}

// ---- settings.yaml: canonical text generated from storage ----

let settingsSig: FileSig | null = null;
let exportTimer: ReturnType<typeof setTimeout> | null = null;

async function readSettingsFile(): Promise<{ text: string; sig: FileSig } | null> {
    try {
        const f = await (await dirHandle.getFileHandle(SETTINGS_FILE)).getFile();
        return { text: await f.text(), sig: { lastModified: f.lastModified, size: f.size } };
    } catch {
        return null;
    }
}

/** storage → file; patched in place, so an up-to-date file is never rewritten */
async function exportSettings(): Promise<void> {
    if (!dirHandle) return;
    try {
        const existing = await readSettingsFile();
        const text = await getSettingsText(existing?.text);
        if (existing?.text !== text) {
            await writeBack(SETTINGS_FILE, text);
            settingsSig = (await readSettingsFile())?.sig ?? null;
            lastWritten.delete(SETTINGS_FILE);
        }
        await ensureSchemaFile();
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: writing ${SETTINGS_FILE} failed: ${e?.message || e}`);
    }
}

/** the JSON schema the settings.yaml modeline points at (VS Code YAML extension) */
async function ensureSchemaFile(): Promise<void> {
    if (!dirHandle) return;
    try {
        const f = await (await dirHandle.getFileHandle(SCHEMA_FILE)).getFile();
        if ((await f.text()) === SETTINGS_SCHEMA_JSON) return;
    } catch {
        // missing → write below
    }
    await writeBack(SCHEMA_FILE, SETTINGS_SCHEMA_JSON);
}

function scheduleExport(): void {
    if (!dirHandle) return;
    if (exportTimer) clearTimeout(exportTimer);
    exportTimer = setTimeout(() => void exportSettings(), 300);
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
    dlogLevel("sync", "info", `Folder sync: ${SETTINGS_FILE} changed on disk — settings applied`);
    await exportSettings();
}

let polling = false;
let lastPollError = "";

async function pollOnce(): Promise<void> {
    if (!dirHandle || polling) return;
    polling = true;
    try {
        await pollSettings();
        const { seen, aliases } = await scanFolder();
        const events = computeEvents(known, seen);
        known = seen;
        realNameOf = aliases;
        await applyEvents(events);
        if (events.changed.length || events.added.length || events.removed.length) await persistKnown();
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
    } finally {
        polling = false;
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
export async function startFromStoredHandle(opts: { fresh?: boolean } = {}): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    const resumingSame = !opts.fresh && dirHandle !== null && timer !== null;
    dirHandle = handle;
    displayPath = await describeHandle(handle);
    lastPollError = "";
    if (opts.fresh) {
        await initialSync();
        await refreshKnown();
    } else if (!resumingSame) {
        const persisted = await loadPersistedKnown();
        if (persisted) {
            known = persisted;
            await pollOnce(); // catch up on changes made while not watching
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
        onScriptsChanged(scheduleExport);
        chrome.storage.onChanged.addListener((c) => {
            if (c.resLogLevel || c.resLogCap) scheduleExport();
        });
    }
    settingsSig = null;
    void ((await readSettingsFile()) ? pollSettings() : exportSettings());
    broadcastStatus();
    dlogLevel("sync", "info", `Folder sync: watching "${displayPath}"`);
    return true;
}

/** Write a manager-side save out to the folder (two-way sync). */
export async function writeBack(fileName: string, content: string): Promise<void> {
    if (!dirHandle) return;
    lastWritten.set(fileName, content);
    try {
        const fh = await dirHandle.getFileHandle(fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
    } catch (e: any) {
        lastWritten.delete(fileName);
        dlogLevel("sync", "warn", `Folder sync: writing "${fileName}" failed: ${e?.message || e}`);
    }
}

/** Manager deleted a script → remove its file (canonical or legacy). */
export async function deleteFile(fileName: string): Promise<void> {
    if (!dirHandle) return;
    lastWritten.delete(fileName);
    try {
        await dirHandle.removeEntry(fileName);
    } catch {}
    const legacy = realNameOf.get(fileName) || fileName.replace(/\.ts$/, ".script.ts");
    if (legacy !== fileName) {
        try {
            await dirHandle.removeEntry(legacy);
        } catch {}
    }
}

/** Stop timers only, keeping persisted state — as when the worker dies (test seam). */
export function halt(): void {
    if (timer) clearInterval(timer);
    timer = null;
    stopKeepAlive();
}

export async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    dirHandle = null;
    displayPath = "";
    settingsSig = null;
    lastWritten.clear();
    known = new Map();
    await clearPersistedKnown();
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
