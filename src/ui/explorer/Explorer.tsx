import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSnapshot } from "valtio";
import { isInFolder } from "../../shared/folders";
import { scriptHealth } from "../../shared/scriptHealth";
import { folderOf, isSvgPath } from "../../shared/scriptImports";
import { cleanScriptName, fileExtension, isTsxName, scriptFileName, scriptNameFromInput } from "../../shared/scriptName";
import { baseName, dropPlan, explorerTree, folderRowId, isFolderRowId, joinPath, targetFolder, type TreeRow } from "../explorerTree";
import { actions } from "../shell/actions";
import {
    actionRows,
    clearSel,
    collapseAll,
    cursorId,
    explorer,
    explorerIds,
    moveFocus,
    selectableIds,
    selectRange,
    setFolderExpanded,
    setSel,
    SETTINGS_ID,
    startRename,
    toggleSel,
    treeRow,
    visibleRows,
    type MenuItem,
    type NewKind,
} from "../state/explorer";
import { showContextMenu } from "./ContextMenu";
import { NameInput } from "./NameInput";
import { FileIcon, indent } from "./icons";
import { badgeRowOf, openInstallPage, packageOf, packages, packageTitle } from "../state/packages";
import { packageFolders } from "../../shared/makePackage";
import { packagesApi } from "../install/api";
import { packageName, type InstalledPackage } from "../../shared/packageModel";
import { MANIFEST_FILE } from "../../shared/packageMetadata";

/** the path the explorer's Copy Path copies (a script's is its file's) */
const rowFilePath = (row: TreeRow): string => (row.kind === "script" ? scriptFileName(row.path) : row.path);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** a new data file's path: `.json` unless it names an `.svg` */
const withJson = (path: string): string => (/\.(json|svg)$/i.test(path) ? path : path + ".json");

const copy = (text: string, done: string): void => void navigator.clipboard?.writeText(text).then(() => actions.status(done));

const pkgLabel = (p: InstalledPackage): string => `“${packageName(p)}”`;

/** run a package action; its failure shows in the status bar */
function pkgAction(fn: () => Promise<unknown>, done?: string): void {
    fn().then(
        () => done && actions.status(done),
        (e) => actions.status(String(e?.message || e), "error")
    );
}

async function checkUpdates(p?: InstalledPackage): Promise<void> {
    actions.status(p ? `checking ${pkgLabel(p)} for updates…` : "checking installed scripts for updates…");
    const before = p ? packages.byId[p.id] : undefined;
    const all = await packagesApi.check(p?.id);
    const after = p ? all[p.id] : undefined;
    if (p && after?.lastError) actions.status(`checking ${pkgLabel(p)} failed: ${after.lastError}`, "error");
    else if (p && after?.pending) openInstallPage(`?update=${encodeURIComponent(p.id)}`);
    else if (p) actions.status(after && before && after.updatedAt > before.updatedAt ? `updated ${pkgLabel(p)}` : `${pkgLabel(p)} is up to date`);
    else actions.status("checked installed scripts for updates");
}

/** a package's items in a menu on one of its rows */
function packageMenu(p: InstalledPackage): MenuItem[] {
    const src = p.source && /^https?:/i.test(p.source) ? p.source : "";
    return [
        ...(p.pending ? [{ label: "Review Update…", run: () => openInstallPage(`?update=${encodeURIComponent(p.id)}`) }] : []),
        ...(p.source ? [{ label: "Check for Updates", run: () => pkgAction(() => checkUpdates(p)) }] : []),
        ...(p.source ? [{ label: p.autoUpdate ? "Turn Auto-Update Off" : "Turn Auto-Update On", run: () => pkgAction(() => packagesApi.setAutoUpdate(p.id, !p.autoUpdate), `auto-update ${p.autoUpdate ? "off" : "on"} for ${pkgLabel(p)}`) }] : []),
        ...(p.previous ? [{ label: `Roll Back to ${p.previous.metadata.version || "the Previous Version"}`, run: () => pkgAction(() => packagesApi.rollback(p.id), `rolled ${pkgLabel(p)} back (auto-update is off now)`) }] : []),
        ...(src ? [{ label: "Open Source Page", run: () => void chrome.tabs.create({ url: src }) }] : []),
        { label: "Forget Package (Keep Files)", run: () => pkgAction(() => packagesApi.forget(p.id), `${pkgLabel(p)} won't update anymore`) },
        null,
    ];
}

