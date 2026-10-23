/**
 * Folders group scripts and data files (paths with `/`). A folder exists
 * explicitly (created empty, stored in resFolders / found on disk) or
 * implicitly (something is inside it).
 */
import { folderOf } from "./scriptImports";

/** "a/b/c" → ["a", "a/b"] */
export function ancestorFolders(path: string): string[] {
    const out: string[] = [];
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
    return out;
}

/** is `path` inside `folder` (at any depth)? */
export function isInFolder(path: string, folder: string): boolean {
    return path.toLowerCase().startsWith(folder.toLowerCase() + "/");
}

/** `path` with its `from` folder prefix replaced by `to` (a folder rename/move) */
export function movedPath(path: string, from: string, to: string): string {
    return isInFolder(path, from) ? to + path.slice(from.length) : path;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** every folder: the explicit ones and those implied by the paths in them, sorted */
export function allFolders(explicit: string[], paths: string[]): string[] {
    const out = new Set<string>();
    for (const f of explicit) {
        out.add(f);
        for (const a of ancestorFolders(f)) out.add(a);
    }
    for (const p of paths) for (const a of ancestorFolders(p)) out.add(a);
    return [...out].sort(byName);
}

/**
 * Explorer order, which is also the stacking order: depth-first, inside
 * each folder its subfolders first (alphabetical, case-insensitive), then
 * its scripts in their stored order. Scripts all at the root keep their
 * stored order.
 */
export function stackingOrder<T>(scripts: T[], nameOf: (s: T) => string, folders: string[] = []): T[] {
    if (!folders.length && !scripts.some((s) => nameOf(s).includes("/"))) return scripts;
    const all = allFolders(folders, scripts.map(nameOf));
    const subfolders = new Map<string, string[]>();
    for (const f of all) {
        const parent = folderOf(f);
        subfolders.set(parent, [...(subfolders.get(parent) || []), f]);
    }
    const inFolder = new Map<string, T[]>();
    for (const s of scripts) {
        const f = folderOf(nameOf(s));
        inFolder.set(f, [...(inFolder.get(f) || []), s]);
    }
    const out: T[] = [];
    const walk = (folder: string) => {
        for (const sub of subfolders.get(folder) || []) walk(sub);
        out.push(...(inFolder.get(folder) || []));
    };
    walk("");
    return out;
}
