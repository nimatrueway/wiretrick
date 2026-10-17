/**
 * Manager-page side of the scripts-folder sync.
 *
 * The actual WATCHING lives in the persistent background page
 * (src/background/folderSync.ts) — page timers in a hidden manager tab
 * are throttled by Chrome, the background page's are not, so external
 * file changes apply immediately regardless of focus.
 *
 * This module handles what needs a visible page: the directory picker
 * (user gesture), the permission re-grant, and the status plumbing.
 */

import { loadSavedHandle, clearSavedHandle, saveHandle } from "../shared/folderSync";

const RES_API_DTS_URL = "lib/res-api.d.ts";

export interface FolderSyncHandlers {
    onFileChanged(fileName: string, js: string): void;
    onFileAdded(fileName: string, js: string): void;
    onFileRemoved(fileName: string): void;
    onRenamed(oldName: string, newName: string, js: string): void;
}

export function isSupported(): boolean {
    return typeof (window as any).showDirectoryPicker === "function";
}

let cachedActive = false;

export function isSyncing(): boolean {
    return cachedActive === true;
}

export function setCachedActive(v: boolean): void {
    cachedActive = v;
}

export async function queryStatus(): Promise<{ active: boolean; path: string }> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "folderSyncStatus" }, (r: any) => resolve(r || { active: false, path: "" }));
    });
}

export function sendRaw(msg: any): Promise<any> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (r: any) => {
            void chrome.runtime.lastError;
            resolve(r);
        });
    });
}

/**
 * Pick a folder (user gesture required) and hand it to the background
 * watcher. Existing scripts are written out as .ts files + typings.
 */
/** Test/e2e seam: watch an arbitrary handle (e.g. OPFS) — manager-side. */
export async function adoptForWatch(handle: any): Promise<boolean> {
    await saveHandle(handle);
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "folderSyncAdopt" }, (r: any) => resolve(!!(r && r.ok)));
    });
}

export async function openFolder(
    getScripts: () => Promise<{ id: string; name: string; code: string }[]>,
    handlers?: FolderSyncHandlers
): Promise<void> {
    void handlers;
    const dirHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" } as any);
    await saveHandle(dirHandle);
    const started = await sendRaw({ type: "folderSyncStart" });
    if (!started || !started.ok) {
        await clearSavedHandle();
        throw new Error("folder sync could not start in the background (see the extension logs)");
    }

    // write the current scripts + typings into the folder
    const scripts = await getScripts();
    const apiDts = await fetch(chrome.runtime.getURL(RES_API_DTS_URL)).then((r) => r.text());
    await writeHandleText(dirHandle, "res-api.d.ts", apiDts);
    await writeHandleText(
        dirHandle,
        "tsconfig.json",
        JSON.stringify(
            {
                compilerOptions: {
                    target: "es2020",
                    lib: ["es2020", "dom"],
                    module: "esnext",
                    moduleResolution: "bundler",
                    allowImportingTsExtensions: true,
                    allowNonTsExtensions: true,
                    noEmit: true,
                },
                include: ["**/*.ts"],
            },
            null,
            2
        )
    );
    for (const s of scripts) {
        await writeHandleText(dirHandle, fileNameFor(s.id, s.name), s.code);
        await sendRaw({ type: "folderWriteBack", fileName: fileNameFor(s.id, s.name), content: s.code });
    }
}

async function writeHandleText(dirHandle: any, name: string, content: string): Promise<void> {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
}

export function stopSync(): Promise<void> {
    return sendRaw({ type: "folderSyncStop" }).then(() => {
        void clearSavedHandle();
    });
}

/** Injective file name: sanitized display name + .ts */
export function fileNameFor(_id: string, name: string): string {
    return safeName(name) + ".ts";
}

/** Does this script's display name correspond to this file? */
export function matchesFile(scriptName: string, fileName: string): boolean {
    return fileNameFor("", scriptName) === fileName;
}

function safeName(name: string): string {
    return (name || "script").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "script";
}

/**
 * Try to reconnect the saved dedicated folder silently (background).
 * Returns "synced" | "prompt" (needs a permission click) | "none".
 */
export async function autoReconnect(): Promise<"synced" | "prompt" | "none"> {
    const handle = await loadSavedHandle();
    if (!handle) return "none";
    try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") return "prompt";
        const r = await sendRaw({ type: "folderSyncStart" });
        return !!(r && r.ok) ? "synced" : "none";
    } catch {
        return "prompt";
    }
}

/** User-gesture path: re-grant permission, then hand to the background. */
export async function reconnectClicked(): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    try {
        if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
        const r = await sendRaw({ type: "folderSyncStart" });
        return !!(r && r.ok);
    } catch {
        return false;
    }
}