function newItemsMenu(folder: string): MenuItem[] {
    return [
        { label: "New Script…", run: () => actions.startCreate("script", folder) },
        { label: "New JSON File…", run: () => actions.startCreate("data", folder) },
        { label: "New Folder…", run: () => actions.startCreate("folder", folder) },
    ];
}

function installMenu(): MenuItem[] {
    return [
        { label: "Install Script…", run: () => openInstallPage() },
        ...(Object.values(packages.byId).some((p) => p.source && p.autoUpdate) ? [{ label: "Check for Script Updates", run: () => pkgAction(() => checkUpdates()) }] : []),
    ];
}

/** open `id` unless it's already the open file */
/** folders holding a metadata.json: bundles (shared/makePackage) */
const localPackageFolders = (dataFiles: readonly { path: string }[]): Map<string, string> => packageFolders(dataFiles.map((d) => d.path));

/** what Export Package… on a folder starts from: its metadata.json, or an installed package's script; else undefined */
function packageStartOf(folder: string): string | undefined {
    const manifest = localPackageFolders(explorer.dataFiles).get(folder);
    if (manifest) return manifest;
    const p = Object.values(packages.byId).find((x) => x.folder === folder);
    return p ? `${folder}/${p.files[MANIFEST_FILE] ? MANIFEST_FILE : p.entries[0]}` : undefined;
}

/** `path` is in a package's folder (a bundle's, or an installed package's) */
const inPackageFolder = (path: string): boolean =>
    [...localPackageFolders(explorer.dataFiles).keys(), ...Object.values(packages.byId).flatMap((p) => (p.folder ? [p.folder] : []))].some((f) => path.startsWith(f + "/"));

const open = (id: string): void => {
    if (id !== explorer.selectedId || explorer.typingsShown) actions.select(id);
};

/** The explorer section: its header (with the New… and Collapse buttons) and the tree. */
export function ExplorerSection() {
    const snap = useSnapshot(explorer, { sync: true });
    const button = (run: () => void) => (e: MouseEvent) => {
        e.stopPropagation(); // not a click on the section header
        run();
    };
    return (
        <>
            <div id="explorer-section" role="button" tabIndex={-1} aria-expanded={snap.sectionOpen} title="Wiretrick scripts, data files and folders" onClick={() => void (explorer.sectionOpen = !explorer.sectionOpen)}>
                <span className="chevron" aria-hidden="true" />
                <span className="section-title">Wiretrick</span>
                <div className="section-actions">
                    <button id="btn-new" title="New Script…" aria-label="New Script" onClick={button(() => actions.startCreate("script"))}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M9.5 1.5h-6v13h5M9.5 1.5l3 3v4M9.5 1.5v3h3M12.5 10.5v5M10 13h5" /></svg>
                    </button>
                    {" "}
                    <button id="btn-new-json" title="New JSON File… (a data file)" aria-label="New JSON File" onClick={button(() => actions.startCreate("data"))}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M5 2.5c-1.5 0-1.5 1-1.5 2.2s0 2-1.5 2.3c1.5.3 1.5 1.1 1.5 2.3s0 2.2 1.5 2.2M10 13.5v-5M7.5 11h5" /><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M11 2.5c1.5 0 1.5 1 1.5 2.2v1.3" /></svg>
                    </button>
                    {" "}
                    <button id="btn-new-folder" title="New Folder…" aria-label="New Folder" onClick={button(() => actions.startCreate("folder"))}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" d="M8.5 13.5h-7v-10h4.3l1.5 1.5h7.2v3.5M12 9.5v5M9.5 12h5" /></svg>
                    </button>
                    {" "}
                    <button id="btn-install" title="Install Script… (from a URL, GitHub, a gist, a folder or a zip)" aria-label="Install Script" onClick={button(() => openInstallPage())}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" d="M8 1.5v8M5 6.5l3 3 3-3M2.5 10.5v3h11v-3" /></svg>
                    </button>
                    {" "}
                    <button id="btn-collapse-all" title="Collapse Folders in Explorer" aria-label="Collapse Folders in Explorer" onClick={button(collapseAll)}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.1" d="M4.5 3.5h9v9M2.5 5.5h9v9h-9zM4.5 10h5" /></svg>
                    </button>
                </div>
            </div>
            <ExplorerTree />
        </>
    );
}

