/** What a drop onto the install dialog, the install page or the Explorer brings: a link, a .zip, or files (a folder's). */
import { useState, type DragEvent } from "react";
import { isPackageFile } from "../../shared/packageSource";

export type Dropped = { url: string } | { zip: File } | { label: string; files: Record<string, string> } | { error: string };

const NOTHING = "Drop a script (.ts), a metadata.json, a folder, a .zip, or a link to one.";

/** a drag that can install: files, or a link (rows dragged inside the Explorer carry only text/plain) */
export const isInstallDrag = (dt: DataTransfer | null): boolean => !!dt && Array.from(dt.types || []).some((t) => t === "Files" || t === "text/uri-list");

const fileOf = (e: FileSystemFileEntry): Promise<File> => new Promise((res, rej) => e.file(res, rej));

async function readDir(dir: FileSystemDirectoryEntry, prefix: string, out: Record<string, string>): Promise<void> {
    const reader = dir.createReader();
    for (;;) {
        // readEntries hands out a directory's entries in batches until it returns none
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) return;
        for (const e of batch) await readEntry(e, prefix, out);
    }
}

async function readEntry(e: FileSystemEntry, prefix: string, out: Record<string, string>): Promise<void> {
    const rel = prefix + e.name;
    if (e.isDirectory) {
        if (e.name !== "node_modules" && e.name !== ".git") await readDir(e as FileSystemDirectoryEntry, rel + "/", out);
    } else if (e.isFile && isPackageFile(rel)) out[rel] = await (await fileOf(e as FileSystemFileEntry)).text();
}

/** the first link a drag carries */
function linkOf(dt: DataTransfer): string {
    const list = (dt.getData("text/uri-list") || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (list) return list;
    const text = (dt.getData("text/plain") || "").trim();
    return /^(https?|file):\/\/\S+$/i.test(text) ? text : "";
}

/**
 * Reads a drop. Call it inside the drop event: a DataTransfer's items are only
 * readable then (the reading started here may finish later).
 */
export function readDrop(dt: DataTransfer): Promise<Dropped> {
    const items = Array.from(dt.items || []).filter((i) => i.kind === "file");
    const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
    const files = Array.from(dt.files || []);
    if (!files.length && !items.length) {
        const url = linkOf(dt);
        return Promise.resolve(url ? { url } : { error: NOTHING });
    }
    const one = entries.length === 1 ? entries[0] : null;
    if (files.length === 1 && !one?.isDirectory && /\.zip$/i.test(files[0].name)) return Promise.resolve({ zip: files[0] });
    return (async (): Promise<Dropped> => {
        const out: Record<string, string> = {};
        if (one?.isDirectory) {
            await readDir(one as FileSystemDirectoryEntry, "", out);
            return { label: `The folder "${one.name}"`, files: out };
        }
        if (entries.length && entries.every(Boolean)) for (const e of entries) await readEntry(e!, "", out);
        else for (const f of files) if (isPackageFile(f.name)) out[f.name] = await f.text();
        return { label: files.length === 1 ? files[0].name : "The dropped files", files: out };
    })().catch((e) => ({ error: String(e?.message || e) }));
}

/** Drop handlers for a drop target that installs; `over` while an installable drag is over it. */
export function useInstallDrop(onDrop: (d: Promise<Dropped>) => void, enabled = true) {
    const [over, setOver] = useState(false);
    const handlers = {
        onDragOver(e: DragEvent) {
            if (!enabled || !isInstallDrag(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!over) setOver(true);
        },
        onDragLeave(e: DragEvent) {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
        },
        onDrop(e: DragEvent) {
            setOver(false);
            if (!enabled || !isInstallDrag(e.dataTransfer)) return;
            e.preventDefault();
            onDrop(readDrop(e.dataTransfer));
        },
    };
    return { over, handlers };
}
