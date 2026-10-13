/**
 * Background-side scripts-folder watcher. Owns the directory handle and
 * the polling loop — the persistent background page never gets timer-
 * throttled, so external file changes apply immediately no matter which
 * tab is focused (or whether the manager is open).
 */
import { computeEvents, loadSavedHandle, clearSavedHandle, saveHandle, type FileSig } from "../shared/folderSync";
import { saveScript, deleteScript, newId, listScripts } from "./engine/scriptStore";
import { broadcastToUi } from "./engine/logs";
import { dlogLevel } from "../shared/debugLog";
function injectName(code: string, name: string): string {
    if (!name) return code;
    if (/^\s*\/\/\s*@name\s+.*$/m.test(code)) {
        return code.replace(/^(\s*\/\/\s*@name\s+).*$/m, `$1${name}`);
    }
    return `// @name ${name}\n${code}`;
}

const POLL_MS = 1000;

let dirHandle: any = null;
let known = new Map<string, FileSig>();
let timer: ReturnType<typeof setInterval> | null = null;
let displayPath = "";
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
    const seen = new Map<string, FileSig>();
    for await (const entry of dirHandle.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".ts")) continue;
        const f = await entry.getFile();
        seen.set(entry.name, { lastModified: f.lastModified, size: f.size });
    }
    known = seen;
}

async function readText(fileName: string): Promise<string> {
    const fh = await dirHandle.getFileHandle(fileName);
    return await (await fh.getFile()).text();
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
        await saveScript({ id: target.id, code: injectName(text, target.meta.name) });
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
        await saveScript({ id: newId(), code: injectName(text, displayNameFromFile(fileName)) });
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
                await saveScript({ id: target.id, code: injectName(text, displayNameFromFile(rename.newName)) });
                dlogLevel("sync", "info", "external rename applied", { from: rename.oldName, to: rename.newName });
                broadcastToUi({ type: "scriptsChanged", source: "folder", file: rename.newName } as any);
            }
        }
    }
}

async function pollOnce(): Promise<void> {
    if (!dirHandle) return;
    try {
        const seen = new Map<string, FileSig>();
        for await (const entry of dirHandle.values()) {
            if (entry.kind !== "file" || !entry.name.endsWith(".ts")) continue;
            const f = await entry.getFile();
            seen.set(entry.name, { lastModified: f.lastModified, size: f.size });
        }
        const events = computeEvents(known, seen);
        known = seen;
        await applyEvents(events);
    } catch (e: any) {
        dlogLevel("sync", "warn", "poll failed", { error: e.message || e });
    }
}

function startPolling(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void pollOnce(), POLL_MS);
}

/** Manager picked a folder (handle already stored to IDB by the manager). */
export async function startFromStoredHandle(): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    dirHandle = handle;
    displayPath = await describeHandle(handle);
    await refreshKnown();
    startPolling();
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

/** Manager deleted a script → remove its file. */
export async function deleteFile(fileName: string): Promise<void> {
    if (!dirHandle) return;
    lastWritten.delete(fileName);
    try {
        await dirHandle.removeEntry(fileName);
    } catch {}
}

export async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    dirHandle = null;
    displayPath = "";
    lastWritten.clear();
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