/** the tree's keys (VS Code's) */
function onKeyDown(e: KeyboardEvent<HTMLUListElement>): void {
    if (e.target !== e.currentTarget) return; // the inline name input handles its own keys
    const ids = explorerIds();
    const cur = cursorId() ?? ids[0];
    const i = Math.max(0, ids.indexOf(cur));
    const rows = visibleRows();
    const row = cur === SETTINGS_ID ? undefined : rows.find((r) => r.id === cur);
    const mod = e.metaKey || e.ctrlKey;
    const plain = !mod && !e.altKey && !e.shiftKey;
    let handled = true;
    const nav: Record<string, string> = { ArrowDown: ids[Math.min(i + 1, ids.length - 1)], ArrowUp: ids[Math.max(i - 1, 0)], Home: ids[0], PageUp: ids[0], End: ids[ids.length - 1], PageDown: ids[ids.length - 1] };
    if (e.key in nav && e.shiftKey && !mod && nav[e.key] !== SETTINGS_ID) selectRange(nav[e.key]);
    else if (e.key in nav) {
        clearSel();
        moveFocus(nav[e.key]);
    } else if (e.key.toLowerCase() === "a" && mod && !e.shiftKey && !e.altKey) {
        setSel(selectableIds());
        moveFocus(cur);
    } else if (e.key === "ArrowRight" && plain) {
        // expand, or (expanded) go to the first child
        if (row?.kind === "folder" && !row.expanded) setFolderExpanded(row.path, true);
        else if (row?.kind === "folder" && (rows.find((r) => r.id === ids[i + 1])?.depth ?? -1) > row.depth) moveFocus(ids[i + 1]);
    } else if (e.key === "ArrowLeft" && plain) {
        // collapse, or go to the parent folder
        if (row?.kind === "folder" && row.expanded) setFolderExpanded(row.path, false);
        else if (row && folderOf(row.path)) moveFocus(folderRowId(folderOf(row.path)));
    } else if ((e.key === "Enter" || e.key === " ") && !mod) {
        if (row?.kind === "folder") setFolderExpanded(row.path, !row.expanded);
        else {
            open(cur);
            if (e.key === "Enter") actions.focusEditor(); // Enter opens and focuses, Space just opens (preview)
        }
    } else if (e.key === "F2" && row) startRename(cur, true);
    else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && row) actions.deleteRows(actionRows(cur));
    else if (e.key === "Escape" && explorer.sel.size > 1) {
        clearSel();
        moveFocus(cur);
    } else if (e.key === "Escape") actions.focusEditor();
    else handled = false;
    if (handled) {
        e.preventDefault();
        e.stopPropagation();
    }
}

/** ⌘/Ctrl-click and Shift-click select (without opening); a plain click selects just its row */
function onClickCapture(e: MouseEvent<HTMLUListElement>): void {
    const target = e.target as HTMLElement;
    if (target.closest("input, .btn-del, .err-ind, .pkg-ind.pending")) return;
    const id = target.closest<HTMLElement>("li.script-item:not(.creating)")?.dataset.id;
    if (!id) return;
    const mod = e.metaKey || e.ctrlKey;
    if (id !== SETTINGS_ID && (mod || e.shiftKey)) {
        e.stopPropagation();
        e.preventDefault();
        if (e.shiftKey) selectRange(id, mod);
        else toggleSel(id);
        return;
    }
    setSel(id === SETTINGS_ID ? [] : [id], null);
}

