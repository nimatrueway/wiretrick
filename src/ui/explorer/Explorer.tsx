import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSnapshot } from "valtio";
import { isInFolder } from "../../shared/folders";
import { scriptHealth } from "../../shared/scriptHealth";
import { folderOf, isSvgPath } from "../../shared/scriptImports";
import { cleanScriptName, isTsxName, scriptFileName, scriptNameFromInput } from "../../shared/scriptName";
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

const FOLDER_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8h-13z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;
const FOLDER_OPEN_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 12.5v-9h4.3l1.5 1.5h5.2v2M1.5 12.5l2-5.5h11l-2 5.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;
/** the explorer twistie (VS Code's chevron-right) */
const CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

type Icon = "ts" | "tsx" | "yaml" | "json" | "svg" | "folder" | "folder-open";

function FileIcon({ kind }: { kind: Icon }) {
    const folder = kind === "folder" || kind === "folder-open";
    return folder ? (
        <span className="file-icon folder" aria-hidden="true" dangerouslySetInnerHTML={{ __html: kind === "folder" ? FOLDER_ICON : FOLDER_OPEN_ICON }} />
    ) : (
        <span className={`file-icon ${kind}`} aria-hidden="true">
            {kind === "ts" ? "TS" : kind === "tsx" ? "⚛" : kind === "json" ? "{}" : kind === "svg" ? "◈" : "⚙"}
        </span>
    );
}

/** indent guides (one per level) and the twistie: a chevron on folders (`open` = expanded) */
function indent(depth: number, open?: boolean): ReactNode[] {
    const out: ReactNode[] = [];
    for (let i = 0; i < depth; i++) out.push(<span key={`g${i}`} className="indent-guide" style={{ "--level": String(i) } as any} />);
    const cls = "twistie" + (open === undefined ? "" : open ? " collapsible open" : " collapsible");
    out.push(open === undefined ? <span key="tw" className={cls} aria-hidden="true" /> : <span key="tw" className={cls} aria-hidden="true" dangerouslySetInnerHTML={{ __html: CHEVRON }} />);
    return out;
}

/** the path the explorer's Copy Path copies (a script's is its file's) */
const rowFilePath = (row: TreeRow): string => (row.kind === "script" ? scriptFileName(row.path) : row.path);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** a new data file's path: `.json` unless it names an `.svg` */
const withJson = (path: string): string => (/\.(json|svg)$/i.test(path) ? path : path + ".json");

const copy = (text: string, done: string): void => void navigator.clipboard?.writeText(text).then(() => actions.status(done));

function newItemsMenu(folder: string): MenuItem[] {
    return [
        { label: "New Script…", run: () => actions.startCreate("script", folder) },
        { label: "New JSON File…", run: () => actions.startCreate("data", folder) },
        { label: "New Folder…", run: () => actions.startCreate("folder", folder) },
    ];
}

/** open `id` unless it's already the open file */
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
    if (target.closest("input, .btn-del, .err-ind")) return;
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
        showContextMenu(e.clientX, e.clientY, [...(id ? [{ label: "Open", key: "Enter", run: () => open(id) }, null] : []), ...newItemsMenu("")]);
        return;
    }
    const row = treeRow(id);
    if (!row) return;
    moveFocus(id);
    const script = row.kind === "script" ? explorer.scripts.find((s) => s.id === id) : undefined;
    const isLib = script?.meta.active === false;
    showContextMenu(e.clientX, e.clientY, [
        ...(row.kind === "folder" ? [] : [{ label: "Open", key: "Enter", run: () => open(id) }, null]),
        ...(script && !isLib ? [{ label: script.enabled ? "Disable" : "Enable", run: () => actions.setScriptEnabled(script.id, !script.enabled) }, null] : []),
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
                        <FileIcon kind={r.expanded ? "folder-open" : "folder"} />
                        {name(r, r.name, `${r.path}\nF2 to rename · drag to move`)}
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
    // select the name, not its folder or extension (as VS Code does)
    const ext = kind === "script" ? (isTsxName(current) ? 4 : 3) : kind === "data" ? (/\.(json|svg)$/i.exec(current)?.[0].length ?? 0) : 0;
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
