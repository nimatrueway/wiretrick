/**
 * VS Code bridge via the File System Access API.
 *
 * "Open in VS Code" writes every script as <name>.ts plus res-api.d.ts and
 * jsconfig.json into a user-picked folder. While the manager page is open we
 * poll the folder; changed files are transpiled (TypeScript UMD) and saved
 * back into script storage — hot reload into the engine on save.
 */

const RES_API_DTS_URL = "lib/res-api.d.ts";
const POLL_MS = 1000;

interface FolderSyncState {
    dirHandle: any;
    known: Map<string, { lastModified: number; size: number }>;
}

let state: FolderSyncState | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let syncHandlers: FolderSyncHandlers | null = null;

/** contents we wrote ourselves, so the poller can ignore its own echo */
const lastWritten = new Map<string, string>();

export function isSupported(): boolean {
    return typeof (window as any).showDirectoryPicker === "function";
}

// ---- persistent handle: the picked folder becomes the dedicated
// scripts folder, remembered across browser restarts ----
function idb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("resoverride", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("handles");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveHandle(handle: any): Promise<void> {
    const db = await idb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").put(handle, "scriptFolder");
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadSavedHandle(): Promise<any | null> {
    try {
        const db = await idb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction("handles", "readonly");
            const req = tx.objectStore("handles").get("scriptFolder");
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return null;
    }
}

export async function clearSavedHandle(): Promise<void> {
    try {
        const db = await idb();
        await new Promise((resolve) => {
            const tx = db.transaction("handles", "readwrite");
            tx.objectStore("handles").delete("scriptFolder");
            tx.oncomplete = () => resolve(null);
            tx.onerror = () => resolve(null);
        });
    } catch {}
}

export function isSyncing(): boolean {
    return state !== null;
}

/**
 * Try to reconnect the saved dedicated folder silently. Returns:
 *   "synced"   — reconnected and watching
 *   "prompt"   — handle exists but needs a permission click (call
 *                reconnectClicked())
 *   "none"     — no folder chosen yet
 */
export async function autoReconnect(handlers?: FolderSyncHandlers): Promise<"synced" | "prompt" | "none"> {
    if (state) return "synced";
    const handle = await loadSavedHandle();
    if (!handle) return "none";
    try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") return "prompt";
        syncHandlers = handlers || null;
        await connect(handle);
        return "synced";
    } catch {
        return "prompt";
    }
}

/** User-gesture path: finish the reconnect after Chrome's permission prompt. */
export async function reconnectClicked(handlers?: FolderSyncHandlers): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    try {
        if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
        syncHandlers = handlers || null;
        await connect(handle);
        return true;
    } catch {
        return false;
    }
}

export interface FolderSyncHandlers {
    /** content of an existing script's file changed in VS Code */
    onFileChanged(fileName: string, js: string): void;
    /** a new .ts file appeared → create a script */
    onFileAdded(fileName: string, js: string): void;
    /** a .ts file was deleted → remove its script */
    onFileRemoved(fileName: string): void;
    /** exactly one file disappeared while another appeared → rename/move */
    onRenamed(oldName: string, newName: string, js: string): void;
}

async function connect(dirHandle: any): Promise<void> {
    state = { dirHandle, known: new Map() };
    await saveHandle(dirHandle);
    await refreshKnown();
    startPolling();
}

export async function openFolder(
    getScripts: () => Promise<{ id: string; name: string; code: string }[]>,
    handlers?: FolderSyncHandlers
): Promise<void> {
    const dirHandle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
        startIn: "documents",
        suggestedName: undefined,
    } as any);
    syncHandlers = handlers || null;

    await connect(dirHandle);

    const scripts = await getScripts();
    const apiDts = await fetch(chrome.runtime.getURL(RES_API_DTS_URL)).then((r) => r.text());
    await writeText(dirHandle, "res-api.d.ts", apiDts);
    await writeText(
        dirHandle,
        "jsconfig.json",
        JSON.stringify(
            {
                compilerOptions: {
                    target: "es2020",
                    lib: ["es2020", "dom"],
                    allowNonTsExtensions: true,
                    noEmit: true,
                },
            },
            null,
            2
        )
    );
    for (const s of scripts) {
        await writeText(dirHandle, fileNameFor(s.id, s.name), s.code);
    }
    await refreshKnown();
}