function onContextMenu(e: MouseEvent<HTMLUListElement>): void {
    if ((e.target as HTMLElement).closest("input")) return;
    e.preventDefault();
    const id = (e.target as HTMLElement).closest<HTMLElement>("li.script-item")?.dataset.id;
    if (!(id && explorer.sel.size > 1 && explorer.sel.has(id))) clearSel();
    if (id && explorer.sel.size > 1) {
        // on a multi-selection: what applies to all of it
        moveFocus(id);
        const rows = actionRows(id);
        const paths = rows.map(rowFilePath).join("\n");
        showContextMenu(e.clientX, e.clientY, [{ label: "Copy Paths", run: () => copy(paths, `copied ${plural(rows.length, "path")}`) }, null, { label: `Delete ${rows.length} Items`, key: "Delete", run: () => actions.deleteRows(rows) }]);
        return;
    }
    if (!id || id === SETTINGS_ID) {
        // settings.yaml and the empty space below the tree: the root
        if (id) moveFocus(id);
        showContextMenu(e.clientX, e.clientY, [...(id ? [{ label: "Open", key: "Enter", run: () => open(id) }, null] : []), ...newItemsMenu(""), null, ...installMenu()]);
        return;
    }
    const row = treeRow(id);
    if (!row) return;
    moveFocus(id);
    const script = row.kind === "script" ? explorer.scripts.find((s) => s.id === id) : undefined;
    const isLib = script?.meta.active === false;
    const pkg = packageOf(row);
    const inPkg = !!pkg || inPackageFolder(row.path);
    const exportStart = row.kind === "folder" ? packageStartOf(row.path) : script && !inPkg ? scriptFileName(script.meta.name) : undefined;
    const make = inPkg || exportStart?.endsWith(MANIFEST_FILE) ? undefined : script ? () => actions.makePackage(script.id) : row.kind === "folder" ? () => actions.makeFolderPackage(row.path) : undefined;
    showContextMenu(e.clientX, e.clientY, [
        ...(row.kind === "folder" ? [] : [{ label: "Open", key: "Enter", run: () => open(id) }, null]),
        ...(pkg ? packageMenu(pkg) : []),
        ...(script && !isLib ? [{ label: script.enabled ? "Disable" : "Enable", run: () => actions.setScriptEnabled(script.id, !script.enabled) }, null] : []),
        ...(make ? [{ label: "Make Package…", run: make }] : []),
        ...(exportStart ? [{ label: "Export Package…", run: () => actions.exportPackage(exportStart) }] : []),
        ...(make || exportStart ? [null] : []),
        ...newItemsMenu(targetFolder(row)),
        null,
        { label: "Copy Path", run: () => copy(rowFilePath(row), `copied ${rowFilePath(row)}`) },
        null,
        { label: "Rename…", key: "F2", run: () => startRename(id, true) },
        { label: "Delete", key: "Delete", run: () => actions.deleteRows([row]) },
    ]);
}

/** a double-click on a file's name renames it (a folder's clicks toggle it: rename it with F2) */
function onDoubleClick(e: MouseEvent<HTMLUListElement>): void {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li.script-item");
    const id = li?.dataset.id;
    if (!id || id === SETTINGS_ID || isFolderRowId(id) || !li!.querySelector(".script-name")) return;
    startRename(id);
}

/** Dragging rows (a multi-selection: all of it) onto a folder (or a file in it), or below the tree for the root, moves them. */
function useDnd() {
    /** the folder a drop would land in ("" the root), shown while dragging over the tree */
    const [dropFolder, setDropFolder] = useState<string | null>(null);
    const drag = useRef<{ rows: TreeRow[]; hoverId: string; timer: ReturnType<typeof setTimeout> | null }>({ rows: [], hoverId: "", timer: null });
    const rowAt = (e: DragEvent): TreeRow | undefined => {
        const id = (e.target as HTMLElement).closest?.<HTMLElement>("li.script-item")?.dataset.id;
        return id && id !== SETTINGS_ID ? visibleRows().find((r) => r.id === id) : undefined;
    };
    /** the folder the drop lands in, or null when it can't go there */
    const folderAt = (e: DragEvent): string | null => {
        const rows = drag.current.rows;
        if (!rows.length) return null;
        const folder = targetFolder(rowAt(e));
        return dropPlan(rows, folder) ? folder : null;
    };
    const stopHover = (): void => {
        const d = drag.current;
        if (d.timer) clearTimeout(d.timer);
        d.timer = null;
        d.hoverId = "";
    };
    const end = (): void => {
        drag.current.rows = [];
        setDropFolder(null);
        stopHover();
    };
    const handlers = {
        onDragStart(e: DragEvent) {
            const id = (e.target as HTMLElement).closest?.<HTMLElement>("li.script-item")?.dataset.id;
            const r = id ? visibleRows().find((x) => x.id === id) : undefined;
            if (!r || explorer.editing) {
                e.preventDefault();
                return;
            }
            const rows = (drag.current.rows = actionRows(r.id));
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", rows.map(rowFilePath).join("\n"));
            if (rows.length > 1) {
                const ghost = Object.assign(document.createElement("div"), { className: "drag-ghost", textContent: `${rows.length} items` });
                document.body.append(ghost);
                e.dataTransfer.setDragImage(ghost, -8, -8);
                setTimeout(() => ghost.remove());
            }
        },
        onDragOver(e: DragEvent) {
            const folder = folderAt(e);
            setDropFolder(folder);
            // hovering a collapsed folder opens it
            const r = rowAt(e);
            const d = drag.current;
            if (r?.kind === "folder" && !r.expanded && d.rows.length) {
                if (d.hoverId !== r.id) {
                    stopHover();
                    d.hoverId = r.id;
                    d.timer = setTimeout(() => setFolderExpanded(r.path, true), 600);
                }
            } else stopHover();
            if (folder === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        },
        onDragLeave(e: DragEvent) {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropFolder(null);
                stopHover();
            }
        },
        onDrop(e: DragEvent) {
            const folder = folderAt(e);
            const plan = folder === null ? null : dropPlan(drag.current.rows, folder);
            end();
            if (!plan) return;
            e.preventDefault();
            void actions.moveRows(plan);
        },
        onDragEnd: end,
    };
    return { dropFolder, handlers };
}

