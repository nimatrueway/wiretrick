/**
 * Shared pieces for the scripts-folder sync.
 *
 * The WATCHING happens in the persistent background page (page timers in a
 * hidden manager tab get throttled by Chrome down to once a minute — the
 * background page never throttles, so external file changes are picked up
 * immediately regardless of which tab is focused, or whether the manager
 * is open at all).
 *
 * The FileSystemAccess handle is stored in IndexedDB (key "scriptFolder"),
 * which both the manager page (picker + permission gestures) and the
 * background page (watching) can access — they share the extension origin.
 */

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

// ---- handle persistence (IndexedDB, shared across extension contexts) ----

export function handleDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("resoverride", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("handles");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function saveHandle(handle: any): Promise<void> {
    const db = await handleDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").put(handle, "scriptFolder");
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadSavedHandle(): Promise<any | null> {
    try {
        const db = await handleDb();
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
        const db = await handleDb();
        await new Promise((resolve) => {
            const tx = db.transaction("handles", "readwrite");
            tx.objectStore("handles").delete("scriptFolder");
            tx.oncomplete = () => resolve(null);
            tx.onerror = () => resolve(null);
        });
    } catch {}
}
