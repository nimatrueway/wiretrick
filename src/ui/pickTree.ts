/**
 * The Export…/Import… picker's tree: files under their folders (as in the
 * Explorer: settings.yaml first, then in each folder its subfolders, its
 * scripts, its data files), a checkbox per file and empty folder, folders'
 * boxes derived from what's in them, and a path filter. Pure, so it's
 * unit-tested; dialogs/BundlePicker.tsx renders it.
 */
import { baseName } from "./explorerTree";

export type PickKind = "settings" | "script" | "data" | "folder";

export interface PickItem {
    /** path as in the scripts folder: `mock/helpers.ts`, `mock/d.json`, `settings.yaml`; an (empty) folder's: `mock/empty` */
    path: string;
    kind: PickKind;
    /** short tag after the name, e.g. "disabled", "replaces existing" */
    badge?: string;
    detail?: string;
    /** default: checked */
    checked?: boolean;
}

export interface PickNode {
    path: string;
    name: string;
    /** a folder's contents (an empty folder item has none) */
    children?: PickNode[];
    /** a checkable entry: its index in the items */
    item?: number;
}

export interface PickRow {
    node: PickNode;
    depth: number;
    /** folders with contents: expanded */
    open?: boolean;
}

export type CheckState = "on" | "off" | "mixed";

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
const RANK: Record<PickKind, number> = { settings: 0, folder: 1, script: 2, data: 3 };

export function buildPickTree(items: PickItem[]): PickNode[] {
    const root: PickNode = { path: "", name: "", children: [] };
    const folders = new Map<string, PickNode>([["", root]]);
    const folder = (path: string): PickNode => {
        const key = path.toLowerCase();
        let f = folders.get(key);
        if (!f) {
            const i = path.lastIndexOf("/");
            f = { path, name: baseName(path), children: [] };
            folders.set(key, f);
            folder(i < 0 ? "" : path.slice(0, i)).children!.push(f);
        }
        return f;
    };
    items.forEach((it, i) => {
        if (it.kind === "folder") {
            folder(it.path).item = i;
            return;
        }
        const at = it.path.lastIndexOf("/");
        folder(at < 0 ? "" : it.path.slice(0, at)).children!.push({ path: it.path, name: baseName(it.path), item: i });
    });
    const kind = (n: PickNode): PickKind => (n.children ? "folder" : items[n.item!].kind);
    const sort = (n: PickNode): void => {
        if (!n.children) return;
        // stable: scripts keep their order (the stacking order)
        n.children.sort((a, b) => RANK[kind(a)] - RANK[kind(b)] || (kind(a) === "script" ? 0 : byName(a.name, b.name)));
        n.children.forEach(sort);
    };
    sort(root);
    return root.children!;
}

/** does a path match the filter (case-insensitive substring; "" matches all)? */
export const pathMatches = (path: string, query: string): boolean => path.toLowerCase().includes(query.trim().toLowerCase());

/** a node's checkable entries that match the filter */
export function leavesOf(node: PickNode, query = ""): number[] {
    const out: number[] = [];
    const walk = (n: PickNode): void => {
        if (n.item !== undefined && !n.children?.length) {
            if (pathMatches(n.path, query)) out.push(n.item);
        } else n.children?.forEach(walk);
    };
    walk(node);
    return out;
}

/** every checkable entry under these roots that matches the filter (what select all/none act on) */
export function visibleLeaves(roots: PickNode[], query = ""): number[] {
    return roots.flatMap((r) => leavesOf(r, query));
}

/**
 * The rows to show: the filter keeps matching entries and their folders
 * (and shows them expanded); otherwise collapsed folders hide their contents.
 */
export function pickTreeRows(roots: PickNode[], query: string, collapsed: ReadonlySet<string>): PickRow[] {
    const rows: PickRow[] = [];
    const filtering = query.trim() !== "";
    const walk = (nodes: PickNode[], depth: number): void => {
        for (const n of nodes) {
            if (!leavesOf(n, query).length) continue;
            const parent = !!n.children?.length;
            const open = parent ? filtering || !collapsed.has(n.path) : undefined;
            rows.push(open === undefined ? { node: n, depth } : { node: n, depth, open });
            if (open) walk(n.children!, depth + 1);
        }
    };
    walk(roots, 0);
    return rows;
}

/** a box's state: an entry's own, a folder's from its (matching) entries */
export function checkState(node: PickNode, checked: readonly boolean[], query = ""): CheckState {
    const leaves = leavesOf(node, query);
    const on = leaves.filter((i) => checked[i]).length;
    return on === 0 ? "off" : on === leaves.length ? "on" : "mixed";
}

/** `checked` with these entries set to `on` */
export function setChecked(checked: readonly boolean[], items: number[], on: boolean): boolean[] {
    const set = new Set(items);
    return checked.map((c, i) => (set.has(i) ? on : c));
}

/** clicking a box: an entry toggles; a folder checks all its matching entries unless all are checked */
export function toggleNode(node: PickNode, checked: readonly boolean[], query = ""): boolean[] {
    return setChecked(checked, leavesOf(node, query), checkState(node, checked, query) !== "on");
}