/** The tree: settings.yaml, then the folders, scripts and data files (one tab stop; the rows aren't focusable). */
export function ExplorerTree() {
    const snap = useSnapshot(explorer, { sync: true });
    const list = useRef<HTMLUListElement>(null);
    const { dropFolder, handlers } = useDnd();
    const pkgSnap = useSnapshot(packages);
    const pkgByRow = new Map<string, InstalledPackage>();
    for (const p of Object.values(pkgSnap.byId) as InstalledPackage[]) {
        const at = badgeRowOf(p);
        pkgByRow.set("folder" in at ? folderRowId(at.folder) : at.id, p);
    }
    const localPkgs = localPackageFolders(snap.dataFiles);
    const pkgBadge = (id: string) => {
        const p = pkgByRow.get(id);
        // a package folder's icon says it's a package: its badge is for news only
        if (!p || (isFolderRowId(id) && !p.pending && !p.lastError)) return null;
        return (
            <span
                className={"pkg-ind" + (p.pending ? " pending" : p.lastError ? " failed" : "")}
                title={packageTitle(p)}
                role="img"
                aria-label={p.pending ? "package update waiting" : "installed package"}
                onClick={
                    p.pending
                        ? (e) => {
                              e.stopPropagation();
                              openInstallPage(`?update=${encodeURIComponent(p.id)}`);
                          }
                        : undefined
                }
            >
                {p.pending ? "⬆" : "📦"}
            </span>
        );
    };
    const rows = explorerTree({ scripts: snap.scripts.map((s) => ({ id: s.id, name: s.meta.name })), dataFiles: [...snap.dataFiles], folders: [...snap.folders], collapsed: snap.collapsed });
    const { selectedId, dirty, sel, editing } = snap;
    const multi = sel.size > 1;
    const cursor = snap.focusedId ?? selectedId;
    // while wt-api.d.ts is shown no row is the open file (● still marks unsaved edits)
    const shown = snap.typingsShown ? null : selectedId;
    const shownIds = new Set([SETTINGS_ID, ...rows.map((r) => r.id)]);

    useLayoutEffect(() => {
        if (!snap.cursorMoves) return;
        const id = explorer.focusedId;
        if (id) document.getElementById(`explorer-${encodeURIComponent(id)}`)?.scrollIntoView?.({ block: "nearest" });
    }, [snap.cursorMoves]);

    /** `tail`: classes after `selected` (the original's class order) */
    const li = (id: string, cls: string, depth: number, content: ReactNode, extra: Record<string, unknown> = {}, folder?: boolean, tail = "") => {
        const inDrop = !!dropFolder && id !== SETTINGS_ID && rows.some((r) => r.id === id && ((r.kind === "folder" && r.path === dropFolder) || isInFolder(r.path, dropFolder)));
        return (
            <li
                key={id}
                className={"script-item" + cls + (id === shown ? " selected" : "") + tail + (id === cursor ? " focused" : "") + (id === selectedId && dirty ? " dirty" : "") + (multi && sel.has(id) ? " multi" : "") + (inDrop ? " drop-target" : "")}
                data-id={id}
                id={`explorer-${encodeURIComponent(id)}`}
                role="treeitem"
                aria-selected={id === shown || (multi && sel.has(id))}
                aria-level={depth + 1}
                style={{ "--depth": String(depth) } as any}
                {...extra}
            >
                {indent(depth, folder)}
                {content}
            </li>
        );
    };
    const name = (row: TreeRow, text: string, title: string, cls = "") =>
        editing?.mode === "rename" && editing.id === row.id ? (
            <RenameInput key="rename" row={row} refocusList={editing.refocusList} list={list} />
        ) : (
            <span className={"script-name" + cls} title={title}>
                {text}
            </span>
        );
    const del = (r: TreeRow, title: string) => (
        <button
            className="btn-del"
            title={title}
            tabIndex={-1}
            onClick={(e) => {
                e.stopPropagation();
                actions.deleteRows([r]);
            }}
        >
            ✕
        </button>
    );
    const click = (id: string, then: () => void) => ({
        onClick: () => {
            moveFocus(id);
            then();
        },
    });

    const items: ReactNode[] = [
        li(
            SETTINGS_ID,
            " utility",
            0,
            <>
                <FileIcon kind="yaml" />
                <span className="script-name">settings.yaml</span>
            </>,
            { title: "Settings file — global settings and per-script params & enabled state", ...click(SETTINGS_ID, () => actions.select(SETTINGS_ID)) }
        ),
    ];
    for (const r of rows) {
        if (r.kind === "folder") {
            items.push(
                li(
                    r.id,
                    " folder",
                    r.depth,
                    <>
                        <FileIcon kind={pkgByRow.get(r.id) || localPkgs.has(r.path) ? "package" : r.expanded ? "folder-open" : "folder"} />
                        {name(r, r.name, [r.path, pkgByRow.get(r.id) ? packageTitle(pkgByRow.get(r.id)!) : localPkgs.has(r.path) ? `A package (${MANIFEST_FILE}) — right-click → Export Package… to share it` : "", "F2 to rename · drag to move"].filter(Boolean).join("\n"))}
                        {pkgBadge(r.id)}
                    </>,
                    { "aria-expanded": !!r.expanded, draggable: true, ...click(r.id, () => setFolderExpanded(r.path, !r.expanded)) },
                    r.expanded
                )
            );
        } else if (r.kind === "data") {
            const bad = snap.jsonErrorIds.has(r.id);
            const svg = isSvgPath(r.path);
            const title = [r.path, `Data file — import it from a script (import ${svg ? "markup" : "data"} from "./${baseName(r.path)}"${svg ? ": the SVG markup, a string" : ""})`, bad ? "Its JSON has errors — see the Problems view" : "", "Double-click or F2 to rename · drag to move"].filter(Boolean).join("\n");
            items.push(
                li(
                    r.id,
                    " data" + (bad ? " has-error" : ""),
                    r.depth,
                    <>
                        <FileIcon kind={svg ? "svg" : "json"} />
                        {name(r, r.name, title, bad ? " error" : "")}
                        {del(r, "Delete data file (Delete)")}
                    </>,
                    { draggable: true, ...click(r.id, () => open(r.id)) }
                )
            );
        } else {
            const script = explorer.scripts.find((s) => s.id === r.id)!;
            const isLib = script.meta.active === false;
            const off = !isLib && !script.enabled;
            const health = scriptHealth(script);
            const title = [
                r.depth ? scriptFileName(script.meta.name) : "",
                script.meta.description ?? "",
                isLib ? "Library — registers no handlers with its current params, importable by other scripts. Register a handler (e.g. wt.onRequest({ url, strategy }, fn)) to make it a script" : script.meta.match.join(", "),
                off ? "Disabled — enable it from the toolbar or the right-click menu" : "",
                "Double-click or F2 to rename",
            ]
                .filter(Boolean)
                .join("\n");
            items.push(
                li(
                    r.id,
                    (isLib ? " utility" : "") + (off ? " disabled" : ""),
                    r.depth,
                    <>
                        <FileIcon kind={isTsxName(script.meta.name) ? "tsx" : "ts"} />
                        {name(r, baseName(scriptFileName(script.meta.name)), title, health ? " error" : "")}
                        {pkgBadge(r.id)}
                        {health && (
                            <span
                                className={`err-ind ${health.kind}`}
                                title={health.tooltip}
                                role="img"
                                aria-label={`${health.kind === "types" ? "type" : health.kind} error`}
                                onClick={
                                    health.kind === "runtime"
                                        ? (e) => {
                                              e.stopPropagation();
                                              actions.dismissError(script.id);
                                          }
                                        : undefined
                                }
                            >
                                ⚠
                            </span>
                        )}
                        {del(r, "Delete script (Delete)")}
                    </>,
                    // re-selecting would re-open the file and swallow a double-click
                    { draggable: true, ...click(r.id, () => open(r.id)) },
                    undefined,
                    health ? " has-error" : ""
                )
            );
        }
    }
    if (editing?.mode === "create") {
        const at = items.findIndex((it) => (it as { key: string }).key === (editing.folder ? folderRowId(editing.folder) : SETTINGS_ID));
        items.splice(at + 1, 0, <CreateRow key="creating" kind={editing.kind} folder={editing.folder} list={list} />);
    }

    return (
        <ul
            ref={list}
            id="script-list"
            className={dropFolder === "" ? "drop-root" : undefined}
            role="tree"
            tabIndex={0}
            aria-label="Scripts, data files and folders"
            aria-activedescendant={cursor && shownIds.has(cursor) ? `explorer-${encodeURIComponent(cursor)}` : undefined}
            onKeyDown={onKeyDown}
            // the rows aren't focusable themselves: a click focuses the tree
            onMouseDown={(e) => {
                if (!(e.target as HTMLElement).closest("input")) setTimeout(() => list.current?.focus());
            }}
            onClickCapture={onClickCapture}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            {...handlers}
        >
            {items}
        </ul>
    );
}

