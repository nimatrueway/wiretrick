/**
 * The data file store (chrome.storage.local `resDataFiles`) as the
 * compilers see it: a snapshot of every data file's path and text, loaded
 * before the strategies (re)compile. Changes go through scriptStore (they
 * recompile the importers).
 */
import type { DataFileSource } from "../../shared/compile";

/** a JSON file scripts import (`import limits from "./mock/rate-limits.json"`); it never runs */
export interface DataFile {
    id: string;
    /** path with `.json`, `/`-separated (`mock/rate-limits.json`) */
    path: string;
    text: string;
    savedAt: number;
}

export const DATA_FILES_KEY = "resDataFiles";
/** explicit folder paths (empty ones included); folders with contents are implied */
export const FOLDERS_KEY = "resFolders";
/** largest data file (characters) */
export const MAX_DATA_FILE = 5 * 1024 * 1024;

let snapshot: DataFileSource[] = [];
let sig = "";
let loaded = false;

function hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
    return h.toString(36);
}

/** replace the snapshot with the stored data files */
export function setDataFilesSnapshot(byId: { [id: string]: DataFile }): void {
    snapshot = Object.values(byId)
        .map((d) => ({ path: d.path, text: d.text }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    sig = hash(JSON.stringify(snapshot.map((d) => [d.path, d.text.length, hash(d.text)])));
    loaded = true;
}

/** read the store into the snapshot */
export async function loadDataFiles(): Promise<DataFileSource[]> {
    const got = await new Promise<Record<string, any>>((resolve) =>
        chrome.storage.local.get([DATA_FILES_KEY], (d) => {
            void chrome.runtime.lastError;
            resolve(d || {});
        })
    );
    setDataFilesSnapshot(got[DATA_FILES_KEY] || {});
    return snapshot;
}

/** the snapshot, loading it first if this context never did */
export async function ensureDataFiles(): Promise<DataFileSource[]> {
    return loaded ? snapshot : loadDataFiles();
}

/** the data files as last loaded */
export function dataFilesSnapshot(): DataFileSource[] {
    return snapshot;
}

/** signature of the snapshot (MV3: does the sandbox have these data files?) */
export function dataFilesSig(): string {
    return sig;
}
