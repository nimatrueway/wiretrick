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
        dlogLevel("sync", "info", "legacy file migrated", { from: real, to: fileName });
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
    const { changed, added, removed, rename } = events;

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
        dlogLevel("sync", "info", "external change applied", { file: fileName, script: target.meta.name });
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
            // canonical appeared for a known script (e.g. manager wrote the
            // new .script.ts name) — content already matches; just migrate
            await migrateLegacy(fileName, code);
            continue;
        }
        await saveScript({ id: newId(), code, name: displayNameFromFile(fileName) });
        await migrateLegacy(fileName, code);
        dlogLevel("sync", "info", "external file added → script created", { file: fileName });
        broadcastToUi({ type: "scriptsChanged", source: "folder", file: fileName } as any);
    }

    for (const fileName of removed) {
        if (rename) continue;
        if (lastWritten.delete(fileName)) continue; // echo of a manager delete
        const target = await findScriptByFile(fileName);
        if (!target) continue;
        await deleteScript(target.id);
        dlogLevel("sync", "info", "external delete → script removed", { file: fileName });
        broadcastToUi({ type: "scriptsChanged", source: "folder", file: fileName } as any);
    }

    if (rename) {
        const text = await readText(rename.newName);
        if (lastWritten.get(rename.newName) === text) {
            lastWritten.delete(rename.newName);
        } else {
            const target = await findScriptByFile(rename.oldName);
            if (target) {
                await saveScript({ id: target.id, code: text, name: displayNameFromFile(rename.newName) });
                dlogLevel("sync", "info", "external rename applied", { from: rename.oldName, to: rename.newName });
                broadcastToUi({ type: "scriptsChanged", source: "folder", file: rename.newName } as any);
            }
        }
    }
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
        dlogLevel("sync", "warn", "settings export failed", { error: e.message || e });
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
        dlogLevel("sync", "warn", "settings.yaml parse error — ignored", { error });
        return;
    }
    dlogLevel("sync", "info", "settings.yaml applied");
    await exportSettings();
}

async function pollOnce(): Promise<void> {
    if (!dirHandle) return;
    try {
        await pollSettings();
        const { seen, aliases } = await scanFolder();
        const events = computeEvents(known, seen);
        known = seen;
        realNameOf = aliases;
        await applyEvents(events);
    } catch (e: any) {
        dlogLevel("sync", "warn", "poll failed", { error: e.message || e });
    }
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

/** Manager picked a folder (handle already stored to IDB by the manager). */
export async function startFromStoredHandle(): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    dirHandle = handle;
    displayPath = await describeHandle(handle);
    await refreshKnown();
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
    dlogLevel("sync", "info", "watching scripts folder", { path: displayPath });
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
        dlogLevel("sync", "warn", "writeBack failed", { file: fileName, error: e.message || e });
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

export async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    dirHandle = null;
    displayPath = "";
    settingsSig = null;
    lastWritten.clear();
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
            dlogLevel("sync", "info", "saved folder needs re-grant (browser restart)");
            return;
        }
        await startFromStoredHandle();
    } catch (e: any) {
        dlogLevel("sync", "warn", "init failed", { error: e.message || e });
    }
}

/** Test/e2e seam: adopt an arbitrary directory handle (e.g. OPFS). */
export async function adoptHandle(handle: any): Promise<void> {
    await saveHandle(handle);
    await startFromStoredHandle();
}