/** File name for a script (script names are assumed unique). */
export function fileNameFor(_id: string, name: string): string {
    return safeName(name) + ".ts";
}

/** Does this script's display name correspond to this file? */
export function matchesFile(scriptName: string, fileName: string): boolean {
    return safeName(scriptName) + ".ts" === fileName;
}

export function stopSync(): void {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    state = null;
    lastWritten.clear();
    void clearSavedHandle();
}

function startPolling(): void {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        if (!state) return;
        try {
            await pollOnce();
        } catch (e: any) {
            console.error("[fsBridge] poll failed:", e.message || e);
        }
    }, POLL_MS);
}

export type FileSig = { lastModified: number; size: number };

export interface FolderEvents {
    changed: string[];
    added: string[];
    removed: string[];
    /** one file vanished while one appeared in the same poll → rename/move */
    rename: { oldName: string; newName: string } | null;
}

/** Pure diff between the previously seen file set and the current one. */
export function computeEvents(prev: Map<string, FileSig>, seen: Map<string, FileSig>): FolderEvents {
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [name, sig] of seen) {
        const p = prev.get(name);
        if (!p) added.push(name);
        else if (p.lastModified !== sig.lastModified || p.size !== sig.size) changed.push(name);
    }
    for (const name of prev.keys()) {
        if (!seen.has(name)) removed.push(name);
    }
    const rename = added.length === 1 && removed.length === 1 ? { oldName: removed[0], newName: added[0] } : null;
    return { changed, added, removed, rename };
}

async function pollOnce(): Promise<void> {
    if (!state) return;
    const dir = state.dirHandle;
    const seen = new Map<string, FileSig>();

    for await (const entry of dir.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".ts")) continue;
        const file = await entry.getFile();
        seen.set(entry.name, { lastModified: file.lastModified, size: file.size });
    }
    const events = computeEvents(state.known, seen);
    const { changed, added, removed, rename } = events;
    state.known = seen;

    const read = async (fileName: string): Promise<string> => {
        const entry = await dir.getFileHandle(fileName);
        return await (await entry.getFile()).text();
    };

    for (const fileName of changed) {
        if (rename && fileName === rename.oldName) continue;
        const text = await read(fileName);
        // our own write-back: same content we pushed, nothing to import
        if (lastWritten.get(fileName) === text) {
            lastWritten.delete(fileName);
            continue;
        }
        // raw source (TS included) — the engine transpiles at compile time;
        // transpiling here would overwrite the user's source and lose
        // blank lines + types
        syncHandlers?.onFileChanged(fileName, text);
    }

    for (const fileName of added) {
        if (rename) continue;
        const text = await read(fileName);
        // echo of our own write-back (script created from the manager)
        if (lastWritten.get(fileName) === text) {
            lastWritten.delete(fileName);
            continue;
        }
        syncHandlers?.onFileAdded(fileName, text);
    }

    for (const fileName of removed) {
        if (rename) continue;
        // echo of our own deleteFile
        if (lastWritten.delete(fileName)) continue;
        syncHandlers?.onFileRemoved(fileName);
    }

    if (rename) {
        const text = await read(rename.newName);
        if (lastWritten.get(rename.newName) === text) {
            lastWritten.delete(rename.newName);
        } else {
            syncHandlers?.onRenamed(rename.oldName, rename.newName, text);
        }
    }
}

/** Push extension-side changes into the folder (two-way sync). */
export async function writeBack(fileName: string, content: string): Promise<void> {
    if (!state) return;
    lastWritten.set(fileName, content);
    await writeText(state.dirHandle, fileName, content);
}

/** Remove the file for a script deleted in the manager. */
export async function deleteFile(fileName: string): Promise<void> {
    if (!state) return;
    lastWritten.delete(fileName);
    try {
        await state.dirHandle.removeEntry(fileName);
    } catch {
        /* file already gone */
    }
}

async function writeText(dirHandle: any, name: string, content: string): Promise<void> {
    const handle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
}

async function refreshKnown(): Promise<void> {
    if (!state) return;
    state.known = new Map();
    for await (const entry of state.dirHandle.values()) {
        if (entry.kind !== "file") continue;
        const file = await entry.getFile();
        state.known.set(entry.name, { lastModified: file.lastModified, size: file.size });
    }
}

function safeName(name: string): string {
    return (name || "script").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "script";
}
