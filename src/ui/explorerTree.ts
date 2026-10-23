/**
 * The Explorer's tree (VS Code's): in each folder its subfolders
 * (alphabetical), then its scripts (stored order, which is the stacking
 * order), then its data files (alphabetical). Pure, so it's unit-tested;
 * editor.ts renders the rows.
 */
import { allFolders, isInFolder } from "../shared/folders";
import { folderOf } from "../shared/scriptImports";

export type TreeKind = "folder" | "script" | "data";

export interface TreeRow {
    kind: TreeKind;
    /** script / data file id, or folderRowId(path) */
    id: string;
    /** script name, data file path or folder path */
    path: string;
    /** the last path segment (what the row shows) */
    name: string;
    depth: number;
    /** folders: showing their contents */
    expanded?: boolean;
}

export interface TreeInput {
    scripts: { id: string; name: string }[];
    dataFiles: { id: string; path: string }[];
    folders: string[];
    /** collapsed folder paths */
    collapsed?: ReadonlySet<string>;
    /** every row, collapsed folders' contents too (explorer order of all files) */
    all?: boolean;
}

const FOLDER = "dir:";
export const folderRowId = (path: string): string => FOLDER + path;
export const isFolderRowId = (id: string): boolean => id.startsWith(FOLDER);
export const folderPathOfRowId = (id: string): string => id.slice(FOLDER.length);

/** "a/b/c" → "c" */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
/** "" (the root) + "x" → "x"; "a" + "x" → "a/x" */
export const joinPath = (folder: string, name: string): string => (folder ? `${folder}/${name}` : name);

// as stackingOrder sorts folders, so the tree shows the stacking order
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

export function explorerTree(input: TreeInput): TreeRow[] {
    const folders = allFolders(input.folders, [...input.scripts.map((s) => s.name), ...input.dataFiles.map((d) => d.path)]);
    const data = [...input.dataFiles].sort((a, b) => byName(baseName(a.path), baseName(b.path)));
    const rows: TreeRow[] = [];
    const walk = (folder: string, depth: number): void => {
        for (const f of folders.filter((x) => folderOf(x) === folder).sort((a, b) => byName(baseName(a), baseName(b)))) {
            const expanded = !input.collapsed?.has(f);
            rows.push({ kind: "folder", id: folderRowId(f), path: f, name: baseName(f), depth, expanded });
            if (expanded || input.all) walk(f, depth + 1);
        }
        for (const s of input.scripts) if (folderOf(s.name) === folder) rows.push({ kind: "script", id: s.id, path: s.name, name: baseName(s.name), depth });
        for (const d of data) if (folderOf(d.path) === folder) rows.push({ kind: "data", id: d.id, path: d.path, name: baseName(d.path), depth });
    };
    walk("", 0);
    return rows;
}

/** The folder new items go into from this row: a folder itself, a file's folder, else the root. */
export function targetFolder(row: Pick<TreeRow, "kind" | "path"> | undefined): string {
    if (!row) return "";
    return row.kind === "folder" ? row.path : folderOf(row.path);
}

/**
 * Where a dragged item lands when dropped into `folder`: its new path, or
 * null when nothing moves (already there, or a folder into itself).
 */
export function dropPath(item: Pick<TreeRow, "kind" | "path">, folder: string): string | null {
    if (item.kind === "folder" && (folder === item.path || isInFolder(folder, item.path))) return null;
    const next = joinPath(folder, baseName(item.path));
    return next === item.path ? null : next;
}

/** The collapsed set after a folder moved from `from` to `to` (it and its subfolders keep their state). */
export function movedCollapsed(collapsed: ReadonlySet<string>, from: string, to: string): Set<string> {
    const out = new Set<string>();
    for (const f of collapsed) out.add(f === from ? to : isInFolder(f, from) ? to + f.slice(from.length) : f);
    return out;
}

/** The rows of a multi-selection that act for it: those not inside another selected folder. */
export function topLevelRows<T extends Pick<TreeRow, "kind" | "path">>(rows: T[]): T[] {
    const dirs = rows.filter((r) => r.kind === "folder").map((r) => r.path);
    return rows.filter((r) => !dirs.some((d) => isInFolder(r.path, d)));
}

/**
 * Where dragged items land when dropped into `folder`: the ones that move
 * and their new paths, or null when the drop isn't allowed (a folder into
 * itself) or nothing moves.
 */
export function dropPlan<T extends Pick<TreeRow, "kind" | "path">>(items: T[], folder: string): { item: T; to: string }[] | null {
    if (items.some((i) => i.kind === "folder" && (folder === i.path || isInFolder(folder, i.path)))) return null;
    const plan = items.flatMap((item) => {
        const to = dropPath(item, folder);
        return to === null ? [] : [{ item, to }];
    });
    return plan.length ? plan : null;
}

/** The ids from `a` to `b` (either order) in `ids`, for a shift-click / shift-arrow range. */
export function idRange(ids: string[], a: string, b: string): string[] {
    const i = ids.indexOf(a);
    const j = ids.indexOf(b);
    if (j < 0) return [];
    if (i < 0) return [b];
    return ids.slice(Math.min(i, j), Math.max(i, j) + 1);
}