/** Inline rename (double-click a name, or F2); a / in the new name moves the item. */
function RenameInput({ row, refocusList, list }: { row: TreeRow; refocusList: boolean; list: { current: HTMLUListElement | null } }) {
    const kind: NewKind = row.kind;
    const current = row.kind === "script" ? scriptFileName(cleanScriptName(row.path)) : row.path;
    // select the name, not its folder or extension (`.wiretrick.ts` included — as VS Code does)
    const ext = kind === "folder" ? 0 : fileExtension(current).length;
    const range: [number, number] = [current.lastIndexOf("/") + 1, current.length - ext];
    return (
        <NameInput
            kind={kind}
            value={current}
            range={range}
            onDone={(commit, value) => {
                const editing = explorer.editing;
                if (refocusList) list.current?.focus();
                let next = cleanScriptName(value).trim();
                if (kind === "script") next = scriptNameFromInput(next);
                if (kind === "data" && next) next = withJson(next);
                let problem = commit && next && next !== row.path ? actions.itemPathProblem(kind, next, row.kind === "folder" ? undefined : row.id) : "";
                if (!problem && kind === "folder" && commit && isInFolder(next, row.path)) problem = "a folder can't move into itself";
                if (problem) actions.status(`can't rename: ${problem}`, "error");
                const finish = (): void => {
                    if (explorer.editing === editing) explorer.editing = null;
                };
                if (!commit || !next || next === row.path || problem) finish();
                // the input shows the new name until the row does
                else void actions.moveRows([{ item: row, to: next }]).finally(finish);
            }}
        />
    );
}

/** A new item's row (right below its folder): its icon and the name input. */
function CreateRow({ kind, folder, list }: { kind: NewKind; folder: string; list: { current: HTMLUListElement | null } }) {
    const row = useRef<HTMLLIElement>(null);
    const depth = folder ? folder.split("/").length : 0;
    useLayoutEffect(() => void row.current!.scrollIntoView?.({ block: "nearest" }), []);
    return (
        <li ref={row} className="script-item creating" style={{ "--depth": String(depth) } as any}>
            {indent(depth, kind === "folder" ? false : undefined)}
            <FileIcon kind={kind === "script" ? "ts" : kind === "data" ? "json" : "folder"} />
            <NameInput
                kind={kind}
                value=""
                placeholder={kind === "script" ? "script name" : kind === "data" ? "name.json or name.svg" : "folder name"}
                onDone={(commit, value) => {
                    explorer.editing = null;
                    let name = cleanScriptName(value).trim();
                    if (kind === "script") name = scriptNameFromInput(name);
                    if (kind === "data" && name) name = withJson(name);
                    if (!commit || !name) {
                        list.current?.focus();
                        return;
                    }
                    actions.createItem(kind, joinPath(folder, name));
                }}
            />
        </li>
    );
}
