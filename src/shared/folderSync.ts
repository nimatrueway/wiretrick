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
}

/** Cheap content fingerprint (FNV-1a + length) — identifies a file's text across renames. */
export function contentHash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ":" + text.length;
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
    return { changed, added, removed };
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

export async function saveHandle(handle: any, key = "scriptFolder"): Promise<void> {
    const db = await handleDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").put(handle, key);
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadSavedHandle(key = "scriptFolder"): Promise<any | null> {
    try {
        const db = await handleDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction("handles", "readonly");
            const req = tx.objectStore("handles").get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return null;
    }
}

export async function clearSavedHandle(key = "scriptFolder"): Promise<void> {
    try {
        const db = await handleDb();
        await new Promise((resolve) => {
            const tx = db.transaction("handles", "readwrite");
            tx.objectStore("handles").delete(key);
            tx.oncomplete = () => resolve(null);
            tx.onerror = () => resolve(null);
        });
    } catch {}
}
