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
let pollTimer: number | null = null;

/** contents we wrote ourselves, so the poller can ignore its own echo */
const lastWritten = new Map<string, string>();

export function isSupported(): boolean {
    return typeof (window as any).showDirectoryPicker === "function";
}

export function isSyncing(): boolean {
    return state !== null;
}

export async function openFolder(getScripts: () => Promise<{ id: string; name: string; code: string }[]>): Promise<void> {
    const dirHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
    state = { dirHandle, known: new Map() };

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
    startPolling();
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

async function pollOnce(): Promise<void> {
    if (!state) return;
    const dir = state.dirHandle;
    const seen = new Map<string, { lastModified: number; size: number }>();
    const changed: string[] = [];

    for await (const entry of dir.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".ts")) continue;
        const file = await entry.getFile();
        const sig = { lastModified: file.lastModified, size: file.size };
        seen.set(entry.name, sig);
        const prev = state.known.get(entry.name);
        if (!prev || prev.lastModified !== sig.lastModified || prev.size !== sig.size) {
            changed.push(entry.name);
        }
    }
    state.known = seen;

    for (const fileName of changed) {
        const entry = await dir.getFileHandle(fileName);
        const file = await entry.getFile();
        const text = await file.text();
        // our own write-back: same content we pushed, nothing to import
        if (lastWritten.get(fileName) === text) {
            lastWritten.delete(fileName);
            continue;
        }
        const js = transpile(text);
        (window as any).__resFbOnFileChanged?.(fileName, js);
    }
}

/** Minimal TS transpile in-page using the UMD typescript build. */
function transpile(source: string): string {
    const ts = (window as any).ts;
    if (!ts) return source;
    const out = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.None,
        },
    });
    return out.outputText;
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
