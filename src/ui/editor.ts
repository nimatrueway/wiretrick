/**
 * Manager page: script list + Monaco editor + logs + VS Code bridge.
 */

import { loadMonaco, STARTER_TEMPLATE, apiTypingsText, setDataFileTypings } from "./monacoSetup";
import { API_TYPINGS_URI } from "./apiLinks";
import { NavHistory } from "./navHistory";
import { API_REFERENCE } from "./apiReference";
import { SHORTCUTS, filterShortcuts, formatKey, keysFor } from "./shortcuts";
import { SAMPLES } from "./samples";
import { settingsDiagnostics, settingsCompletions, settingsHover, type AssistScript } from "../shared/settingsAssist";
import { dependantsOf, folderOf, missingImports } from "../shared/scriptImports";
import { allFolders, ancestorFolders, isInFolder, movedPath } from "../shared/folders";
import { baseName, dropPlan, explorerTree, folderPathOfRowId, folderRowId, idRange, isFolderRowId, joinPath, movedCollapsed, targetFolder, topLevelRows, type TreeRow } from "./explorerTree";
import { dataPathOfDecl } from "./jsonTypes";
import { pickRows } from "./bundlePicker";
import { resolveConflict } from "./conflictDialog";
import { watchTheme, saveTheme, type Theme, type ThemePref } from "./theme";
import * as fsBridge from "./fsBridge";
import { cleanScriptName, scriptNameProblem, scriptFileName, scriptFileKey, uniqueScriptName, dataFilePathProblem, folderPathProblem, MAX_PATH } from "../shared/scriptName";
import { buildBundle, parseBundleText, bundleSettingsDoc, pickBundle, vscodeTargetPath, editorLaunchUrl, launchAppName, type LaunchMode } from "./bundle";
import { createQuickOpenPalette } from "./quickOpen";
import { computeDirty } from "./dirtyState";
import { parseSettings, SETTINGS_FILE, defaultStrategySetting, isStrategy, type SettingsDoc } from "../shared/settingsYaml";
import { STRATEGIES, type Strategy } from "../shared/route";
import { STRATEGY_DOC_URL, STRATEGY_INFO, strategyUnsupported } from "../shared/strategyInfo";
import { dlogLevel } from "../shared/debugLog";
import { helperInstallCommand, helperInstallShell } from "../shared/helperInstall";
import { mountNetworkPanel } from "./network/mount";
import { createNetStore } from "./network/netStore";
import { installTooltips } from "./tooltip";
import { scriptHealth, type ScriptHealthInput } from "../shared/scriptHealth";
import type { Uri, IPosition, IRange, IKeyboardEvent, editor as MonacoEditor } from "monaco-editor";
import type { Script } from "../background/engine/scriptStore";
import type { DataFile } from "../background/engine/dataFiles";
import { setupPanelDock, currentSide, currentDock } from "./panelDock";
import { badgeCount, LogBadge, NetBadge, type TabBadge } from "./logBadge";
import { collectProblems, filterProblems, problemCounts, ProblemsBadge, type Problem, type ProblemGroup, type ProblemMarker } from "./problems";
import { touchCounts } from "./network/netFormat";
import { effect } from "@preact/signals";
import { aboutRows, aboutText, checkLatestRelease, collectDiagnostics, describeLatest, diagnosticsFileName, downloadText, RELEASES_URL, type HelperStatus } from "./about";

// ---- state ----
let scripts: (Script & { runtimeError?: ScriptHealthInput["runtimeError"]; typeErrors?: string[]; ruleErrors?: string[]; routeWarnings?: string[] })[] = [];
/** data files (JSON), by path; folders: every folder (explicit + implied), sorted */
let dataFiles: DataFile[] = [];
let folders: string[] = [];
let selectedId: string | null = null;
let editor: any = null;
let dirty = false;
/** wt-api.d.ts is shown read-only over the selected script (whose model,
 * unsaved edits included, stays as it is underneath) */
let typingsShown = false;

/** Central dirty-state toggle: dims/undims Save. */
function setDirty(v: boolean): void {
    dirty = v;
    if (selectedId) document.querySelector(`#script-list li[data-id="${CSS.escape(selectedId)}"]`)?.classList.toggle("dirty", v);
    setSaveState(v ? "unsaved" : "saved");
}

/** The Save button is the save indicator: ● unsaved, spinner while saving, ✓ saved. */
function setSaveState(state: "saved" | "unsaved" | "saving"): void {
    const btn = $("#btn-save");
    btn.dataset.state = state;
    const can = state === "unsaved" && !typingsShown;
    btn.toggleAttribute("disabled", !can);
    btn.classList.toggle("dim", !can);
    btn.querySelector(".save-label")!.textContent = state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Save";
    btn.title = state === "saved" ? "Saved — no unsaved changes" : state === "saving" ? "Saving…" : "Unsaved changes — Save (⌘S)";
}
let applyingExternal = false;

/** last-saved content per open file (model uri → text): reverting to it clears dirty */
const baselines = new Map<string, string>();
const setBaseline = (m: any, text: string): void => {
    baselines.set(m.uri.toString(), text);
};

/** dirty = content differs from the file's baseline OR the name differs from the stored one */
function updateDirty(): void {
    if (!editor || typingsShown) return;
    const m = editor.getModel();
    const dirtyNow = computeDirty(
        m ? m.getValue() : "",
        m ? (baselines.get(m.uri.toString()) ?? null) : null,
        undefined,
        undefined
    );
    setDirty(dirtyNow);
    status("");
}

// ---- elements ----
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const $input = (sel: string): HTMLInputElement => document.querySelector(sel) as HTMLInputElement;

// ---- helpers ----
function sendRaw<T = any>(msg: any): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp: T) => {
            const err = (chrome.runtime as any).lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp);
        });
    });
}

function uuid(): string {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

let statusClick: (() => void) | null = null;

/** Toolbar status line; with onClick it renders as a link-like action. */
function status(text: string, cls = "", onClick?: () => void): void {
    const el = $("#editor-status");
    el.textContent = text;
    el.className = cls + (onClick ? " clickable" : "");
    statusClick = onClick ?? null;
}

// ---- script list ----
const SETTINGS_ID = "__settings__";
let settingsModel: any = null;

async function loadSettingsModel(force = false): Promise<void> {
    if (!editor) return;
    const monaco = (window as any).monaco;
    // Monaco's built-in yaml basic language provides colorization
    // the stored text is the whole synced document (comments, order,
    // formatting) — never patch our own copy key by key
    const { text } = await send({ type: "getSettingsYaml" });
    if (!settingsModel) {
        settingsModel = monaco.editor.createModel(text, "yaml", monaco.Uri.parse("file:///settings.yaml"));
        setBaseline(settingsModel, text);
        settingsModel.onDidChangeContent(() => scheduleSettingsMarkers());
        scheduleSettingsMarkers();
    } else if (settingsModel.getValue() !== text && (force || !dirty)) {
        applyingExternal = true;
        settingsModel.setValue(text);
        applyingExternal = false;
        setBaseline(settingsModel, text);
    }
}

// ---- settings.yaml assistance: schema + each script's declared params ----
const assistScripts = (): AssistScript[] =>
    scripts.map((s: any) => ({ name: s.meta.name, declared: s.meta.active !== false, defs: s.paramDefs ?? {} }));
let settingsMarkerTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSettingsMarkers(): void {
    if (settingsMarkerTimer) clearTimeout(settingsMarkerTimer);
    settingsMarkerTimer = setTimeout(() => {
        settingsMarkerTimer = null;
        const monaco = (window as any).monaco;
        const m = settingsModel;
        if (!m || m.isDisposed()) return;
        const markers = settingsDiagnostics(m.getValue(), assistScripts()).map((d) => {
            const a = m.getPositionAt(d.start);
            const b = m.getPositionAt(d.end);
            return {
                severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                startLineNumber: a.lineNumber,
                startColumn: a.column,
                endLineNumber: b.lineNumber,
                endColumn: b.column,
                message: d.message,
                source: "settings.yaml",
            };
        });
        monaco.editor.setModelMarkers(m, "wt-settings", markers);
    }, 250);
}

function registerSettingsAssist(): void {
    const monaco = (window as any).monaco;
    const mine = (model: any) => model === settingsModel;
    const KIND: Record<string, any> = {
        property: monaco.languages.CompletionItemKind.Property,
        value: monaco.languages.CompletionItemKind.Value,
        module: monaco.languages.CompletionItemKind.Module,
    };
    monaco.languages.registerCompletionItemProvider("yaml", {
        triggerCharacters: [" ", ":"],
        provideCompletionItems(model: any, position: any) {
            if (!mine(model)) return { suggestions: [] };
            const offset = model.getOffsetAt(position);
            const { items, replaceFrom } = settingsCompletions(model.getValue(), offset, assistScripts());
            const start = model.getPositionAt(replaceFrom);
            const range = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: position.lineNumber, endColumn: position.column };
            return {
                suggestions: items.map((it, i) => ({
                    label: it.label,
                    kind: KIND[it.kind],
                    insertText: it.insertText,
                    detail: it.detail,
                    documentation: it.documentation ? { value: it.documentation } : undefined,
                    sortText: String(i).padStart(4, "0"),
                    range,
                    // a key completion that opens a nested map continues straight into it
                    command: it.insertText.endsWith("\n") || /\n\s+$/.test(it.insertText) ? { id: "editor.action.triggerSuggest", title: "" } : undefined,
                })),
            };
        },
    });
    monaco.languages.registerHoverProvider("yaml", {
        provideHover(model: any, position: any) {
            if (!mine(model)) return null;
            const h = settingsHover(model.getValue(), model.getOffsetAt(position), assistScripts());
            if (!h) return null;
            const a = model.getPositionAt(h.start);
            const b = model.getPositionAt(h.end);
            return { contents: [{ value: h.markdown }], range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column } };
        },
    });
}

async function selectSettings(): Promise<void> {
    // back from the typings: settings.yaml's unsaved edits are still in its model
    const back = typingsShown && selectedId === SETTINGS_ID;
    leaveTypings();
    selectedId = SETTINGS_ID;
    focusedId = null;
    renderList();
    $("#btn-save").removeAttribute("disabled");
    await loadSettingsModel(!back);
    if (editor.getModel() !== settingsModel) {
        captureViewState();
        editor.setModel(settingsModel);
        restoreViewState(settingsModel);
    }
    if (back) updateDirty();
    else {
        setDirty(false);
        status("");
    }
    updateOpenVscode();
}

async function saveSettings(): Promise<void> {
    setSaveState("saving");
    const res = await send({ type: "applySettingsYaml", text: editor.getValue() });
    if (res && res.error) {
        setSaveState("unsaved");
        status(`settings.yaml: ${res.error}`, "error");
        return;
    }
    await loadSettingsModel(true); // re-canonicalize (restores commented defaults)
    setDirty(false);
    status("");
    await refresh();
}

async function refresh(): Promise<void> {
    const prev = scripts;
    const prevData = dataFiles;
    const [listed, data, dirs] = await Promise.all([send({ type: "listScripts" }), send({ type: "listDataFiles" }), send({ type: "listFolders" })]);
    scripts = listed;
    dataFiles = data || [];
    folders = dirs || [];
    const known = (id: string): boolean => scripts.some((s) => s.id === id) || dataFiles.some((d) => d.id === id);
    if (dirty && selectedId && selectedId !== SETTINGS_ID && !known(selectedId)) {
        // deleted elsewhere while edited here: keep the buffer (and its
        // model) so the unsaved text isn't lost; saving offers to recreate
        const orphan = prev.find((s) => s.id === selectedId);
        const orphanData = prevData.find((d) => d.id === selectedId);
        if (orphan) {
            scripts = [...scripts, orphan];
            status(`"${orphan.meta.name}" was deleted elsewhere — save to recreate it`, "error");
        } else if (orphanData) {
            dataFiles = [...dataFiles, orphanData];
            status(`"${orphanData.path}" was deleted elsewhere — save to recreate it`, "error");
        }
    }
    pruneCollapsed();
    renderList();
    syncModels();
    syncDataModels();
    scheduleDiagnostics();
    scheduleSettingsMarkers();
    if (selectedId && selectedId !== SETTINGS_ID && !known(selectedId)) {
        selectedId = null;
    }
    if (selectedId === SETTINGS_ID) return;
    if (!selectedId && scripts.length > 0) {
        selectReal(scripts[0].id);
    } else if (!selectedId) {
        renderEditorEmpty();
    }
}

let renaming = false;
/** keyboard cursor in the explorer (VS Code "focused" row); null = follow the open file */
let focusedId: string | null = null;
/** the explorer's multi-selection (⌘/Ctrl-click, Shift-click, Shift+↑/↓); fewer than 2 = just the cursor row */
let explorerSel = new Set<string>();
/** where a Shift range starts (null: the cursor) */
let selAnchor: string | null = null;
/** the tree rows renderList showed (not the contents of collapsed folders) */
let visibleRows: TreeRow[] = [];
/** data files whose JSON has errors (their name shows red, like a script's) */
let jsonErrorIds = new Set<string>();

// ---- explorer tree: folder collapse state (persisted, like VS Code's) ----
const COLLAPSED_KEY = "wtExplorerCollapsed";
let collapsed = new Set<string>(loadCollapsed());

function loadCollapsed(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}

function setCollapsed(next: Set<string>): void {
    collapsed = next;
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

const everyFolder = (): string[] => allFolders(folders, [...scripts.map((s) => s.meta.name), ...dataFiles.map((d) => d.path)]);

/** forget the state of folders that are gone */
function pruneCollapsed(): void {
    const all = new Set(everyFolder());
    if ([...collapsed].some((f) => !all.has(f))) setCollapsed(new Set([...collapsed].filter((f) => all.has(f))));
}

const treeRows = (all = false): TreeRow[] =>
    explorerTree({ scripts: scripts.map((s) => ({ id: s.id, name: s.meta.name })), dataFiles, folders, collapsed, all });

/** a row by id, shown or inside a collapsed folder */
const treeRow = (id: string | null): TreeRow | undefined =>
    id ? (visibleRows.find((r) => r.id === id) ?? treeRows(true).find((r) => r.id === id)) : undefined;

function setFolderExpanded(path: string, expanded: boolean): void {
    if (expanded === !collapsed.has(path)) return;
    const next = new Set(collapsed);
    if (expanded) next.delete(path);
    else next.add(path);
    setCollapsed(next);
    renderList();
}

/** expand the folders `path` is in (VS Code reveals the file it opens) */
function revealInExplorer(path: string): void {
    const shut = ancestorFolders(path).filter((f) => collapsed.has(f));
    if (shut.length) setCollapsed(new Set([...collapsed].filter((f) => !shut.includes(f))));
}

function collapseAll(): void {
    setCollapsed(new Set(everyFolder()));
    const cur = treeRow(focusedId);
    // the cursor goes to the top-level folder that now hides it
    if (cur && cur.path.includes("/")) focusedId = folderRowId(cur.path.slice(0, cur.path.indexOf("/")));
    renderList();
}

const FOLDER_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8h-13z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;
const FOLDER_OPEN_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 12.5v-9h4.3l1.5 1.5h5.2v2M1.5 12.5l2-5.5h11l-2 5.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;

function renderList(): void {
    updateEnabledToggle();
    scheduleProblems();
    if (renaming) return; // a rebuild would drop the inline rename input
    const list = $("#script-list");
    list.innerHTML = "";
    visibleRows = treeRows();
    if (explorerSel.size) {
        const all = new Set(treeRows(true).map((r) => r.id));
        explorerSel = new Set([...explorerSel].filter((id) => all.has(id)));
    }
    const multi = explorerSel.size > 1;
    const cursor = focusedId ?? selectedId;
    // while wt-api.d.ts is shown no row is the open file (● still marks unsaved edits)
    const shown = typingsShown ? null : selectedId;
    const row = (id: string, cls: string, depth = 0, folder?: boolean): HTMLLIElement => {
        const li = document.createElement("li");
        li.className = "script-item" + cls + (id === shown ? " selected" : "") + (id === cursor ? " focused" : "") + (id === selectedId && dirty ? " dirty" : "") + (multi && explorerSel.has(id) ? " multi" : "");
        li.dataset.id = id;
        li.id = `explorer-${encodeURIComponent(id)}`;
        li.setAttribute("role", "treeitem");
        li.setAttribute("aria-selected", String(id === shown || (multi && explorerSel.has(id))));
        li.setAttribute("aria-level", String(depth + 1));
        li.style.setProperty("--depth", String(depth));
        if (id === cursor) list.setAttribute("aria-activedescendant", li.id);
        li.append(...treeIndent(depth, folder));
        return li;
    };
    const name = (text: string, cls = ""): HTMLSpanElement => {
        const el = document.createElement("span");
        el.className = "script-name" + cls;
        el.textContent = text;
        return el;
    };
    const delButton = (r: TreeRow, title: string): HTMLButtonElement => {
        const del = document.createElement("button");
        del.className = "btn-del";
        del.textContent = "✕";
        del.title = title;
        del.tabIndex = -1;
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            void deleteRows([r]);
        });
        return del;
    };
    const sli = row(SETTINGS_ID, " utility");
    sli.title = "Settings file — global settings and per-script params & enabled state";
    sli.append(fileIcon("yaml"), name("settings.yaml"));
    sli.addEventListener("click", () => {
        moveExplorerFocus(SETTINGS_ID);
        select(SETTINGS_ID);
    });
    list.appendChild(sli);
    for (const r of visibleRows) {
        if (r.kind === "folder") {
            const li = row(r.id, " folder", r.depth, r.expanded);
            li.setAttribute("aria-expanded", String(!!r.expanded));
            li.draggable = true;
            const label = name(r.name);
            label.title = `${r.path}\nF2 to rename · drag to move`;
            li.append(fileIcon(r.expanded ? "folder-open" : "folder"), label);
            li.addEventListener("click", () => {
                moveExplorerFocus(r.id);
                setFolderExpanded(r.path, !r.expanded);
            });
            list.appendChild(li);
            continue;
        }
        if (r.kind === "data") {
            const bad = jsonErrorIds.has(r.id);
            const li = row(r.id, " data" + (bad ? " has-error" : ""), r.depth);
            li.draggable = true;
            const label = name(r.name, bad ? " error" : "");
            label.title = [r.path, `Data file — import it from a script (import data from "./${baseName(r.path)}")`, bad ? "Its JSON has errors — see the Problems view" : "", "Double-click or F2 to rename · drag to move"].filter(Boolean).join("\n");
            li.append(fileIcon("json"), label, delButton(r, "Delete data file (Delete)"));
            li.addEventListener("click", () => {
                moveExplorerFocus(r.id);
                if (r.id !== selectedId || typingsShown) select(r.id);
            });
            list.appendChild(li);
            continue;
        }
        const script = scripts.find((s) => s.id === r.id)!;
        const isLib = script.meta.active === false;
        const off = !isLib && !script.enabled;
        const li = row(script.id, (isLib ? " utility" : "") + (off ? " disabled" : ""), r.depth);
        li.draggable = true;

        const health = scriptHealth(script);
        const label = name(baseName(scriptFileName(script.meta.name)), health ? " error" : "");
        label.title = [
            r.depth ? scriptFileName(script.meta.name) : "",
            script.meta.description ?? "",
            isLib ? "Library — registers no handlers with its current params, importable by other scripts. Register a handler (e.g. wt.onRequest(url, fn)) to make it a script" : script.meta.match.join(", "),
            off ? "Disabled — enable it from the toolbar or the right-click menu" : "",
            "Double-click or F2 to rename",
        ].filter(Boolean).join("\n");

        if (health) li.classList.add("has-error");

        li.append(fileIcon("ts"), label);
        if (health) {
            const ind = document.createElement("span");
            ind.className = `err-ind ${health.kind}`;
            ind.textContent = "⚠";
            ind.title = health.tooltip;
            ind.setAttribute("role", "img");
            ind.setAttribute("aria-label", `${health.kind === "types" ? "type" : health.kind} error`);
            if (health.kind === "runtime") {
                ind.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    await send({ type: "clearScriptError", scriptId: script.id });
                });
            }
            li.append(ind);
        }
        li.append(delButton(r, "Delete script (Delete)"));
        // re-selecting would rebuild the list and swallow a double-click
        li.addEventListener("click", () => {
            moveExplorerFocus(script.id);
            if (script.id !== selectedId || typingsShown) select(script.id);
        });
        list.appendChild(li);
    }
}

/** indent guides (one per level) and the twistie: a chevron on folders (`open` = expanded) */
function treeIndent(depth: number, open?: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let i = 0; i < depth; i++) {
        const g = document.createElement("span");
        g.className = "indent-guide";
        g.style.setProperty("--level", String(i));
        out.push(g);
    }
    const tw = document.createElement("span");
    tw.className = "twistie" + (open === undefined ? "" : open ? " collapsible open" : " collapsible");
    tw.setAttribute("aria-hidden", "true");
    if (open !== undefined) tw.innerHTML = CHEVRON;
    out.push(tw);
    return out;
}

function fileIcon(kind: "ts" | "yaml" | "json" | "folder" | "folder-open"): HTMLElement {
    const el = document.createElement("span");
    el.className = `file-icon ${kind.startsWith("folder") ? "folder" : kind}`;
    if (kind === "folder" || kind === "folder-open") el.innerHTML = kind === "folder" ? FOLDER_ICON : FOLDER_OPEN_ICON;
    else el.textContent = kind === "ts" ? "TS" : kind === "json" ? "{}" : "⚙";
    el.setAttribute("aria-hidden", "true");
    return el;
}

async function setScriptEnabled(script: Script, enabled: boolean): Promise<void> {
    await send({ type: "setEnabled", id: script.id, enabled });
    await refresh();
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Delete with confirmation (a folder: everything in it); the explorer cursor moves to the next row. */
async function deleteRows(rows: TreeRow[]): Promise<void> {
    if (!rows.length) return;
    const dirs = rows.filter((r) => r.kind === "folder").map((r) => r.path);
    const inside = (path: string): boolean => dirs.some((d) => isInFolder(path, d));
    const chosen = new Set(rows.map((r) => r.id));
    const counts = (self: boolean): string[] =>
        [
            plural(scripts.filter((s) => (self && chosen.has(s.id)) || inside(s.meta.name)).length, "script"),
            plural(dataFiles.filter((d) => (self && chosen.has(d.id)) || inside(d.path)).length, "data file"),
            plural(everyFolder().filter((f) => (self && dirs.includes(f)) || inside(f)).length, "folder"),
        ].filter((c) => !c.startsWith("0 "));
    const one = rows[0];
    let question = `Delete "${one.path}"?`;
    if (rows.length > 1) question = `Delete these ${rows.length} items (${counts(true).join(", ")})?`;
    else if (one.kind === "folder") {
        const c = counts(false);
        question = c.length ? `Delete the folder "${one.path}" and everything in it (${c.join(", ")})?` : `Delete the folder "${one.path}"?`;
    }
    if (!confirm(question)) return;
    const cur = focusedId ?? selectedId;
    const gone = (id: string, path: string): boolean => chosen.has(id) || inside(path);
    if (cur && treeRow(cur) && gone(cur, treeRow(cur)!.path)) {
        const goneIds = new Set(visibleRows.filter((r) => gone(r.id, r.path)).map((r) => r.id));
        const ids = explorerIds();
        const i = ids.indexOf(cur);
        focusedId = ids.slice(i + 1).find((id) => !goneIds.has(id)) ?? ids.slice(0, Math.max(i, 0)).reverse().find((id) => !goneIds.has(id)) ?? null;
    }
    clearExplorerSel();
    for (const row of rows) {
        const r =
            row.kind === "script"
                ? await send({ type: "deleteScript", id: row.id })
                : row.kind === "data"
                  ? await send({ type: "deleteDataFile", id: row.id })
                  : await send({ type: "deleteFolder", path: row.path });
        if (r?.error) status(`can't delete "${row.path}": ${r.error}`, "error");
    }
    await refresh();
}

/** Editor toolbar switch: enable/disable the open script (hidden for settings.yaml, data files and libraries). */
function updateEnabledToggle(): void {
    const label = $("#script-enabled");
    const script = typingsShown ? undefined : scripts.find((s) => s.id === selectedId);
    label.hidden = !script || script.meta.active === false;
    if (!script) return;
    label.querySelector(".switch")!.classList.toggle("on", !!script.enabled);
    label.setAttribute("aria-checked", String(!!script.enabled));
}

// ---- explorer: keyboard navigation + context menu (VS Code style) ----
const explorerIds = (): string[] => [SETTINGS_ID, ...visibleRows.map((r) => r.id)];

function focusExplorer(): void {
    if ($("#app").classList.contains("sidebar-hidden")) setSidebarHidden(false);
    const list = $("#script-list");
    const section = $("#explorer-section");
    if (section.getAttribute("aria-expanded") === "false") toggleExplorerSection();
    list.focus();
    moveExplorerFocus(focusedId ?? selectedId ?? SETTINGS_ID);
}

/** Move the keyboard cursor in place — a list rebuild would swallow a double-click. */
function moveExplorerFocus(id: string): void {
    focusedId = id;
    const list = $("#script-list");
    const multi = explorerSel.size > 1;
    for (const li of list.querySelectorAll<HTMLElement>("li.script-item")) {
        const on = li.dataset.id === id;
        li.classList.toggle("focused", on);
        const sel = multi && explorerSel.has(li.dataset.id!);
        li.classList.toggle("multi", sel);
        li.setAttribute("aria-selected", String(sel || li.classList.contains("selected")));
        if (on) {
            list.setAttribute("aria-activedescendant", li.id);
            li.scrollIntoView({ block: "nearest" });
        }
    }
}

/** the ids a multi-selection can hold (settings.yaml isn't one) */
const selectableIds = (): string[] => visibleRows.map((r) => r.id);

function clearExplorerSel(): void {
    explorerSel = new Set();
    selAnchor = null;
}

/** Shift-click / Shift+↑↓: select from the anchor (default: the cursor) to `id`; `add` keeps what was selected */
function selectExplorerRange(id: string, add = false): void {
    const cur = focusedId ?? selectedId;
    const anchor = selAnchor ?? (cur && cur !== SETTINGS_ID ? cur : id);
    explorerSel = new Set([...(add ? explorerSel : []), ...idRange(selectableIds(), anchor, id)]);
    selAnchor = anchor;
    moveExplorerFocus(id);
}

/** ⌘/Ctrl-click: add `id` to the selection (with the cursor row, when starting one) or take it out */
function toggleExplorerSel(id: string): void {
    const cur = focusedId ?? selectedId;
    if (explorerSel.size < 2) explorerSel = new Set(cur && cur !== SETTINGS_ID && treeRow(cur) ? [cur] : []);
    if (explorerSel.has(id)) explorerSel.delete(id);
    else explorerSel.add(id);
    selAnchor = id;
    moveExplorerFocus(id);
}

/** what an action on row `id` applies to: the multi-selection when `id` is in it (not what's inside its selected folders), else that row */
function actionRows(id: string): TreeRow[] {
    if (explorerSel.size > 1 && explorerSel.has(id)) return topLevelRows(treeRows(true).filter((r) => explorerSel.has(r.id)));
    const row = treeRow(id);
    return row ? [row] : [];
}

function renameInExplorer(id: string): void {
    const row = treeRow(id);
    const label = row && $("#script-list").querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"] .script-name`);
    if (label) startRename(label, row!, true);
}

/** the path the explorer's Copy Path copies (a script's is its file's) */
const rowFilePath = (row: TreeRow): string => (row.kind === "script" ? scriptFileName(row.path) : row.path);

type NewKind = "script" | "data" | "folder";

function newItemsMenu(folder: string): MenuItem[] {
    return [
        { label: "New Script…", run: () => startCreate("script", folder) },
        { label: "New JSON File…", run: () => startCreate("data", folder) },
        { label: "New Folder…", run: () => startCreate("folder", folder) },
    ];
}

function setupExplorer(): void {
    const list = $("#script-list");
    list.addEventListener("keydown", (e) => {
        if (e.target !== list) return; // the inline rename input handles its own keys
        const ids = explorerIds();
        const cur = focusedId ?? selectedId ?? ids[0];
        const i = Math.max(0, ids.indexOf(cur));
        const row = cur === SETTINGS_ID ? undefined : visibleRows.find((r) => r.id === cur);
        const mod = e.metaKey || e.ctrlKey;
        const plain = !mod && !e.altKey && !e.shiftKey;
        let handled = true;
        const nav: Record<string, string> = { ArrowDown: ids[Math.min(i + 1, ids.length - 1)], ArrowUp: ids[Math.max(i - 1, 0)], Home: ids[0], PageUp: ids[0], End: ids[ids.length - 1], PageDown: ids[ids.length - 1] };
        if (e.key in nav && e.shiftKey && !mod && nav[e.key] !== SETTINGS_ID) selectExplorerRange(nav[e.key]);
        else if (e.key in nav) {
            clearExplorerSel();
            moveExplorerFocus(nav[e.key]);
        } else if (e.key.toLowerCase() === "a" && mod && !e.shiftKey && !e.altKey) {
            explorerSel = new Set(selectableIds());
            moveExplorerFocus(cur);
        } else if (e.key === "ArrowRight" && plain) {
            // expand, or (expanded) go to the first child
            if (row?.kind === "folder" && !row.expanded) setFolderExpanded(row.path, true);
            else if (row?.kind === "folder" && (visibleRows.find((r) => r.id === ids[i + 1])?.depth ?? -1) > row.depth) moveExplorerFocus(ids[i + 1]);
        } else if (e.key === "ArrowLeft" && plain) {
            // collapse, or go to the parent folder
            if (row?.kind === "folder" && row.expanded) setFolderExpanded(row.path, false);
            else if (row && folderOf(row.path)) moveExplorerFocus(folderRowId(folderOf(row.path)));
        } else if ((e.key === "Enter" || e.key === " ") && !mod) {
            if (row?.kind === "folder") setFolderExpanded(row.path, !row.expanded);
            else {
                if (cur !== selectedId || typingsShown) select(cur);
                if (e.key === "Enter") editor?.focus(); // Enter opens and focuses, Space just opens (preview)
            }
        } else if (e.key === "F2" && row) renameInExplorer(cur);
        else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && row) void deleteRows(actionRows(cur));
        else if (e.key === "Escape" && explorerSel.size > 1) {
            clearExplorerSel();
            moveExplorerFocus(cur);
        } else if (e.key === "Escape") editor?.focus();
        else handled = false;
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    });
    // explorer rows aren't focusable themselves: a click focuses the tree
    list.addEventListener("mousedown", (e) => {
        if (!(e.target as HTMLElement).closest("input")) setTimeout(() => list.focus());
    });
    // ⌘/Ctrl-click and Shift-click select (without opening); a plain click selects just its row
    list.addEventListener(
        "click",
        (e) => {
            const target = e.target as HTMLElement;
            if (target.closest("input, .btn-del, .err-ind")) return;
            const id = target.closest<HTMLElement>("li.script-item:not(.creating)")?.dataset.id;
            if (!id) return;
            const mod = e.metaKey || e.ctrlKey;
            if (id !== SETTINGS_ID && (mod || e.shiftKey)) {
                e.stopPropagation();
                e.preventDefault();
                if (e.shiftKey) selectExplorerRange(id, mod);
                else toggleExplorerSel(id);
                return;
            }
            explorerSel = new Set(id === SETTINGS_ID ? [] : [id]);
            selAnchor = null;
        },
        true,
    );
    list.addEventListener("contextmenu", (e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        const li = (e.target as HTMLElement).closest<HTMLElement>("li.script-item");
        const id = li?.dataset.id;
        if (!(id && explorerSel.size > 1 && explorerSel.has(id))) clearExplorerSel();
        if (id && explorerSel.size > 1) {
            // on a multi-selection: what applies to all of it
            moveExplorerFocus(id);
            const rows = actionRows(id);
            const paths = rows.map(rowFilePath).join("\n");
            showContextMenu(e.clientX, e.clientY, [
                { label: "Copy Paths", run: () => void navigator.clipboard?.writeText(paths).then(() => status(`copied ${plural(rows.length, "path")}`)) },
                null,
                { label: `Delete ${rows.length} Items`, key: "Delete", run: () => void deleteRows(rows) },
            ]);
            return;
        }
        if (!id || id === SETTINGS_ID) {
            // settings.yaml and the empty space below the tree: the root
            if (id) moveExplorerFocus(id);
            showContextMenu(e.clientX, e.clientY, [...(id ? [{ label: "Open", key: "Enter", run: () => (id !== selectedId || typingsShown) && select(id) }, null] : []), ...newItemsMenu("")]);
            return;
        }
        const row = treeRow(id);
        if (!row) return;
        moveExplorerFocus(id);
        const script = row.kind === "script" ? scripts.find((s) => s.id === id) : undefined;
        const isLib = script?.meta.active === false;
        showContextMenu(e.clientX, e.clientY, [
            ...(row.kind === "folder" ? [] : [{ label: "Open", key: "Enter", run: () => (id !== selectedId || typingsShown) && select(id) }, null]),
            ...(script && !isLib ? [{ label: script.enabled ? "Disable" : "Enable", run: () => void setScriptEnabled(script, !script.enabled) }, null] : []),
            ...newItemsMenu(targetFolder(row)),
            null,
            { label: "Copy Path", run: () => void navigator.clipboard?.writeText(rowFilePath(row)).then(() => status(`copied ${rowFilePath(row)}`)) },
            null,
            { label: "Rename…", key: "F2", run: () => renameInExplorer(id) },
            { label: "Delete", key: "Delete", run: () => void deleteRows([row]) },
        ]);
    });
    setupExplorerDnd(list);
    const action = (sel: string, run: () => void): void =>
        $(sel).addEventListener("click", (e) => {
            e.stopPropagation(); // not a click on the section header
            run();
        });
    action("#btn-new", () => startCreate("script"));
    action("#btn-new-json", () => startCreate("data"));
    action("#btn-new-folder", () => startCreate("folder"));
    action("#btn-collapse-all", collapseAll);
    $("#explorer-section").addEventListener("click", toggleExplorerSection);
    $("#script-enabled").addEventListener("click", (e) => {
        e.preventDefault();
        const script = scripts.find((s) => s.id === selectedId);
        if (script) void setScriptEnabled(script, !script.enabled);
    });
}

/** Drag rows (a multi-selection: all of it) onto a folder (or a file in it), or below the tree for the root, to move them. */
function setupExplorerDnd(list: HTMLElement): void {
    let dragged: TreeRow[] = [];
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverId = "";
    const rowAt = (e: DragEvent): TreeRow | undefined => {
        const id = (e.target as HTMLElement).closest?.<HTMLElement>("li.script-item")?.dataset.id;
        return id && id !== SETTINGS_ID ? visibleRows.find((r) => r.id === id) : undefined;
    };
    /** the folder the drop lands in, or null when it can't go there */
    const dropFolder = (e: DragEvent): string | null => {
        if (!dragged.length) return null;
        const folder = targetFolder(rowAt(e));
        return dropPlan(dragged, folder) ? folder : null;
    };
    const mark = (folder: string | null): void => {
        list.classList.toggle("drop-root", folder === "");
        for (const li of list.querySelectorAll<HTMLElement>("li.script-item")) {
            const r = visibleRows.find((x) => x.id === li.dataset.id);
            li.classList.toggle("drop-target", !!folder && !!r && ((r.kind === "folder" && r.path === folder) || isInFolder(r.path, folder)));
        }
    };
    const stopHover = (): void => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = null;
        hoverId = "";
    };
    list.addEventListener("dragstart", (e) => {
        const id = (e.target as HTMLElement).closest?.<HTMLElement>("li.script-item")?.dataset.id;
        const r = id ? visibleRows.find((x) => x.id === id) : undefined;
        if (!r || renaming) {
            e.preventDefault();
            return;
        }
        dragged = actionRows(r.id);
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", dragged.map(rowFilePath).join("\n"));
        if (dragged.length > 1) {
            const ghost = Object.assign(document.createElement("div"), { className: "drag-ghost", textContent: `${dragged.length} items` });
            document.body.append(ghost);
            e.dataTransfer!.setDragImage(ghost, -8, -8);
            setTimeout(() => ghost.remove());
        }
    });
    list.addEventListener("dragover", (e) => {
        const folder = dropFolder(e);
        mark(folder);
        // hovering a collapsed folder opens it
        const r = rowAt(e);
        if (r?.kind === "folder" && !r.expanded && dragged.length) {
            if (hoverId !== r.id) {
                stopHover();
                hoverId = r.id;
                hoverTimer = setTimeout(() => setFolderExpanded(r.path, true), 600);
            }
        } else stopHover();
        if (folder === null) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
    });
    list.addEventListener("dragleave", (e) => {
        if (!list.contains(e.relatedTarget as Node)) {
            mark(null);
            stopHover();
        }
    });
    list.addEventListener("drop", (e) => {
        const folder = dropFolder(e);
        const plan = folder === null ? null : dropPlan(dragged, folder);
        dragged = [];
        mark(null);
        stopHover();
        if (!plan) return;
        e.preventDefault();
        void moveRows(plan);
    });
    list.addEventListener("dragend", () => {
        dragged = [];
        mark(null);
        stopHover();
    });
}

function toggleExplorerSection(): void {
    const section = $("#explorer-section");
    section.setAttribute("aria-expanded", String(section.getAttribute("aria-expanded") === "false"));
}

type MenuItem = { label: string; key?: string; run: () => void } | null;

function showContextMenu(x: number, y: number, items: MenuItem[]): void {
    document.querySelector(".ctx-menu")?.remove();
    const menu = document.createElement("ul");
    menu.className = "ctx-menu";
    menu.setAttribute("role", "menu");
    const close = (): void => {
        menu.remove();
        document.removeEventListener("mousedown", outside, true);
        document.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", close);
    };
    const outside = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
            $("#script-list").focus();
        }
    };
    for (const item of items) {
        const li = document.createElement("li");
        if (!item) li.className = "sep";
        else {
            li.setAttribute("role", "menuitem");
            const label = document.createElement("span");
            label.textContent = item.label;
            li.append(label);
            if (item.key) li.append(Object.assign(document.createElement("span"), { className: "key", textContent: item.key }));
            li.addEventListener("click", () => {
                close();
                item.run();
            });
        }
        menu.appendChild(li);
    }
    document.body.appendChild(menu);
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 4)}px`;
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
}

const KIND_TITLE: Record<NewKind, string> = {
    script: 'The name is also the file name: any characters except < > : " \\ | ? * — a / puts the script in a folder (e.g. mock/helpers)',
    data: "A .json data file — a / puts it in a folder (e.g. mock/users.json)",
    folder: "A folder — a / makes nested folders (e.g. mock/api)",
};

/** an inline name input (rename / new item) that strips forbidden characters as you type */
function nameInput(kind: NewKind, value: string): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "script-rename";
    input.value = value;
    input.maxLength = MAX_PATH;
    input.title = KIND_TITLE[kind];
    input.spellcheck = false;
    input.addEventListener("input", () => {
        const clean = cleanScriptName(input.value);
        if (clean === input.value) return;
        const pos = Math.max(0, (input.selectionStart ?? clean.length) - (input.value.length - clean.length));
        input.value = clean;
        input.setSelectionRange(pos, pos);
        input.classList.add("rejected");
        setTimeout(() => input.classList.remove("rejected"), 300);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    return input;
}

/** Enter/blur commits, Escape cancels — `finish` runs once */
function onInputDone(input: HTMLInputElement, finish: (commit: boolean) => void): void {
    let done = false;
    const end = (commit: boolean): void => {
        if (done) return;
        done = true;
        finish(commit);
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") end(true);
        else if (e.key === "Escape") end(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
    });
    input.addEventListener("blur", () => end(true));
}

/** why `path` can't be the new path of a `kind` item (other than `selfId`), or "" */
function itemPathProblem(kind: NewKind, path: string, selfId?: string): string {
    if (kind === "script") {
        const problem = scriptNameProblem(path);
        if (problem) return problem;
        const clash = scripts.find((s) => s.id !== selfId && fsBridge.fileNameFor(s.id, s.meta.name).toLowerCase() === fsBridge.fileNameFor(selfId ?? "", path).toLowerCase());
        return clash ? `a script named "${clash.meta.name}" already exists` : "";
    }
    if (kind === "data") {
        const problem = dataFilePathProblem(path);
        if (problem) return problem;
        return dataFiles.some((d) => d.id !== selfId && d.path.toLowerCase() === path.toLowerCase()) ? `"${path}" already exists` : "";
    }
    return folderPathProblem(path) || (everyFolder().some((f) => f.toLowerCase() === path.toLowerCase()) ? `the folder "${path}" already exists` : "");
}

const withJson = (path: string): string => (/\.json$/i.test(path) ? path : path + ".json");

/** Inline rename in the explorer (double-click a name, or F2); a / in the new name moves the item. */
function startRename(label: HTMLElement, row: TreeRow, refocusList = false): void {
    const kind: NewKind = row.kind;
    const current = row.kind === "script" ? cleanScriptName(row.path) + ".ts" : row.path;
    const input = nameInput(kind, current);
    label.replaceWith(input);
    renaming = true;
    input.focus();
    // select the name, not its folder or extension (as VS Code does)
    const start = current.lastIndexOf("/") + 1;
    const ext = kind === "script" ? 3 : kind === "data" && /\.json$/i.test(current) ? 5 : 0;
    input.setSelectionRange(start, current.length - ext);
    onInputDone(input, (commit) => {
        renaming = false;
        if (refocusList) $("#script-list").focus();
        let next = cleanScriptName(input.value).trim();
        if (kind === "script") next = next.replace(/\.ts$/i, "");
        if (kind === "data" && next) next = withJson(next);
        let problem = commit && next && next !== row.path ? itemPathProblem(kind, next, row.kind === "folder" ? undefined : row.id) : "";
        if (!problem && kind === "folder" && commit && isInFolder(next, row.path)) problem = "a folder can't move into itself";
        if (problem) status(`can't rename: ${problem}`, "error");
        if (!commit || !next || next === row.path || problem) {
            input.replaceWith(label);
            renderList(); // catch up on updates skipped while renaming
            return;
        }
        void moveRow(row, next);
    });
}

/** Rename or move a script, data file or folder (with its contents) to `to`. */
const moveRow = (row: TreeRow, to: string): Promise<void> => moveRows([{ item: row, to }]);

async function moveRows(plan: { item: TreeRow; to: string }[]): Promise<void> {
    for (const { item: row, to } of plan) {
        let r: any;
        if (row.kind === "script") {
            const script = scripts.find((s) => s.id === row.id);
            if (!script) continue;
            r = await send({ type: "saveScript", id: script.id, code: script.code, name: to });
            // an error with an id is a compile error: the script was still saved
            if (r?.error && r.id) {
                status("script error — see log", "error");
                r = null;
            }
        } else if (row.kind === "data") {
            r = await send({ type: "renameDataFile", id: row.id, path: to });
        } else {
            r = await send({ type: "renameFolder", from: row.path, to });
            if (!r?.error) {
                setCollapsed(movedCollapsed(collapsed, row.path, to));
                if (focusedId === row.id) focusedId = folderRowId(to);
                else if (focusedId && isFolderRowId(focusedId) && isInFolder(folderPathOfRowId(focusedId), row.path)) focusedId = folderRowId(movedPath(folderPathOfRowId(focusedId), row.path, to));
                if (explorerSel.delete(row.id)) explorerSel.add(folderRowId(to));
            }
        }
        if (r?.error) status(`can't move "${row.path}": ${r.error}`, "error");
        else revealInExplorer(to);
    }
    await refresh();
}

/**
 * New Script / New JSON File / New Folder: an inline name input in `folder`
 * (default: the focused folder, or the focused file's folder), as in VS Code.
 */
function startCreate(kind: NewKind, folder = targetFolder(treeRow(focusedId ?? selectedId))): void {
    if (renaming) return;
    if ($("#app").classList.contains("sidebar-hidden")) setSidebarHidden(false);
    const section = $("#explorer-section");
    if (section.getAttribute("aria-expanded") === "false") toggleExplorerSection();
    if (folder) {
        revealInExplorer(folder + "/");
    }
    renderList();
    const list = $("#script-list");
    const parent = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(folder ? folderRowId(folder) : SETTINGS_ID)}"]`);
    const depth = folder ? folder.split("/").length : 0;
    const li = document.createElement("li");
    li.className = "script-item creating";
    li.style.setProperty("--depth", String(depth));
    li.append(...treeIndent(depth, kind === "folder" ? false : undefined), fileIcon(kind === "script" ? "ts" : kind === "data" ? "json" : "folder"));
    const input = nameInput(kind, "");
    input.placeholder = kind === "script" ? "script name" : kind === "data" ? "name.json" : "folder name";
    li.append(input);
    if (parent) parent.after(li);
    else list.prepend(li);
    renaming = true;
    input.focus();
    li.scrollIntoView({ block: "nearest" });
    onInputDone(input, (commit) => {
        renaming = false;
        li.remove();
        let name = cleanScriptName(input.value).trim();
        if (kind === "script") name = name.replace(/\.ts$/i, "");
        if (kind === "data" && name) name = withJson(name);
        if (!commit || !name) {
            renderList();
            list.focus();
            return;
        }
        void createItem(kind, joinPath(folder, name));
    });
}

async function createItem(kind: NewKind, path: string): Promise<void> {
    const problem = itemPathProblem(kind, path);
    if (problem) {
        status(`can't create "${path}": ${problem}`, "error");
        renderList();
        return;
    }
    revealInExplorer(path);
    if (kind === "script") {
        const id = uuid();
        await send({ type: "saveScript", id, code: STARTER_TEMPLATE, name: path });
        await refresh();
        select(id);
        editor?.focus();
    } else if (kind === "data") {
        const r = await send({ type: "saveDataFile", path, text: "{}\n" });
        if (r?.error || !r?.id) {
            status(`can't create "${path}": ${r?.error ?? "unknown error"}`, "error");
            return;
        }
        await refresh();
        select(r.id);
        editor?.focus();
    } else {
        const r = await send({ type: "createFolder", path });
        if (r?.error) {
            status(`can't create "${path}": ${r.error}`, "error");
            return;
        }
        focusedId = folderRowId(path);
        await refresh();
        $("#script-list").focus();
    }
}

// ---- TypeScript diagnostics → script error state ----
/** last report per script, so unchanged diagnostics aren't re-sent */
const reportedDiag = new Map<string, string>();
let diagTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Report each script's TypeScript errors (from the editor's TS worker) to
 * the background — only while the model holds the SAVED code, so typing
 * doesn't flood the log; the background logs new ones and badges the script.
 */
function scheduleDiagnostics(): void {
    if (diagTimer) clearTimeout(diagTimer);
    diagTimer = setTimeout(() => {
        diagTimer = null;
        const monaco = (window as any).monaco;
        if (!monaco) return;
        for (const s of scripts) {
            const m = models.get(s.id);
            if (!m || m.isDisposed?.() || m.getValue() !== s.code) continue;
            // a compile failure is already badged + logged; don't echo its syntax errors
            const errors = s.error ? [] : monaco.editor
                .getModelMarkers({ resource: m.uri, owner: "typescript" })
                .filter((mk: any) => mk.severity === monaco.MarkerSeverity.Error)
                .sort((a: any, b: any) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)
                .map((mk: any) => `line ${mk.startLineNumber}: ${String(mk.message).split("\n")[0]}`);
            const key = JSON.stringify(errors);
            if (reportedDiag.get(s.id) === key && JSON.stringify(s.typeErrors || []) === key) continue;
            reportedDiag.set(s.id, key);
            void send({ type: "scriptTypeErrors", scriptId: s.id, name: s.meta.name, errors });
        }
    }, 600);
}

// ---- re-check importers when a utility changes ----
const changedModels = new Set<any>();
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDependantRecheck(m: any): void {
    changedModels.add(m);
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
        recheckTimer = null;
        const changed = [...changedModels];
        changedModels.clear();
        const live = [...models.entries()]
            .filter(([, x]) => !x.isDisposed?.())
            .map(([id, x]) => ({ id, model: x, name: scripts.find((s) => s.id === id)?.meta.name ?? "", code: x.getValue() }));
        const targets = new Set<any>();
        for (const c of changed) {
            const src = live.find((x) => x.model === c);
            if (!src) continue;
            for (const id of dependantsOf(src.name, live)) {
                const t = live.find((x) => x.id === id)!.model;
                if (t !== c) targets.add(t);
            }
        }
        for (const t of targets) void revalidateModel(t);
    }, 500);
}

/** what Monaco's TS diagnostics adapter does on an edit, for a model that wasn't edited */
async function revalidateModel(m: any): Promise<void> {
    const monaco = (window as any).monaco;
    try {
        const worker = await (await monaco.languages.typescript.getTypeScriptWorker())(m.uri);
        const uri = m.uri.toString();
        const diags = [...(await worker.getSyntacticDiagnostics(uri)), ...(await worker.getSemanticDiagnostics(uri))];
        if (m.isDisposed()) return;
        const flatten = (t: any): string => (typeof t === "string" ? t : [t.messageText, ...(t.next || []).map(flatten)].join("\n  "));
        const sev = (c: number) => (c === 1 ? monaco.MarkerSeverity.Error : c === 0 ? monaco.MarkerSeverity.Warning : c === 2 ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Info);
        monaco.editor.setModelMarkers(
            m,
            "typescript",
            diags.map((d: any) => {
                const a = m.getPositionAt(d.start || 0);
                const b = m.getPositionAt((d.start || 0) + (d.length || 1));
                return {
                    severity: sev(d.category),
                    startLineNumber: a.lineNumber,
                    startColumn: a.column,
                    endLineNumber: b.lineNumber,
                    endColumn: b.column,
                    message: flatten(d.messageText),
                    code: String(d.code),
                };
            })
        );
    } catch {
        /* worker restarting / model gone — the next edit re-checks */
    }
}

// ---- editor ----
/** One Monaco model per script so `import "./utilities"` resolves across
 * the editor's virtual workspace (file:///<name>.ts per script). */
const models = new Map<string, any>();

/** Per-file cursor/scroll memory: view state is captured when a model is
 * switched away from and restored when the user comes back (VS Code-style,
 * in-memory for the session). */
const viewStates = new Map<string, any>();

function captureViewState(): void {
    if (!editor) return;
    const m = editor.getModel();
    if (m) viewStates.set(m.uri.toString(), editor.saveViewState());
}

function restoreViewState(m: any): void {
    const vs = viewStates.get(m.uri.toString());
    if (vs) editor.restoreViewState(vs);
}

function scriptUri(name: string): any {
    return (window as any).monaco.Uri.file("/" + scriptFileName(name));
}

function syncModels(): void {
    if (!editor) return;
    const monaco = (window as any).monaco;
    const seen = new Set<string>();
    for (const s of scripts) {
        seen.add(s.id);
        const uri = scriptUri(s.meta.name);
        let m = models.get(s.id);
        if (m && m.uri.toString() !== uri.toString()) {
            // renamed: move to a model at the new path, keeping any unsaved
            // text and the view state; re-point the editor BEFORE disposing
            // the old model, or it's left showing an empty disposed model
            // (and the next save writes "")
            const old = m;
            const oldUri = old.uri.toString();
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(old.getValue(), "typescript", uri);
            models.set(s.id, m);
            setBaseline(m, s.code);
            const vs = viewStates.get(oldUri);
            if (vs) viewStates.set(uri.toString(), vs);
            if (editor.getModel() === old) {
                const cur = editor.saveViewState();
                editor.setModel(m);
                if (cur) editor.restoreViewState(cur);
            }
            viewStates.delete(oldUri);
            baselines.delete(oldUri);
            old.dispose();
            scheduleDependantRecheck(m);
        }
        if (!m) {
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(s.code, "typescript", uri);
            models.set(s.id, m);
            setBaseline(m, s.code);
            // a script checked before this library existed (import, folder
            // sync) still says "Cannot find module" — re-check its importers
            scheduleDependantRecheck(m);
        } else if (m.getValue() !== s.code && !(s.id === selectedId && dirty)) {
            applyingExternal = true;
            m.setValue(s.code);
            applyingExternal = false;
            setBaseline(m, s.code);
        }
    }
    for (const [id, m] of models) {
        if (!seen.has(id)) {
            viewStates.delete(m.uri.toString());
            baselines.delete(m.uri.toString());
            m.dispose();
            models.delete(id);
        }
    }
}

// ---- data files: one JSON model each, at file:///<path> ----
const dataModels = new Map<string, any>();
let dataTypingsTimer: ReturnType<typeof setTimeout> | null = null;

const dataUri = (path: string): any => (window as any).monaco.Uri.file("/" + path);
const isDataId = (id: string | null): boolean => !!id && dataFiles.some((d) => d.id === id);

/** syncModels for data files: renamed ones move, clean ones follow external changes, deleted ones go */
function syncDataModels(): void {
    if (!editor) return;
    const monaco = (window as any).monaco;
    const seen = new Set<string>();
    for (const d of dataFiles) {
        seen.add(d.id);
        const uri = dataUri(d.path);
        let m = dataModels.get(d.id);
        if (m && m.uri.toString() !== uri.toString()) {
            const old = m;
            const oldUri = old.uri.toString();
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(old.getValue(), "json", uri);
            dataModels.set(d.id, m);
            setBaseline(m, d.text);
            const vs = viewStates.get(oldUri);
            if (vs) viewStates.set(uri.toString(), vs);
            if (editor.getModel() === old) {
                const cur = editor.saveViewState();
                editor.setModel(m);
                if (cur) editor.restoreViewState(cur);
            }
            viewStates.delete(oldUri);
            baselines.delete(oldUri);
            old.dispose();
            m.onDidChangeContent(scheduleDataTypings);
        }
        if (!m) {
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(d.text, "json", uri);
            dataModels.set(d.id, m);
            setBaseline(m, d.text);
            m.onDidChangeContent(scheduleDataTypings);
        } else if (m.getValue() !== d.text && !(d.id === selectedId && dirty)) {
            applyingExternal = true;
            m.setValue(d.text);
            applyingExternal = false;
            setBaseline(m, d.text);
        }
    }
    for (const [id, m] of dataModels) {
        if (!seen.has(id)) {
            viewStates.delete(m.uri.toString());
            baselines.delete(m.uri.toString());
            m.dispose();
            dataModels.delete(id);
        }
    }
    updateDataTypings();
}

function scheduleDataTypings(): void {
    if (dataTypingsTimer) clearTimeout(dataTypingsTimer);
    dataTypingsTimer = setTimeout(() => {
        dataTypingsTimer = null;
        updateDataTypings();
    }, 400);
}

/** what TypeScript sees of each data file (a JSON import's type), unsaved edits included */
function updateDataTypings(): void {
    const shown = editor?.getModel();
    for (const uri of setDataFileTypings(dataFiles.map((d) => ({ path: d.path, text: dataModels.get(d.id)?.getValue() ?? d.text })))) {
        // a declaration Go to Definition opened as a model hides the new one from TypeScript
        const stale = (window as any).monaco.editor.getModel((window as any).monaco.Uri.parse(uri));
        if (stale && stale !== shown) stale.dispose();
    }
}

async function renderEditorEmpty(): Promise<void> {
    leaveTypings();
    $("#btn-save").setAttribute("disabled", "");
    if (editor) {
        editor.setModel(null);
    }
}

/** Programmatic editor update (select / external hot-reload). */
function setEditorValue(code: string): void {
    if (!editor) return;
    const m = selectedId ? (models.get(selectedId) ?? dataModels.get(selectedId)) : null;
    applyingExternal = true;
    if (m) {
        m.setValue(code);
        setBaseline(m, code);
    } else if (!typingsShown) editor.setValue(code);
    editor.clearHistory?.();
    applyingExternal = false;
    setDirty(false);
    status("");
}

/** Settings → Open button (vscode | vscode-insiders | custom | off) and the custom URL template. */
let launchMode: LaunchMode = "vscode";
let launchTemplate = "";

/** Enable ↗ only while folder sync is active and a script is selected (and a custom editor has a URL). */
function updateOpenVscode(): void {
    const b = $("#btn-open-vscode") as HTMLButtonElement;
    const off = launchMode === "off";
    b.style.display = off ? "none" : "";
    const app = launchAppName(launchMode);
    b.classList.toggle("insiders", launchMode === "vscode-insiders");
    b.classList.toggle("custom", launchMode === "custom");
    const noUrl = launchMode === "custom" && !launchTemplate.trim();
    b.title = noUrl ? "Set the editor URL in Settings → Open button" : `Open this script's synced file in ${app} (requires a synced folder)`;
    b.setAttribute("aria-label", `Open in ${app}`);
    if (!off && !noUrl && (window as any).__resSyncActive && selectedId && !typingsShown) b.removeAttribute("disabled");
    else b.setAttribute("disabled", "");
}

function selectReal(id: string): void {
    // back from the typings to the script under them: keep its unsaved edits
    const back = typingsShown && id === selectedId;
    leaveTypings();
    selectedId = id;
    focusedId = null;
    renderList();
    const script = scripts.find((s) => s.id === id);
    const data = script ? undefined : dataFiles.find((d) => d.id === id);
    if (!script && !data) return;
    $("#btn-save").removeAttribute("disabled");
    if (script) syncModels();
    else syncDataModels();
    const m = script ? models.get(id) : dataModels.get(id);
    if (m && editor.getModel() !== m) {
        captureViewState();
        editor.setModel(m);
        setDirty(false);
        status("");
        restoreViewState(m);
    } else {
        setEditorValue(script ? script.code : data!.text);
    }
    if (back) updateDirty();
    else setDirty(false);
    updateOpenVscode();
}

// ---- wt-api.d.ts, read-only (Go to Definition) ----
function typingsModel(): any {
    const monaco = (window as any).monaco;
    const uri = monaco.Uri.parse(API_TYPINGS_URI);
    // Monaco's TS mode may already have made one for a definition lookup
    return monaco.editor.getModel(uri) ?? monaco.editor.createModel(apiTypingsText(), "typescript", uri);
}

function showTypings(): void {
    if (typingsShown) return;
    captureViewState();
    typingsShown = true;
    const m = typingsModel();
    editor.setModel(m);
    editor.updateOptions({ readOnly: true, readOnlyMessage: { value: "wt-api.d.ts is the Wiretrick API typings — read-only" } });
    restoreViewState(m);
    $("#typings-note").hidden = false;
    $("#btn-save").setAttribute("disabled", "");
    $("#btn-save").classList.add("dim");
    renderList();
    updateOpenVscode();
}

/** Flip the Code view back to editable; the caller shows the next model. */
function leaveTypings(): void {
    if (!typingsShown) return;
    captureViewState();
    typingsShown = false;
    editor.updateOptions({ readOnly: false });
    $("#typings-note").hidden = true;
}

/** a place in the Code view: a script id / SETTINGS_ID / TYPINGS_ID + cursor and scroll */
interface NavEntry {
    target: string;
    view: any;
}
const TYPINGS_ID = "__wt_api_typings__";
const navHistory = new NavHistory<NavEntry>();

function currentPlace(): NavEntry | null {
    const target = typingsShown ? TYPINGS_ID : selectedId;
    return target && editor ? { target, view: editor.saveViewState() } : null;
}

/** Record the current place before a jump (Go to Definition). */
function pushNav(): void {
    const here = currentPlace();
    if (here) navHistory.push(here);
}

function revealSelection(selection?: IRange | IPosition): void {
    if (!selection) return;
    if ("startLineNumber" in selection) {
        editor.setSelection(selection);
        editor.revealRangeInCenter(selection);
    } else {
        editor.setPosition(selection);
        editor.revealPositionInCenter(selection);
    }
}

/** Show a declaration in wt-api.d.ts read-only. */
function openTypingsAt(selection?: IRange | IPosition): void {
    pushNav();
    showTypings();
    revealSelection(selection);
    editor.focus();
}

/** Go to a history entry: false = cancelled, "skip" = its script is gone. */
function openNavEntry(e: NavEntry): boolean | "skip" {
    const restore = (): void => {
        if (e.view) editor.restoreViewState(e.view);
        editor.focus();
    };
    if (e.target === TYPINGS_ID) {
        showTypings();
        restore();
        return true;
    }
    if (e.target !== SETTINGS_ID && !scripts.some((s) => s.id === e.target) && !isDataId(e.target)) return "skip";
    if (e.target !== selectedId && dirty && selectedId && !confirm("Discard unsaved changes?")) return false;
    if (e.target === SETTINGS_ID) {
        if (typingsShown || selectedId !== SETTINGS_ID) void selectSettings().then(restore);
        else restore();
        return true;
    }
    if (typingsShown || e.target !== selectedId) selectReal(e.target);
    restore();
    return true;
}

function navigateBack(): void {
    const here = currentPlace();
    if (here) navHistory.back(here, openNavEntry);
}

function navigateForward(): void {
    const here = currentPlace();
    if (here) navHistory.forward(here, openNavEntry);
}

// Saves run one at a time: a second ⌘S fired before the first returns must
// send the baseline the first one set, or it looks like a conflict.
let saveChain: Promise<void> = Promise.resolve();
function saveCurrent(): Promise<void> {
    const p = saveChain.then(saveCurrentNow);
    saveChain = p.catch(() => {});
    return p;
}

async function saveCurrentNow(): Promise<void> {
    if (typingsShown) return; // read-only
    if (selectedId === SETTINGS_ID) return saveSettings();
    if (!selectedId || !editor) return;
    if (isDataId(selectedId)) return saveDataFileNow(selectedId);
    const code = editor.getValue();
    const name = scripts.find((s) => s.id === selectedId)?.meta.name || "Untitled script";
    const id = selectedId;
    const m = models.get(id);
    const base = m ? baselines.get(m.uri.toString()) : undefined;
    setSaveState("saving");
    let result = await send({ type: "saveScript", id, code, name, base });
    if (result?.conflict) {
        const deleted = result.conflict === "deleted";
        const choice = await resolveConflict({ name, theirs: deleted ? null : result.code, mine: code });
        if (choice === "cancel") {
            updateDirty();
            return;
        }
        if (choice === "theirs") {
            if (!deleted && m) {
                applyingExternal = true;
                m.setValue(result.code);
                applyingExternal = false;
                setBaseline(m, result.code);
            }
            setDirty(false);
            await refresh();
            renderList();
            return;
        }
        result = await send({ type: "saveScript", id, code, name });
    }
    // a saved script comes back with an id; its `error` is a compile error
    // (shown on the script), not a failed save — the code is stored either way
    if (result && result.error && !result.id) {
        status(`save failed: ${result.error}`, "error");
    } else {
        status("");
        if (m) setBaseline(m, code); // the stored text is now the baseline
    }
    // edits typed while saving keep the file unsaved
    if (editor.getModel() === m) updateDirty();
    else setDirty(false);
    await refresh();
    renderList();
}

/** ⌘S on a data file: as a script's save, with the same conflict check */
async function saveDataFileNow(id: string): Promise<void> {
    const data = dataFiles.find((d) => d.id === id)!;
    const text = editor.getValue();
    const m = dataModels.get(id);
    const base = m ? baselines.get(m.uri.toString()) : undefined;
    setSaveState("saving");
    let result = await send({ type: "saveDataFile", id, text, base });
    if (result?.conflict) {
        const deleted = result.conflict === "deleted";
        const choice = await resolveConflict({ name: data.path, theirs: deleted ? null : result.text, mine: text, kind: "data file", language: "json" });
        if (choice === "cancel") {
            updateDirty();
            return;
        }
        if (choice === "theirs") {
            if (!deleted && m) {
                applyingExternal = true;
                m.setValue(result.text);
                applyingExternal = false;
                setBaseline(m, result.text);
            }
            setDirty(false);
            await refresh();
            return;
        }
        result = await send({ type: "saveDataFile", id, path: data.path, text });
    }
    if (!result || result.error) status(`save failed: ${result?.error ?? "no answer"}`, "error");
    else {
        status("");
        if (m) setBaseline(m, text);
    }
    if (editor.getModel() === m) updateDirty();
    else setDirty(false);
    await refresh();
}

// ---- helper strategy (local helper) ----
let helperStatus: HelperStatus | null = null;
function renderProcessStatus(st: any): void {
    helperStatus = st;
    if (!$("#settings-panel").classList.contains("hidden")) void renderAbout();
    const labels: Record<string, string> = {
        idle: "not needed — no enabled handler uses the \"helper\" strategy",
        unsupported: "unavailable in this browser (Chrome only) — handlers using \"helper\" don't run",
        connecting: "connecting…",
        ready: `running${st.version ? ` (v${st.version})` : ""}${st.port ? ` on 127.0.0.1:${st.port}` : ""}`,
        missing: "not installed",
        error: `error: ${st.error || "unknown"}`,
    };
    $("#process-state").textContent = labels[st.state] || st.state;
    const lines: string[] = [];
    if (st.scripts?.length) lines.push(`Scripts: ${st.scripts.join(", ")}`);
    if (st.state === "missing") {
        lines.push(`Install the helper: paste this into ${helperInstallShell()}, then click Retry:`);
        lines.push(`  ${helperInstallCommand(st.extensionId)}`);
    }
    if (st.state === "ready") {
        if (st.outdated) {
            lines.push(`⚠ The helper (v${st.version}) is older than this extension needs — upgrade it: paste this into ${helperInstallShell()}, then click Retry:`);
            lines.push(`  ${helperInstallCommand(st.extensionId)}`);
        }
        if (st.routing && !st.routing.active && st.routing.reason) lines.push(`Routing inactive: ${st.routing.reason}`);
        if (st.routing?.active) lines.push(`Other traffic: your proxy setting (${st.routing.mode})`);
        if (st.routing?.note) lines.push(st.routing.note);
        if (st.caTrusted === false) lines.push("Chrome does not trust the helper certificate yet — click Trust certificate (or run: wiretrick-helper trust-ca).");
        if (st.caTrusted === true) lines.push("Helper certificate trusted ✓");
        if (st.caFingerprint) lines.push(`Helper certificate: ${st.caPath} (SHA-256 ${st.caFingerprint})`);
    }
    if (st.trust) lines.push(`Trust certificate: ${st.trust.msg}`);
    $("#process-detail").textContent = lines.join("\n");
    ($("#btn-process-trust") as HTMLButtonElement).hidden = !(st.state === "ready" && st.caTrusted !== true);
    const copy = $("#btn-process-copy") as HTMLButtonElement;
    const needsInstall = st.state === "missing" || !!st.outdated;
    copy.hidden = !needsInstall;
    copy.dataset.cmd = needsInstall ? helperInstallCommand(st.extensionId) : "";
    ($("#btn-process-retry") as HTMLButtonElement).hidden = (st.state === "ready" && !st.outdated) || st.state === "idle" || st.state === "unsupported";
}

// ---- logs ----
function connectLogs(): void {
    const port = chrome.runtime.connect({ name: "logs" });
    port.onMessage.addListener((msg: any) => {
        if (msg.type === "log") appendLog(msg.entry);
        if (msg.type === "processStatus") renderProcessStatus(msg.status);
        if (msg.type === "scriptErrors") {
            for (const s of scripts) {
                s.runtimeError = msg.errors[s.id] ?? null;
                s.typeErrors = msg.typeErrors?.[s.id] ?? [];
                s.ruleErrors = msg.ruleErrors?.[s.id] ?? [];
                s.routeWarnings = msg.routeWarnings?.[s.id] ?? [];
            }
            renderList();
        }
        // background applied an external folder change (or any script
        // change) — refresh list + editor if untouched
        if (msg.type === "scriptsChanged") {
            void (async () => {
                await refresh();
                const updated = scripts.find((sc) => sc.id === selectedId);
                if (updated && !dirty) setEditorValue(updated.code);
                if (updated && dirty) status("script changed on disk — the Code view has unsaved edits", "dirty");
                const data = dataFiles.find((d) => d.id === selectedId);
                const m = data && dataModels.get(data.id);
                if (data && dirty && m && baselines.get(m.uri.toString()) !== data.text) status("data file changed on disk — the Code view has unsaved edits", "dirty");
            })();
        }
        if (msg.type === "sync") {
            renderFolderSync(msg.status);
            (window as any).__resSyncActive = msg.status.active;
            fsBridge.setCachedActive(msg.status.active);
            if (msg.status.active) {
                markFolderSynced();
            } else {
                const btn = $("#btn-vscode");
                btn.classList.remove("active");
                btn.textContent = "Scripts Folder…";
                $("#folder-state").textContent = "";
            }
        }
    });
}

let logFindRe: RegExp | null = null;
const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = 1; // info+
let logCap = 500; // rendered lines kept in the DOM
let logSource = ""; // source-tag filter text, "" = all

/** Extract the source tag of a message: "[pipeline] …" → "pipeline"; "console.log: …" → "console.log". */
function sourceOf(message: string): string {
    const bracket = message.match(/^\s*\[([^\]]*)\]/);
    if (bracket) return bracket[1];
    const dot = message.match(/^\s*([a-zA-Z0-9_.-]+):/);
    return dot ? dot[1] : "(untagged)";
}

/** Sources seen in the buffer — drives the autocomplete datalist. */
const logSources = new Set<string>();

function rememberSource(src: string): void {
    if (logSources.has(src)) return;
    logSources.add(src);
    const list = $("#log-source-options") as HTMLDataListElement;
    const o = document.createElement("option");
    o.value = src;
    list.appendChild(o);
}

function linePassesFilters(text: string, level: string, source: string): boolean {
    if ((LEVEL_ORDER[level] ?? 1) < minLevel) return false;
    if (logSource && !source.toLowerCase().includes(logSource.toLowerCase())) return false;
    if (logFindRe && !logFindRe.test(text)) return false;
    return true;
}

function renderLogLine(line: HTMLElement, text: string, level: string, source: string): void {
    line.dataset.text = text;
    line.dataset.level = level;
    line.dataset.source = source;
    line.innerHTML = "";
    if (!linePassesFilters(text, level, source)) {
        line.style.display = "none";
        return;
    }
    line.style.display = "";
    const timeEl = document.createElement("time");
    timeEl.textContent = text.match(/^\[[^\]]*\]/)?.[0] || "";
    line.appendChild(timeEl);
    const rest = text.replace(/^\[[^\]]*\]\s*/, "");
    line.dataset.body = rest;
    const badge = document.createElement("span");
    badge.className = "lv " + level;
    badge.textContent = level;
    line.appendChild(badge);
    void rest;
    if (logFindRe) {
        const m = text.match(logFindRe);
        if (m) {
            const idx = text.indexOf(m[0]);
            line.append(
                document.createTextNode(text.slice(0, idx)),
                Object.assign(document.createElement("mark"), { textContent: m[0] }),
                document.createTextNode(text.slice(idx + m[0].length))
            );
            return;
        }
    }
    line.appendChild(document.createTextNode(text));
}

// ---- Panel counts: Log errors/warnings and Network observed/modified
// requests, shown until that view is cleared ----
const logBadge = new LogBadge();
const netBadge = new NetBadge();
const problemsBadge = new ProblemsBadge();
let logBadgeEnabled = true;

/** The status bar's count for a view: visible even with the panel closed. */
function renderBadge(badge: TabBadge): void {
    document.body.classList.toggle("no-status", !logBadgeEnabled);
    const [sel, label] = badge === logBadge ? ["#sb-log", "Log (⌘J)"] : badge === problemsBadge ? ["#sb-problems", "Problems (⌘⇧M)"] : ["#sb-net", "Network"];
    const el = $(sel);
    for (const [cls, n] of badge.counts) {
        const count = el.querySelector<HTMLElement>(`.sb-n[data-k="${cls}"]`)!;
        count.textContent = badgeCount(n);
        count.parentElement!.classList.toggle("on", n > 0);
    }
    el.title = badge.empty ? label : `${label} — ${badge.title}`;
}

/** the status bar: every view's counts, and which view the panel shows */
function renderTabBadges(): void {
    renderBadge(problemsBadge);
    renderBadge(logBadge);
    renderBadge(netBadge);
    const open = !$("#app").classList.contains("panel-hidden") && $("#log-panel").dataset.tab;
    for (const item of document.querySelectorAll<HTMLElement>("#status-bar .sb-item")) {
        const on = item.dataset.panel === open;
        item.classList.toggle("active", on);
        item.setAttribute("aria-pressed", String(on));
    }
}

/** Network counts from a passive connection: live before the Network tab is ever opened. */
function watchNetCounts(): void {
    const store = createNetStore();
    effect(() => {
        netBadge.set(touchCounts(store.entries.value));
        renderBadge(netBadge);
    });
    store.connect(undefined, "network-counts");
}

// ---- Problems view: what is wrong with each script right now (VS Code's
// Problems). Entries go away by themselves once fixed; the Log keeps history. ----
let problemGroups: ProblemGroup[] = [];
let problemsTimer: ReturnType<typeof setTimeout> | null = null;
const collapsedProblems = new Set<string>();
/** models Monaco has published markers for: until then a script's stored (saved-code) type errors stand in */
const checkedUris = new Set<string>();

/** Coalesces, but never postpones: a stream of marker events (the TS worker
 *  checking script after script) can't hold the view back past 200 ms. */
function scheduleProblems(): void {
    if (problemsTimer) return;
    problemsTimer = setTimeout(() => {
        problemsTimer = null;
        updateProblems();
    }, 200);
}

function modelProblems(m: any): ProblemMarker[] {
    const { MarkerSeverity, editor: ed } = (window as any).monaco;
    return ed
        .getModelMarkers({ resource: m.uri })
        .filter((mk: any) => mk.owner !== PROBLEM_OWNER && (mk.severity === MarkerSeverity.Error || mk.severity === MarkerSeverity.Warning))
        .map((mk: any) => ({ severity: mk.severity === MarkerSeverity.Error ? "error" : "warning", message: String(mk.message), line: mk.startLineNumber, column: mk.startColumn }));
}

/** the owner of the markers for Wiretrick's own problems (compile, rules, runtime, route) */
const PROBLEM_OWNER = "wiretrick";
/** model → the problems its markers show */
const problemMarkerKeys = new WeakMap<any, string>();
/** URIs whose marker change is our own: not a sign TypeScript has checked them */
const ownMarkerWrites = new Set<string>();

function setProblemMarkers(m: any, markers: any[]): void {
    ownMarkerWrites.add(m.uri.toString());
    (window as any).monaco.editor.setModelMarkers(m, PROBLEM_OWNER, markers);
}

/**
 * Squiggles for the problems Monaco doesn't mark itself (TypeScript and
 * settings.yaml problems are its own markers). Markers, like TypeScript's,
 * so their hover comes before the API docs one. Their positions are in the
 * saved code, so a model with unsaved edits keeps the ones it has (they move
 * with the edits).
 */
function markProblems(): void {
    const monaco = (window as any).monaco;
    if (!monaco) return;
    const byId = new Map(problemGroups.map((g) => [g.id, g.problems]));
    for (const s of scripts) {
        const m = models.get(s.id);
        if (!m || m.isDisposed() || m.getValue() !== s.code) continue;
        const own = (byId.get(s.id) || []).filter((p) => p.kind !== "ts" && p.kind !== "settings" && p.line);
        const key = JSON.stringify(own.map((p) => [p.severity, p.message, p.line, p.column, p.endLine, p.endColumn]));
        if ((problemMarkerKeys.get(m) ?? "[]") === key) continue;
        problemMarkerKeys.set(m, key);
        setProblemMarkers(
            m,
            own.map((p) => {
                const line = Math.min(p.line!, m.getLineCount());
                const column = p.column ?? m.getLineFirstNonWhitespaceColumn(line) ?? 1;
                const endLine = Math.min(p.endLine ?? line, m.getLineCount());
                const endColumn = p.endColumn ?? Math.max(m.getLineLastNonWhitespaceColumn(endLine), column + 1);
                const severity = p.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning;
                return { severity, message: p.message, source: "Wiretrick", code: p.kind, startLineNumber: line, startColumn: column, endLineNumber: endLine, endColumn };
            })
        );
    }
}

function updateProblems(): void {
    const live = new Map<string, ProblemMarker[]>();
    const monaco = (window as any).monaco;
    if (monaco) {
        for (const s of scripts) {
            const m = models.get(s.id);
            if (!m || m.isDisposed()) continue;
            if (!checkedUris.has(m.uri.toString()) && m.getValue() === s.code && s.typeErrors?.length) continue;
            live.set(s.id, modelProblems(m));
        }
    }
    const settings = monaco && settingsModel && !settingsModel.isDisposed() ? modelProblems(settingsModel) : undefined;
    const data = monaco
        ? dataFiles.flatMap((d) => {
              const m = dataModels.get(d.id);
              return m && !m.isDisposed() ? [{ id: d.id, label: d.path, markers: modelProblems(m) }] : [];
          })
        : [];
    // explorer order (settings.yaml first)
    const order = new Map(treeRows(true).map((r, i) => [r.id, i]));
    problemGroups = collectProblems(
        scripts.map((s) => ({ id: s.id, label: scriptFileName(s.meta.name), error: s.error, ruleErrors: s.ruleErrors, runtimeError: s.runtimeError, typeErrors: s.typeErrors, routeWarnings: s.routeWarnings, routes: s.meta.routes, code: s.code })),
        live,
        settings,
        data
    ).sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
    const bad = new Set(problemGroups.filter((g) => g.file === "json" && g.problems.some((p) => p.severity === "error")).map((g) => g.id));
    if ([...bad].join() !== [...jsonErrorIds].join()) {
        jsonErrorIds = bad;
        renderList();
    }
    markProblems();
    problemsBadge.set(problemCounts(problemGroups));
    renderBadge(problemsBadge);
    renderProblems();
}

const ERROR_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" stroke-width="1.3"/></svg>`;
const WARN_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.5v3.5M8 11.5v.6" stroke="currentColor" stroke-width="1.3"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function pbSpan(cls: string, text = ""): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
}

function renderProblems(): void {
    const list = $("#problems-list");
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && list.contains(active) ? active.dataset.key : undefined;
    list.innerHTML = "";
    const groups = filterProblems(problemGroups, $input("#problems-filter").value);
    if (!groups.length) {
        list.append(pbSpan("problems-empty", problemGroups.length ? "No results found with the provided filter." : "No problems have been detected in the scripts."));
        return;
    }
    const row = (key: string, cls: string, level: number): HTMLDivElement => {
        const el = document.createElement("div");
        el.className = `pb-row ${cls}`;
        el.dataset.key = key;
        el.tabIndex = -1;
        el.setAttribute("role", "treeitem");
        el.setAttribute("aria-level", String(level));
        list.append(el);
        return el;
    };
    for (const g of groups) {
        const open = !collapsedProblems.has(g.id);
        const head = row(`g:${g.id}`, "pb-head" + (open ? " open" : ""), 1);
        head.dataset.group = g.id;
        head.setAttribute("aria-expanded", String(open));
        const chev = pbSpan("pb-chev");
        chev.innerHTML = CHEVRON;
        const counts = problemCounts([g]);
        head.append(chev, pbSpan(`file-icon ${g.file}`, g.file === "ts" ? "TS" : g.file === "json" ? "{}" : "⚙"), pbSpan("pb-file", g.label), pbSpan("pb-count", badgeCount(g.problems.length)));
        head.title = `${g.label}: ${[counts.errors && `${counts.errors} error${counts.errors > 1 ? "s" : ""}`, counts.warnings && `${counts.warnings} warning${counts.warnings > 1 ? "s" : ""}`].filter(Boolean).join(", ")}`;
        head.addEventListener("click", () => toggleProblemGroup(g.id));
        if (!open) continue;
        g.problems.forEach((p, i) => {
            const el = row(`p:${g.id}:${i}`, `pb-item ${p.severity === "error" ? "error" : "warn"}`, 2);
            el.dataset.group = g.id;
            const ico = pbSpan(`pb-ico ${p.severity === "error" ? "error" : "warn"}`);
            ico.innerHTML = p.severity === "error" ? ERROR_ICON : WARN_ICON;
            ico.setAttribute("role", "img");
            ico.setAttribute("aria-label", p.severity);
            el.append(ico, pbSpan("pb-msg", p.message.split("\n")[0]), pbSpan("pb-src", p.kind));
            if (p.line) el.append(pbSpan("pb-pos", `[Ln ${p.line}${p.column ? `, Col ${p.column}` : ""}]`));
            if (p.dismissible) {
                const x = document.createElement("button");
                x.className = "pb-dismiss";
                x.textContent = "✕";
                x.title = "Dismiss this runtime error (saving the script clears it too)";
                x.setAttribute("aria-label", "Dismiss");
                x.tabIndex = -1;
                x.addEventListener("click", (e) => {
                    e.stopPropagation();
                    void send({ type: "clearScriptError", scriptId: g.id });
                });
                el.append(x);
            }
            el.title = `${p.message}\n\n${g.label}${p.line ? ` [Ln ${p.line}${p.column ? `, Col ${p.column}` : ""}]` : ""} · ${p.kind}`;
            el.addEventListener("click", () => void openProblem(g.id, p));
            el.addEventListener("dblclick", () => editor?.focus());
        });
    }
    const rows = [...list.querySelectorAll<HTMLElement>(".pb-row")];
    const target = (focusKey && rows.find((r) => r.dataset.key === focusKey)) || rows[0];
    target.tabIndex = 0;
    if (focusKey) target.focus();
}

function toggleProblemGroup(id: string, open?: boolean): void {
    const want = open ?? collapsedProblems.has(id);
    if (want) collapsedProblems.delete(id);
    else collapsedProblems.add(id);
    renderProblems();
    const head = [...$("#problems-list").querySelectorAll<HTMLElement>(".pb-head")].find((h) => h.dataset.group === id);
    if (head) focusProblemRow(head);
}

function focusProblemRow(el: HTMLElement): void {
    for (const r of $("#problems-list").querySelectorAll<HTMLElement>(".pb-row")) r.tabIndex = -1;
    el.tabIndex = 0;
    el.focus();
}

/** Open the problem's file (like an explorer click) and put the cursor on it. */
async function openProblem(id: string, p: Problem): Promise<void> {
    if (!editor) return;
    if (p.line) pushNav();
    if (id !== selectedId || typingsShown) {
        await select(id);
        if (id !== selectedId || typingsShown) return; // kept the unsaved edits
    }
    if (p.line) {
        const pos = { lineNumber: p.line, column: p.column ?? 1 };
        editor.setPosition(pos);
        editor.revealPositionInCenterIfOutsideViewport(pos);
    }
    editor.focus();
}

function setupProblemsView(): void {
    const list = $("#problems-list");
    $input("#problems-filter").addEventListener("input", () => renderProblems());
    list.addEventListener("keydown", (e) => {
        const rows = [...list.querySelectorAll<HTMLElement>(".pb-row")];
        const cur = (e.target as HTMLElement).closest<HTMLElement>(".pb-row");
        if (!cur || !rows.length) return;
        const i = rows.indexOf(cur);
        const head = cur.classList.contains("pb-head");
        let next: HTMLElement | undefined;
        if (e.key === "ArrowDown") next = rows[Math.min(rows.length - 1, i + 1)];
        else if (e.key === "ArrowUp") next = rows[Math.max(0, i - 1)];
        else if (e.key === "Home") next = rows[0];
        else if (e.key === "End") next = rows[rows.length - 1];
        else if (head && (e.key === "ArrowLeft" || e.key === "ArrowRight")) toggleProblemGroup(cur.dataset.group!, e.key === "ArrowRight");
        else if (!head && e.key === "ArrowLeft") next = rows.slice(0, i).reverse().find((r) => r.classList.contains("pb-head"));
        else if (e.key === "Enter" || e.key === " ") cur.click();
        else return;
        e.preventDefault();
        if (next) focusProblemRow(next);
    });
}

/** ⌘⇧M: show the Problems view (and focus it), or close the panel when it's already showing it. */
function toggleProblems(): void {
    if (!$("#app").classList.contains("panel-hidden") && $("#log-panel").dataset.tab === "problems") {
        setPanelHidden(true);
        return;
    }
    setPanelHidden(false);
    showPanelTab("problems");
    const row = $("#problems-list").querySelector<HTMLElement>('.pb-row[tabindex="0"]');
    if (row) row.focus();
    else $input("#problems-filter").focus();
}

/** All received entries — filtered ones stay here (re-renderable), just not in the DOM. */
const logEntries: { text: string; level: string; source: string; observed?: boolean }[] = [];
/** "observed (no change)" DEBUG lines (one per handler run) may fill at most this much of the buffer */
const MAX_OBSERVED_ENTRIES = 300;
let observedEntries = 0;

function appendLog(entry: any): void {
    const time = new Date(entry.at).toLocaleTimeString();
    const source = sourceOf(entry.message || "");
    const observed = entry.kind === "observed";
    logEntries.push({ text: `[${time}] ${entry.message}`, level: entry.level || "info", source, ...(observed ? { observed } : {}) });
    logBadge.note(entry.level || "info");
    let counted = entry.level === "error" || entry.level === "warn";
    if (observed && ++observedEntries > MAX_OBSERVED_ENTRIES) {
        logEntries.splice(logEntries.findIndex((e) => e.observed), 1);
        observedEntries--;
    }
    if (logEntries.length > 2000) {
        // absolute buffer cap
        for (const e of logEntries.splice(0, logEntries.length - 2000)) {
            if (e.observed) observedEntries--;
            logBadge.drop(e.level);
            counted ||= e.level === "error" || e.level === "warn";
        }
    }
    if (counted) renderTabBadges();
    rememberSource(source);

    const text = logEntries[logEntries.length - 1].text;
    const level = logEntries[logEntries.length - 1].level;
    if (!linePassesFilters(text, level, source)) return; // don't let hidden entries churn the DOM ring

    const box = $("#log-entries");
    const line = document.createElement("div");
    line.className = "log-line " + level;
    renderLogLine(line, text, level, source);
    box.appendChild(line);
    while (box.children.length > logCap) box.removeChild(box.firstChild as Node);
    box.scrollTop = box.scrollHeight;
}

function refilterLog(): void {
    const box = $("#log-entries");
    box.innerHTML = "";
    for (const { text, level, source } of logEntries) {
        if (!linePassesFilters(text, level, source)) continue;
        const line = document.createElement("div");
        line.className = "log-line " + level;
        renderLogLine(line, text, level, source);
        box.appendChild(line);
    }
    while (box.children.length > logCap) box.removeChild(box.firstChild as Node);
    box.scrollTop = box.scrollHeight;
}

function makeLogFilters(): void {
    const input = $("#log-find") as HTMLInputElement;
    input.addEventListener("input", () => {
        const q = input.value.trim();
        try {
            logFindRe = q ? new RegExp(q, "i") : null;
        } catch {
            // fall back to plain substring on invalid regex
            logFindRe = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
        }
        refilterLog();
    });
    const levelSel = $("#log-level") as HTMLSelectElement;
    levelSel.addEventListener("change", () => {
        minLevel = LEVEL_ORDER[levelSel.value] ?? 1;
        refilterLog();
    });
    const sourceSel = $("#log-source") as HTMLInputElement;
    sourceSel.addEventListener("input", () => {
        logSource = sourceSel.value.trim();
        refilterLog();
    });
}

// ---- survive extension reloads ----
// after a reload the old page's chrome bindings die ("Extension context
// invalidated") — detect it and reload the tab, which reconnects to the
// freshly restarted extension with all state re-fetched.
let reloading = false;
function startKeepAlive(): void {
    setInterval(() => {
        if (reloading) return;
        try {
            chrome.runtime.getPlatformInfo(() => {
                if (chrome.runtime.lastError || !(chrome as any).runtime?.id) {
                    reloading = true;
                    status("extension reloaded — reconnecting…");
                    location.reload();
                }
            });
        } catch {
            reloading = true;
            location.reload();
        }
    }, 2000);
}

// also catch invalidated-context errors from any message send
function send<T = any>(msg: any): Promise<T> {
    return sendRaw<T>(msg).catch((e: any) => {
        if (String(e).includes("context invalidated") && !reloading) {
            reloading = true;
            status("extension reloaded — reconnecting…");
            location.reload();
        }
        throw e;
    });
}

// ---- dialogs: settings / help / samples ----
let currentTheme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
const monacoTheme = () => (currentTheme === "light" ? "vs" : "vs-dark");

function openDialog(id: string): void {
    document.getElementById(id)?.classList.remove("hidden");
}
function closeDialog(el: Element): void {
    el.classList.add("hidden");
}

/** Settings dialog; `section` scrolls to e.g. "settings-sec-about". */
function openSettings(section?: string): void {
    openDialog("settings-panel");
    if (section) showSettingsSection(section);
    void renderAbout();
    chrome.runtime.sendMessage({ type: "processStatus" }, (st) => {
        void chrome.runtime.lastError;
        if (st) renderProcessStatus(st);
    });
}

function showSettingsSection(id: string): void {
    document.getElementById(id)?.scrollIntoView({ block: "start" });
    markSettingsNav(id);
}

function markSettingsNav(id: string): void {
    for (const b of document.querySelectorAll<HTMLElement>("[data-settings-nav]")) b.classList.toggle("active", b.dataset.settingsNav === id);
}

/** Highlight the nav entry of the section at the top of the scrolled body. */
function trackSettingsScroll(): void {
    const body = $(".settings-body");
    body.addEventListener("scroll", () => {
        const sections = [...body.querySelectorAll<HTMLElement>(".settings-section")];
        const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
        const top = body.getBoundingClientRect().top + 24;
        const current = atEnd ? sections[sections.length - 1] : sections.filter((sec) => sec.getBoundingClientRect().top <= top).pop() ?? sections[0];
        if (current) markSettingsNav(current.id);
    });
    for (const b of document.querySelectorAll<HTMLElement>("[data-settings-nav]")) {
        b.addEventListener("click", () => showSettingsSection(b.dataset.settingsNav!));
    }
}

let aboutInfo: [string, string][] = [];
let aboutGen = 0;
async function renderAbout(): Promise<void> {
    const gen = ++aboutGen;
    const rows = await aboutRows(helperStatus);
    if (gen !== aboutGen) return;
    const current = chrome.runtime.getManifest().version;
    const draw = (latest: { text: string; url?: string; update?: boolean }): void => {
        aboutInfo = [rows[0], ["Latest", latest.text], ...rows.slice(1)];
        $("#about-info").replaceChildren(
            ...aboutInfo.flatMap(([k, v]) => {
                const dt = document.createElement("dt");
                dt.textContent = k;
                const dd = document.createElement("dd");
                dd.textContent = v;
                if (k === "Commit" || k === "Extension ID") dd.className = "mono";
                if (k === "Latest" && latest.url) {
                    if (latest.update) dd.className = "about-update";
                    const a = document.createElement("a");
                    a.href = latest.url;
                    a.target = "_blank";
                    a.rel = "noopener";
                    a.textContent = latest.update ? "download" : "releases";
                    dd.append(" · ", a);
                }
                return [dt, dd];
            })
        );
    };
    draw({ text: "checking…" });
    const latest = await checkLatestRelease().then(
        (r) => describeLatest(r, current),
        (e) => ({ text: `couldn't check (${e?.message || e})`, url: RELEASES_URL })
    );
    if (gen === aboutGen) draw(latest);
}

function flash(b: HTMLElement, text: string): void {
    const was = b.textContent;
    b.textContent = text;
    setTimeout(() => (b.textContent = was), 1500);
}

/** Manager-side context for the diagnostics report. */
function managerUiState(): Record<string, unknown> {
    const l = loadLayout();
    return {
        theme: currentTheme,
        themePref: ($("#settings-theme") as HTMLSelectElement).value,
        wordWrap: !!l.wordWrap,
        sidebarHidden: !!l.sidebarHidden,
        panelHidden: !!l.panelHidden,
        panelDock: currentDock(),
        sidebarSide: currentSide(),
        logLevel: ($("#settings-log-level") as HTMLSelectElement).value,
        logCap,
        monacoVerbose,
        logBadge: logBadgeEnabled,
        scriptsFolder: $("#folder-state").textContent || null,
    };
}

let diagnosticsReport = "";
/** Runs from a click or editor command: the permission prompt needs that gesture. */
async function runDiagnostics(): Promise<void> {
    const btn = $("#btn-diagnostics") as HTMLButtonElement;
    const state = $("#diagnostics-state");
    const copy = $("#btn-diagnostics-copy");
    const net = $("#btn-net-diagnostics") as HTMLButtonElement;
    const netLabel = net.textContent;
    btn.disabled = net.disabled = true;
    copy.hidden = true;
    state.textContent = net.textContent = "collecting…";
    try {
        const name = diagnosticsFileName();
        diagnosticsReport = await collectDiagnostics(managerUiState());
        downloadText(name, diagnosticsReport, "text/markdown");
        state.textContent = `downloaded (${Math.ceil(diagnosticsReport.length / 1024)} KB)`;
        state.title = name;
        copy.hidden = false;
        net.textContent = "downloaded ✓";
    } catch (e: any) {
        state.textContent = `failed: ${e?.message || e}`;
        net.textContent = "failed";
        net.title = state.textContent;
    } finally {
        btn.disabled = net.disabled = false;
        setTimeout(() => (net.textContent = netLabel), 1500);
    }
}

function setupDialogs(): void {
    $("#btn-settings").addEventListener("click", () => openSettings());
    trackSettingsScroll();
    $("#btn-about-copy").addEventListener("click", async (e) => {
        const b = e.currentTarget as HTMLElement;
        if (!aboutInfo.length) await renderAbout();
        await navigator.clipboard.writeText(aboutText(aboutInfo)).then(() => flash(b, "Copied ✓"), () => flash(b, "Copy failed"));
    });
    $("#btn-diagnostics").addEventListener("click", () => void runDiagnostics());
    $("#btn-net-diagnostics").addEventListener("click", () => void runDiagnostics());
    $("#btn-diagnostics-copy").addEventListener("click", (e) => {
        const b = e.currentTarget as HTMLElement;
        void navigator.clipboard.writeText(diagnosticsReport).then(() => flash(b, "Copied ✓"), () => flash(b, "Copy failed"));
    });
    $("#btn-process-retry").addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "processRetry" }, (st) => {
            void chrome.runtime.lastError;
            if (st) renderProcessStatus(st);
        })
    );
    $("#btn-process-copy").addEventListener("click", async (e) => {
        const b = e.currentTarget as HTMLButtonElement;
        await navigator.clipboard.writeText(b.dataset.cmd || "").catch(() => {});
        b.textContent = "Copied ✓";
        setTimeout(() => (b.textContent = "Copy install command"), 1500);
    });
    $("#btn-process-trust").addEventListener("click", () => chrome.runtime.sendMessage({ type: "processTrustCa" }, () => void chrome.runtime.lastError));
    $("#btn-help").addEventListener("click", () => {
        openDialog("help-panel");
        showHelpTab(document.querySelector<HTMLElement>("[data-help-tab].active")?.dataset.helpTab || "reference");
    });
    for (const tab of document.querySelectorAll<HTMLElement>("[data-help-tab]")) {
        tab.addEventListener("click", () => showHelpTab(tab.dataset.helpTab!));
    }
    $input("#shortcuts-filter").addEventListener("input", renderShortcuts);
    $input("#help-filter").addEventListener("input", () => filterHelpList("help"));
    $input("#samples-filter").addEventListener("input", () => filterHelpList("samples"));
    for (const overlay of document.querySelectorAll(".overlay")) {
        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) closeDialog(overlay);
        });
        for (const btn of overlay.querySelectorAll("[data-close]")) {
            btn.addEventListener("click", () => closeDialog(overlay));
        }
    }
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") document.querySelectorAll(".overlay:not(.hidden)").forEach(closeDialog);
    });

    // settings: theme
    const themeSel = $("#settings-theme") as HTMLSelectElement;
    themeSel.addEventListener("change", () => saveTheme(themeSel.value as ThemePref));
    watchTheme((t, pref) => {
        currentTheme = t;
        themeSel.value = pref;
        (window as any).monaco?.editor.setTheme(monacoTheme());
    });

    // settings: default log level
    const sel = $("#settings-log-level") as HTMLSelectElement;
    chrome.storage.local.get("resLogLevel", (d) => {
        if (d && d.resLogLevel) {
            sel.value = d.resLogLevel;
            applyLogLevel(d.resLogLevel);
        }
    });
    sel.addEventListener("change", () => {
        chrome.storage.local.set({ resLogLevel: sel.value });
        applyLogLevel(sel.value);
    });

    // settings: default interception strategy
    const strategySel = $("#settings-strategy") as HTMLSelectElement;
    const strategyTable = $("#settings-strategy-table") as HTMLTableElement;
    ($("#settings-strategy-doc") as HTMLAnchorElement).href = STRATEGY_DOC_URL;
    const strategyEnv = { firefox: typeof (globalThis as any).browser?.webRequest?.filterResponseData === "function", mv3: __MV3__ };
    const renderStrategy = (cur: string): void => {
        strategySel.value = cur;
        strategyTable.replaceChildren();
        const head = strategyTable.insertRow();
        for (const t of ["Strategy", "Pros", "Cons"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: t }));
        for (const s of STRATEGIES) {
            const row = strategyTable.insertRow();
            const why = strategyUnsupported(s, strategyEnv);
            row.classList.toggle("current", s === cur);
            row.classList.toggle("unavailable", !!why);
            row.insertCell().textContent = s + (why ? ` (${why})` : "");
            row.insertCell().textContent = STRATEGY_INFO[s].pros;
            row.insertCell().textContent = STRATEGY_INFO[s].cons;
        }
    };
    for (const s of STRATEGIES) {
        const why = strategyUnsupported(s as Strategy, strategyEnv);
        const opt = new Option(STRATEGY_INFO[s].label + (s === defaultStrategySetting() ? " (default)" : "") + (why ? ` — ${why}` : ""), s);
        opt.disabled = !!why;
        strategySel.add(opt);
    }
    renderStrategy(defaultStrategySetting());
    chrome.storage.local.get("resStrategy", (d) => renderStrategy(isStrategy(d?.resStrategy) ? d.resStrategy : defaultStrategySetting()));
    strategySel.addEventListener("change", () => {
        chrome.storage.local.set({ resStrategy: strategySel.value });
        renderStrategy(strategySel.value);
    });

    // verbose Monaco/navigation diagnostics
    const verboseBox = $("#settings-monaco-verbose") as HTMLInputElement;
    chrome.storage.local.get("resMonacoVerbose", (d) => {
        monacoVerbose = !!(d && d.resMonacoVerbose);
        verboseBox.checked = monacoVerbose;
        navLog(`verbose logging ${monacoVerbose ? "on" : "off"}`);
    });
    verboseBox.addEventListener("change", () => {
        monacoVerbose = verboseBox.checked;
        chrome.storage.local.set({ resMonacoVerbose: monacoVerbose });
        navLog(`verbose logging ${monacoVerbose ? "on" : "off"}`, "warn");
    });

    // Tab badges (Log + Network), one toggle
    const badgeBox = $("#settings-log-badge") as HTMLInputElement;
    chrome.storage.local.get("resLogBadge", (d) => {
        logBadgeEnabled = d?.resLogBadge !== false;
        badgeBox.checked = logBadgeEnabled;
        renderTabBadges();
    });
    badgeBox.addEventListener("change", () => {
        logBadgeEnabled = badgeBox.checked;
        chrome.storage.local.set({ resLogBadge: logBadgeEnabled });
        renderTabBadges();
    });

    // panel history size
    const capInput = $("#settings-log-cap") as HTMLInputElement;
    capInput.value = String(logCap);
    chrome.storage.local.get("resLogCap", (d) => {
        if (d && d.resLogCap) {
            logCap = d.resLogCap;
            capInput.value = String(logCap);
        }
    });
    capInput.addEventListener("change", () => {
        const n = Math.max(100, Math.min(10000, Number(capInput.value) || 500));
        capInput.value = String(n);
        logCap = n;
        chrome.storage.local.set({ resLogCap: n });
        refilterLog();
    });

    // settings.yaml edits land in storage — reflect them live
    chrome.storage.onChanged.addListener((c) => {
        if (c.resLogLevel?.newValue) {
            sel.value = c.resLogLevel.newValue;
            applyLogLevel(c.resLogLevel.newValue);
        }
        if (c.resStrategy) renderStrategy(isStrategy(c.resStrategy.newValue) ? c.resStrategy.newValue : defaultStrategySetting());
        if (c.resLogCap?.newValue) {
            logCap = c.resLogCap.newValue;
            capInput.value = String(logCap);
            refilterLog();
        }
        if (c.resScripts || c.resParams || c.resLogLevel || c.resLogCap || c.resStrategy || c.resSettingsText || c.resDataFiles || c.resFolders) {
            void (async () => {
                if (selectedId === SETTINGS_ID) await loadSettingsModel();
                // data files / folders change the script order (folders) or importers' errors
                if (c.resScripts || c.resDataFiles || c.resFolders) await refresh();
            })();
        }
    });

    // absolute folder path for the ↗ VS Code button
    const pathInput = $("#settings-vscode-path") as HTMLInputElement;
    chrome.storage.local.get("resVscodePath", (d) => {
        if (d && d.resVscodePath) pathInput.value = d.resVscodePath;
    });
    pathInput.addEventListener("change", () => {
        chrome.storage.local.set({ resVscodePath: pathInput.value.trim() }, () => void refreshSyncPath());
    });

    // launch target for the ↗ button (vscode | vscode-insiders | custom | off)
    const launchSel = $("#settings-vscode-launch") as HTMLSelectElement;
    const urlInput = $("#settings-editor-url") as HTMLInputElement;
    const showUrl = () => void ($("#settings-editor-url-row").hidden = launchMode !== "custom");
    chrome.storage.local.get(["resVscodeLaunch", "resEditorUrl"], (d) => {
        launchMode = (d && d.resVscodeLaunch) || "vscode";
        launchTemplate = (d && d.resEditorUrl) || "";
        launchSel.value = launchMode;
        urlInput.value = launchTemplate;
        showUrl();
        updateOpenVscode();
    });
    launchSel.addEventListener("change", () => {
        launchMode = launchSel.value as LaunchMode;
        chrome.storage.local.set({ resVscodeLaunch: launchMode });
        showUrl();
        updateOpenVscode();
        if (launchMode === "custom" && !urlInput.value.trim()) urlInput.focus();
    });
    urlInput.addEventListener("input", () => {
        launchTemplate = urlInput.value.trim();
        chrome.storage.local.set({ resEditorUrl: launchTemplate });
        updateOpenVscode();
    });

    renderHelp();
}

function applyLogLevel(level: string): void {
    const sel = $("#log-level") as HTMLSelectElement;
    sel.value = level;
    sel.dispatchEvent(new Event("change"));
}

function showHelpTab(name: string): void {
    if (name === "samples" && !$("#samples-list").childElementCount) renderSamples();
    if (name === "shortcuts") renderShortcuts();
    const filter = { reference: "#help-filter", samples: "#samples-filter", shortcuts: "#shortcuts-filter" }[name];
    if (filter) setTimeout(() => $input(filter).focus());
    for (const tab of document.querySelectorAll<HTMLElement>("[data-help-tab]")) {
        tab.classList.toggle("active", tab.dataset.helpTab === name);
        tab.setAttribute("aria-selected", String(tab.dataset.helpTab === name));
    }
    for (const pane of document.querySelectorAll<HTMLElement>("#help-panel [data-pane]")) pane.hidden = pane.dataset.pane !== name;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function showShortcutsHelp(): void {
    openDialog("help-panel");
    showHelpTab("shortcuts");
}

function renderShortcuts(): void {
    const rows = filterShortcuts(SHORTCUTS, $input("#shortcuts-filter").value, isMac);
    const tbody = $("#shortcuts-table tbody");
    tbody.replaceChildren(
        ...rows.map((s) => {
            const tr = document.createElement("tr");
            const action = document.createElement("td");
            action.textContent = s.action;
            const keys = document.createElement("td");
            keysFor(s, isMac).forEach((k, i) => {
                if (i) keys.append(" / ");
                const kbd = document.createElement("kbd");
                kbd.textContent = formatKey(k, isMac);
                keys.append(kbd);
            });
            const where = document.createElement("td");
            where.className = "muted";
            where.textContent = s.where;
            tr.append(action, keys, where);
            return tr;
        })
    );
    $("#shortcuts-empty").hidden = rows.length > 0;
}

/** Hides Reference sections / Samples cards that don't contain every typed word. */
function filterHelpList(pane: "help" | "samples"): void {
    const words = $input(`#${pane}-filter`).value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const el of Array.from($(`#${pane}-list`).children) as HTMLElement[]) {
        const text = (el.textContent || "").toLowerCase();
        el.hidden = !words.every((w) => text.includes(w));
        if (!el.hidden) shown++;
    }
    $(`#${pane}-empty`).hidden = shown > 0;
}

function renderHelp(): void {
    const body = $("#help-list");
    body.innerHTML = "";
    for (const section of API_REFERENCE) {
        const div = document.createElement("div");
        div.className = "api-section";
        const title = document.createElement("div");
        title.className = "api-title";
        title.textContent = section.title;
        const pre = document.createElement("pre");
        pre.textContent = section.body;
        div.append(title, pre);
        body.appendChild(div);
    }
}

function renderSamples(): void {
    const body = $("#samples-list");
    body.innerHTML = "";
    for (const sample of SAMPLES) {
        const card = document.createElement("div");
        card.className = "sample";
        const head = document.createElement("div");
        head.className = "sample-head";
        const name = document.createElement("span");
        name.className = "sample-name";
        name.textContent = sample.name;
        const use = document.createElement("button");
        use.className = "btn-use";
        use.textContent = "Use this";
        use.addEventListener("click", async () => {
            const id = newId();
            await send({ type: "saveScript", id, code: sample.code, name: sample.name });
            await refresh();
            selectReal(id);
            document.getElementById("help-panel")?.classList.add("hidden");
            status(`sample "${sample.name}" added ✓`);
        });
        head.append(name, use);
        const blurb = document.createElement("div");
        blurb.className = "sample-blurb";
        blurb.textContent = sample.blurb;
        const pre = document.createElement("pre");
        pre.textContent = sample.code;
        card.append(head, blurb, pre);
        body.appendChild(card);
    }
    filterHelpList("samples");
}

// ---- toolbar folder sync button: off / disconnected / connected / sending / receiving ----
let folderNeedsGrant = false; // a saved folder waits for a permission click
function renderFolderSync(st: { active: boolean; path?: string; paused?: boolean; activity?: string }): void {
    const btn = $("#btn-folder-sync");
    if (st.active) folderNeedsGrant = false;
    else if (st.paused) folderNeedsGrant = true;
    const state = st.active ? (st.activity === "sending" || st.activity === "receiving" ? st.activity : "connected") : folderNeedsGrant ? "disconnected" : "off";
    btn.dataset.state = state;
    const where = st.path ? ` "${st.path}"` : "";
    const text: Record<string, string> = {
        off: "Folder sync is off — click to set it up",
        disconnected: "Folder sync disconnected — click to reconnect",
        connected: `Synced with${where || " the folder"} — click for folder sync settings`,
        sending: `Writing changes to${where || " the folder"}…`,
        receiving: `Reading changes from${where || " the folder"}…`,
    };
    btn.title = text[state];
    btn.setAttribute("aria-label", `Folder sync: ${state}`);
}

async function folderSyncButtonClicked(): Promise<void> {
    if ($("#btn-folder-sync").dataset.state === "disconnected" && (await fsBridge.reconnectClicked())) {
        await markFolderSynced();
        status("synced folder reconnected ✓");
        return;
    }
    openSettings("settings-sec-folder");
}

// ---- dedicated scripts folder: pick once, edits sync both ways ----
async function markFolderSynced(): Promise<void> {
    const btn = $("#btn-vscode");
    btn.classList.add("active");
    btn.textContent = "Scripts Folder ✓";
    (window as any).__resSyncActive = true;
    fsBridge.setCachedActive(true);
    updateOpenVscode();
    const st = await fsBridge.queryStatus();
    renderFolderSync(st);
    $("#folder-state").textContent = st.path || "(syncing)";
    await refreshSyncPath();
}

/** Absolute path used by the ↗ VS Code button. The sync-reported path is
 * absolute when Chrome can read it (handle.getPath); otherwise fall back
 * to the user-provided path from Settings. */
async function refreshSyncPath(): Promise<void> {
    const st = await fsBridge.queryStatus();
    if (st.path && st.path.startsWith("/")) {
        (window as any).__resSyncPath = st.path;
        return;
    }
    chrome.storage.local.get("resVscodePath", (d) => {
        (window as any).__resSyncPath = (d && d.resVscodePath) || "";
    });
}

function newId(): string {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

async function autoReconnectFolder(): Promise<void> {
    if (!fsBridge.isSupported()) return;
    const st = await fsBridge.autoReconnect();
    const btn = $("#btn-vscode");
    if (st === "synced") {
        await markFolderSynced();
    } else if (st === "prompt") {
        // one click re-grants (Chrome drops FS grants between restarts)
        btn.textContent = "Scripts Folder… (reconnect)";
        $("#folder-state").textContent = "reconnect needed";
        renderFolderSync({ active: false, paused: true });
        const reconnect = async (): Promise<void> => {
            btn.removeEventListener("click", reconnect);
            if (fsBridge.isSyncing()) return;
            const ok = await fsBridge.reconnectClicked();
            if (ok) {
                await markFolderSynced();
                status("synced folder reconnected ✓");
            }
        };
        btn.addEventListener("click", reconnect);
        status("synced folder needs reconnect — click to reconnect", "dirty", () => void reconnect());
    }
}

// ---- movable panels ----
interface PanelLayout {
    sidebarW?: number;
    panelTab?: "problems" | "log" | "network";
    sidebarHidden?: boolean;
    panelHidden?: boolean;
    wordWrap?: boolean;
}
const LAYOUT_KEY = "resPanelLayout";

function loadLayout(): PanelLayout {
    try {
        return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    } catch {
        return {};
    }
}

function saveLayout(l: PanelLayout): void {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
}

function applyLayout(): void {
    const l = loadLayout();
    if (l.sidebarW) $("#sidebar").style.width = `${l.sidebarW}px`;
    setSidebarHidden(!!l.sidebarHidden, false);
    setPanelHidden(!!l.panelHidden, false);
}

/** ⌘B: show/hide the explorer (VS Code's primary side bar). */
function setSidebarHidden(hidden: boolean, persist = true): void {
    const app = $("#app");
    if (hidden && app.querySelector("#sidebar")!.contains(document.activeElement)) editor?.focus();
    app.classList.toggle("sidebar-hidden", hidden);
    $("#btn-toggle-sidebar").setAttribute("aria-pressed", String(!hidden));
    if (persist) saveLayout({ ...loadLayout(), sidebarHidden: hidden });
    window.dispatchEvent(new Event("resize"));
}

/** ⌘J: show/hide the Log/Network panel wherever it is docked. */
function setPanelHidden(hidden: boolean, persist = true): void {
    const app = $("#app");
    if (hidden && $("#log-panel").contains(document.activeElement)) editor?.focus();
    app.classList.toggle("panel-hidden", hidden);
    $("#btn-toggle-panel").setAttribute("aria-pressed", String(!hidden));
    if (persist) saveLayout({ ...loadLayout(), panelHidden: hidden });
    renderTabBadges();
    window.dispatchEvent(new Event("resize"));
}

const toggleSidebar = (): void => setSidebarHidden(!$("#app").classList.contains("sidebar-hidden"));
const togglePanel = (): void => setPanelHidden(!$("#app").classList.contains("panel-hidden"));

/** ⌥Z: soft-wrap long lines (remembered across sessions). */
function toggleWordWrap(): void {
    const on = !loadLayout().wordWrap;
    saveLayout({ ...loadLayout(), wordWrap: on });
    editor?.updateOptions({ wordWrap: on ? "on" : "off" });
}

function makeSplitV(): void {
    const handle = $("#split-v");
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        handle.classList.add("dragging");
        const move = (ev: MouseEvent) => {
            const x = currentSide() === "right" ? window.innerWidth - ev.clientX : ev.clientX;
            const w = Math.min(620, Math.max(200, x));
            $("#sidebar").style.width = `${w}px`;
        };
        const up = () => {
            handle.classList.remove("dragging");
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            const l = loadLayout();
            l.sidebarW = $("#sidebar").offsetWidth;
            saveLayout(l);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
}

let networkMounted = false;
type PanelTab = "problems" | "log" | "network";

/** VS Code–style bottom panel tabs: PROBLEMS | LOG | NETWORK */
function showPanelTab(which: PanelTab): void {
    for (const t of document.querySelectorAll<HTMLElement>(".panel-tab")) {
        const on = t.dataset.panel === which;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", String(on));
    }
    $("#log-entries").hidden = which !== "log";
    $("#log-tools").hidden = which !== "log";
    $("#net-tools").hidden = which !== "network";
    $("#network-view").hidden = which !== "network";
    $("#problems-view").hidden = which !== "problems";
    $("#log-panel").dataset.tab = which;
    renderTabBadges();
    // recording starts the first time the tab is shown (zero cost before)
    if (which === "network" && !networkMounted) {
        networkMounted = true;
        mountNetworkPanel($("#network-view"));
    }
    const l = loadLayout();
    l.panelTab = which;
    saveLayout(l);
}

function setupPanelTabs(): void {
    for (const t of document.querySelectorAll<HTMLElement>(".panel-tab")) {
        t.addEventListener("click", () => showPanelTab(t.dataset.panel as PanelTab));
    }
    // status bar: open the panel on that view (VS Code: clicking the open one closes the panel)
    for (const item of document.querySelectorAll<HTMLElement>("#status-bar .sb-item")) {
        item.addEventListener("click", () => {
            const which = item.dataset.panel as PanelTab;
            const hidden = $("#app").classList.contains("panel-hidden");
            if (!hidden && $("#log-panel").dataset.tab === which) return setPanelHidden(true);
            if (hidden) setPanelHidden(false);
            showPanelTab(which);
        });
    }
    const saved = loadLayout().panelTab;
    showPanelTab(saved === "network" || saved === "problems" ? saved : "log");
}

// ---- wiring ----
async function main(): Promise<void> {
    await loadMonaco();
    // test/e2e seam: adopt an arbitrary directory handle (e.g. OPFS) for watching
    (window as any).__resAdoptFolder = (h: any) => fsBridge.adoptForWatch(h);
    editor = (window as any).monaco.editor.create($("#monaco-host"), {
        value: "",
        language: "typescript",
        theme: monacoTheme(),
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
        scrollBeyondLastLine: false,
        wordWrap: loadLayout().wordWrap ? "on" : "off",
        hover: { sticky: true }, // reachable, so tooltip.ts can copy it on click
    });
    editor.addCommand((window as any).monaco.KeyMod.CtrlCmd | (window as any).monaco.KeyCode.KeyS, () => void saveCurrent());
    registerLayoutActions();
    (window as any).monaco.editor.onDidChangeMarkers((uris: Uri[]) => {
        for (const u of uris) if (!ownMarkerWrites.delete(u.toString())) checkedUris.add(u.toString());
        scheduleDiagnostics();
        scheduleProblems();
    });
    (window as any).monaco.editor.onWillDisposeModel((m: any) => {
        checkedUris.delete(m.uri.toString());
        if ((problemMarkerKeys.get(m) ?? "[]") !== "[]") setProblemMarkers(m, []);
        scheduleProblems();
    });
    registerSettingsAssist();
    // Monaco re-checks only the edited file; its importers keep stale errors
    (window as any).monaco.editor.onDidCreateModel((m: any) => {
        if (m.getLanguageId() === "typescript") m.onDidChangeContent(() => scheduleDependantRecheck(m));
    });
    for (const m of models.values()) m.onDidChangeContent(() => scheduleDependantRecheck(m));
    // VS Code shortcuts: ⌘P quick-open (scripts + settings.yaml), ⌘, opens
    // the Settings dialog, ⌘⇧E focuses the explorer, ⌘B / ⌘J toggle the
    // explorer / panel, ⌘⇧M toggles the Problems view, ⌥Z toggles word wrap
    // (the last five are also editor actions, so they work while Monaco has
    // focus and show up in F1).
    // ⌘/ (comment), ⌘F (find), ⌘D (next occurrence) and Shift+Alt+A (block
    // comment) are Monaco built-ins.
    const palette = createQuickOpenPalette(
        $("#quick-open"),
        $input("#qo-input"),
        $("#qo-list"),
        () => [{ id: SETTINGS_ID, name: "settings.yaml" }, ...scripts.map((s) => ({ id: s.id, name: s.meta.name })), ...dataFiles.map((d) => ({ id: d.id, name: d.path }))],
        (id) => {
            select(id);
            editor.focus(); // VS Code behavior: a ⌘P jump focuses the editor
        }
    );
    document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
            e.preventDefault();
            palette.toggle();
        } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === ",") {
            e.preventDefault();
            openSettings();
        } else if (!e.defaultPrevented) {
            const run = layoutShortcut(e);
            if (run) {
                e.preventDefault();
                run();
            }
        }
    });
    $("#btn-toggle-sidebar").addEventListener("click", toggleSidebar);
    $("#btn-toggle-panel").addEventListener("click", togglePanel);
    $("#btn-close-panel").addEventListener("click", () => setPanelHidden(true));
    setupExplorer();
    const opener: MonacoEditor.ICodeEditorOpener = {
        openCodeEditor: (_source, resource, selection) => openScriptAt(resource, selection),
    };
    (window as any).monaco.editor.registerEditorOpener(opener);
    navLog("editor opener registered");
    installMonacoTrace();

    editor.onDidChangeModelContent(() => {
        if (applyingExternal) return;
        updateDirty();
    });

    $("#btn-save").addEventListener("click", () => void saveCurrent());
    $("#btn-open-vscode").addEventListener("click", () => {
        const folder = (window as any).__resSyncPath as string;
        if (!folder || !selectedId || typingsShown) return;
        // the ⚙ settings.yaml entry is virtual (not in `scripts`) — its
        // target is <folder>/settings.yaml, written by folderSync
        const data = dataFiles.find((d) => d.id === selectedId);
        const file = data ? `${folder.replace(/\/+$/, "")}/${data.path}` : vscodeTargetPath(folder, selectedId, scripts.find((s) => s.id === selectedId)?.meta.name, SETTINGS_ID, SETTINGS_FILE);
        const url = editorLaunchUrl(launchMode, launchTemplate, file, editor?.getPosition?.()?.lineNumber || 1);
        if (!url) return;
        // launch from THIS page (user gesture): external-protocol requests
        // from the background page are dropped by Chromium
        const a = document.createElement("a");
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        status(`opening ${file} in ${launchAppName(launchMode)}…`);
        const msg = `openInVscode → launching ${url}`;
        appendLog({ at: Date.now(), message: `[editor] ${msg}`, level: "info" });
        chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "editor", msg, level: "info" } }, () => void chrome.runtime.lastError);
    });
    $("#btn-clear-log").addEventListener("click", () => {
        $("#log-entries").innerHTML = "";
        logEntries.length = 0;
        observedEntries = 0;
        logBadge.reset();
        renderTabBadges();
        void send({ type: "clearDebugLogs" });
    });
    $("#btn-logs").addEventListener("click", async () => {
        const bg = await send({ type: "getDebugLogs" });
        const lines: string[] = [
            `Wiretrick debug log — ${new Date().toISOString()}`,
            `UA: ${bg.ua} | extension v${bg.ver}`,
            `entries: ${bg.entries ? bg.entries.length : 0}`,
            "",
            ...(bg.entries || []).map((e: any) => `${new Date(e.at).toISOString()} [${e.src}] ${e.msg}`),
        ];
        const blob = new Blob([lines.join("\n")], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `wiretrick-debug-${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);
        status("debug log downloaded");
    });
    $("#editor-status").addEventListener("click", () => statusClick?.());
    // delegated: a click on another script re-renders the list
    $("#script-list").addEventListener("dblclick", (e) => {
        const li = (e.target as HTMLElement).closest<HTMLElement>("li.script-item");
        // a folder's clicks toggle it (rename it with F2)
        const row = li && li.dataset.id !== SETTINGS_ID && !isFolderRowId(li.dataset.id!) ? treeRow(li.dataset.id!) : undefined;
        const label = row && li!.querySelector<HTMLElement>(".script-name");
        if (label) startRename(label, row!);
    });

    // VS Code folder sync
    const btn = $("#btn-vscode");
    if (fsBridge.isSupported()) {
        btn.addEventListener("click", async () => {
            if (fsBridge.isSyncing()) {
                await fsBridge.stopSync();
                (window as any).__resSyncActive = false;
                fsBridge.setCachedActive(false);
                btn.classList.remove("active");
                btn.textContent = "Scripts Folder…";
                $("#folder-state").textContent = "";
                folderNeedsGrant = false;
                renderFolderSync({ active: false });
                updateOpenVscode();
                return;
            }
            try {
                await fsBridge.openFolder();
            } catch (e: any) {
                if (e?.name === "AbortError") {
                    managerLog("folder pick cancelled", "warn");
                    return;
                }
                throw e;
            }
            await markFolderSynced();
        });
    } else {
        btn.setAttribute("disabled", "");
        btn.title = "File System Access API unavailable (Firefox) — use Import/Export";
    }
    const syncBtn = $("#btn-folder-sync");
    if (fsBridge.isSupported()) syncBtn.addEventListener("click", () => void folderSyncButtonClicked());
    else {
        syncBtn.setAttribute("disabled", "");
        syncBtn.title = "Folder sync needs the File System Access API (not in Firefox) — use Import/Export";
    }

    // import / export
    // import / export — both open a checklist so any subset can travel
    const settingsRow = (g: Record<string, any>) => ({
        label: "Settings (globals)",
        detail: Object.entries(g).map(([k, v]) => `${k}: ${v}`).join(", "),
    });
    // rows after the settings row: scripts, then data files (`data`, name = path)
    const importsWarning = (names: { name: string; code: string; data?: boolean }[], offset: number) => (checked: number[]) => {
        const picked = checked.filter((i) => i >= offset).map((i) => i - offset);
        const missing = missingImports(picked, names);
        if (!missing.length) return null;
        return {
            text: `selected scripts import ${missing.map((i) => `"${names[i].name}"`).join(", ")}, which ${missing.length > 1 ? "aren't" : "isn't"} selected`,
            fix: missing.map((i) => i + offset),
        };
    };
    $("#btn-export").addEventListener("click", async () => {
        // scripts + settings travel together in one YAML document; the
        // parsed settings.yaml carries globals AND per-script param values
        const { text } = await send({ type: "getSettingsYaml", text: settingsModel?.getValue() });
        let doc: SettingsDoc = { settings: null, params: {} };
        try {
            doc = parseSettings(text);
        } catch {
            /* unreachable: getSettingsYaml always returns parsable text */
        }
        const globals = doc.settings && Object.keys(doc.settings).length ? doc.settings : null;
        const offset = globals ? 1 : 0;
        const dataFiles: { path: string; text: string }[] = (await send({ type: "listDataFiles" })) || [];
        const folders: string[] = (await send({ type: "listFolders" })) || [];
        const list = [
            ...scripts.map((s) => ({ name: s.meta.name, code: s.code, enabled: s.enabled as boolean | undefined, data: false })),
            ...dataFiles.map((d) => ({ name: d.path, code: d.text, enabled: undefined, data: true })),
        ];
        const chosen = await pickRows({
            title: "Export",
            intro: "Pick what goes into the YAML bundle. Each script carries its code, enabled state and non-default params; each data file its path and text.",
            rows: [
                ...(globals ? [settingsRow(globals)] : []),
                ...list.map((s) => ({ label: s.name, badge: s.data ? "data file" : s.enabled ? undefined : "disabled" })),
            ],
            confirm: "Export",
            warn: importsWarning(list, offset),
        });
        if (!chosen) return;
        const rows = chosen.filter((i) => i >= offset).map((i) => list[i - offset]);
        const picked = rows.filter((r) => !r.data).map(({ name, code, enabled }) => ({ name, code, enabled }));
        const pickedData = rows.filter((r) => r.data).map((r) => ({ path: r.name, text: r.code }));
        // empty folders travel too (the others come with their contents)
        const paths = list.map((r) => r.name.toLowerCase());
        const empty = folders.filter((f) => !paths.some((p) => p.startsWith(f.toLowerCase() + "/")));
        const payload = buildBundle({ ...doc, settings: globals && chosen.includes(0) ? globals : null }, picked, pickedData, empty);
        const blob = new Blob([payload], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = picked.length === 1 && chosen.length === 1 ? `${picked[0].name.replace(/.*\//, "")}.wiretrick.yaml` : "wiretrick-export.yaml";
        a.click();
        URL.revokeObjectURL(url);
        status(`exported ${picked.length} script(s)${pickedData.length ? ` + ${pickedData.length} data file(s)` : ""}${offset && chosen.includes(0) ? " + settings" : ""} ✓`);
    });
    // an imported script replaces the existing script of the same name
    const saveImported = async (item: { code: string; name?: string; enabled?: boolean }) => {
        // file names are case-insensitive on Windows/macOS: "Foo" replaces "foo"
        const existing = item.name ? scripts.find((s) => scriptFileKey(s.meta.name) === scriptFileKey(item.name!)) : undefined;
        await send({ type: "saveScript", id: existing?.id ?? uuid(), code: item.code, name: item.name, enabled: item.enabled });
    };
    const existsBadge = (name?: string) => (name && scripts.some((s) => scriptFileKey(s.meta.name) === scriptFileKey(name)) ? "replaces existing" : "new");
    $("#btn-import").addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".yaml,.yml,.ts,.js";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const text = await file.text();
            if (/\.ya?ml$/i.test(file.name)) {
                const full = parseBundleText(text);
                if (full) {
                    const offset = full.settings ? 1 : 0;
                    const fullData = full.dataFiles ?? [];
                    const existingData: { id: string; path: string }[] = fullData.length ? (await send({ type: "listDataFiles" })) || [] : [];
                    const dataFileIn = (path: string) => existingData.find((d) => d.path.toLowerCase() === path.toLowerCase());
                    const named = [
                        ...full.scripts.map((s, i) => ({ name: s.name ?? `script ${i + 1}`, code: s.code, data: false })),
                        ...fullData.map((d) => ({ name: d.path, code: d.text, data: true })),
                    ];
                    const chosen = await pickRows({
                        title: `Import ${file.name}`,
                        intro: "Pick what to import. A script (data file) replaces the existing script (data file) of the same name (path).",
                        rows: [
                            ...(full.settings ? [settingsRow(full.settings)] : []),
                            ...full.scripts.map((s, i) => ({
                                label: named[i].name,
                                badge: existsBadge(s.name),
                                detail: s.params ? `params: ${Object.keys(s.params!).join(", ")}` : undefined,
                            })),
                            ...fullData.map((d) => ({ label: d.path, badge: dataFileIn(d.path) ? "replaces existing" : "new data file" })),
                        ],
                        confirm: "Import",
                        warn: importsWarning(named, offset),
                    });
                    if (!chosen) return;
                    const rows = chosen.filter((i) => i >= offset).map((i) => i - offset);
                    const bundle = pickBundle(
                        full,
                        offset > 0 && chosen.includes(0),
                        rows.filter((i) => i < full.scripts.length),
                        rows.filter((i) => i >= full.scripts.length).map((i) => i - full.scripts.length)
                    );
                    // folders and data files first: the scripts compile against them
                    const failed: string[] = [];
                    for (const f of bundle.folders ?? []) {
                        const r = await send({ type: "createFolder", path: f });
                        if (r?.error) failed.push(r.error);
                    }
                    for (const d of bundle.dataFiles ?? []) {
                        const r = await send({ type: "saveDataFile", id: dataFileIn(d.path)?.id, path: d.path, text: d.text });
                        if (r?.error) failed.push(r.error);
                    }
                    for (const item of bundle.scripts) await saveImported(item);
                    await refresh();
                    // settings apply through the real path (params +
                    // globals); storage.onChanged refreshes the settings UI
                    const doc = bundleSettingsDoc(bundle);
                    if (doc) {
                        const res = await send({ type: "applySettingsDoc", doc });
                        if (res && res.error) {
                            status(`imported ${bundle.scripts.length} script(s); settings: ${res.error}`, "error");
                            return;
                        }
                    }
                    if (failed.length) {
                        status(`imported ${bundle.scripts.length} script(s); ${failed.join("; ")}`, "error");
                        return;
                    }
                    const nData = bundle.dataFiles?.length ?? 0;
                    status(`imported ${bundle.scripts.length} script(s)${nData ? ` + ${nData} data file(s)` : ""}${bundle.settings ? " + settings" : ""} ✓`);
                    return;
                }
                status('not a Wiretrick export (missing "format: wiretrick-bundle")', "error");
                return;
            }
            const base = cleanScriptName(file.name.replace(/\.ts$/i, "")) || "Imported script";
            const name = uniqueScriptName(base, scripts.map((s) => s.meta.name));
            await send({ type: "saveScript", id: uuid(), code: text, name });
            status("imported script ✓");
            await refresh();
        };
        input.click();
    });

    applyLayout();
    makeSplitV();
    setupPanelDock();
    makeLogFilters();
    setupPanelTabs();
    setupProblemsView();
    watchNetCounts();
    startKeepAlive();
    setupDialogs();
    

    void autoReconnectFolder();

    // remember the manager is open → the background reopens it after an
    // extension reload (the renderer itself cannot survive)
    chrome.storage.local.set({ resManagerOpen: true });
    window.addEventListener("beforeunload", () => {
        // only clear when the user actually closed the tab; a killed
        // renderer (extension reload) skips beforeunload entirely
        chrome.storage.local.set({ resManagerOpen: false });
    });

    connectLogs();
    await refresh();

    // deep link from the popup: editor.html?script=<id>
    const wanted = new URLSearchParams(location.search).get("script");
    if (wanted && scripts.some((s) => s.id === wanted)) {
        selectReal(wanted);
    }
}

void renderEditorEmpty;

/** Layout shortcuts outside the editor (the editor's own copies are below). */
function layoutShortcut(e: KeyboardEvent): (() => void) | null {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && !e.altKey && e.code === "KeyE") return focusExplorer;
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyB") return toggleSidebar;
    if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyJ" || e.code === "Backquote")) return togglePanel;
    if (mod && e.shiftKey && !e.altKey && e.code === "KeyM") return toggleProblems;
    // ⌥Z types a character (Ω on macOS) in the log/network filter boxes
    const typing = (e.target as HTMLElement | null)?.matches?.("input, textarea, select");
    if (e.altKey && !mod && !e.shiftKey && e.code === "KeyZ" && !typing) return toggleWordWrap;
    // Go Back / Forward: ⌃- / ⌃⇧- on macOS (⌥← is word-left there), Alt+← / Alt+→
    // elsewhere — not in text fields, where Alt+arrows are the browser's/OS's
    if (!typing && isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Minus") return e.shiftKey ? navigateForward : navigateBack;
    if (!typing && !isMac && e.altKey && !mod && !e.shiftKey && (e.code === "ArrowLeft" || e.code === "ArrowRight"))
        return e.code === "ArrowLeft" ? navigateBack : navigateForward;
    return null;
}

/** Go Back / Go Forward keybindings in the Code view (VS Code's, per platform). */
function navKeybindings(): { back: number[]; forward: number[] } {
    const { KeyMod, KeyCode } = (window as any).monaco;
    return isMac
        ? { back: [KeyMod.WinCtrl | KeyCode.Minus], forward: [KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Minus] }
        : { back: [KeyMod.Alt | KeyCode.LeftArrow], forward: [KeyMod.Alt | KeyCode.RightArrow] };
}

/** The same shortcuts as editor actions: Monaco's keybinding service sees
 * them first while the editor has focus, and F1 lists them. */
function registerLayoutActions(): void {
    const { KeyMod, KeyCode } = (window as any).monaco;
    const actions: [string, string, number[], () => void][] = [
        ["wt.toggleWordWrap", "View: Toggle Word Wrap", [KeyMod.Alt | KeyCode.KeyZ], toggleWordWrap],
        ["wt.focusExplorer", "View: Focus on Explorer", [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE], focusExplorer],
        ["wt.toggleSidebar", "View: Toggle Explorer Visibility", [KeyMod.CtrlCmd | KeyCode.KeyB], toggleSidebar],
        ["wt.togglePanel", "View: Toggle Panel Visibility", [KeyMod.CtrlCmd | KeyCode.KeyJ, KeyMod.CtrlCmd | KeyCode.Backquote], togglePanel],
        ["wt.toggleProblems", "View: Toggle Problems", [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM], toggleProblems],
        ["wt.showShortcuts", "Help: Keyboard Shortcuts", [], showShortcutsHelp],
        ["wt.navigateBack", "Go Back", navKeybindings().back, navigateBack],
        ["wt.navigateForward", "Go Forward", navKeybindings().forward, navigateForward],
    ];
    for (const [id, label, keybindings, run] of actions) editor.addAction({ id, label, keybindings, run });
    editor.addAction({ id: "wt.openSettings", label: "Preferences: Open Settings", run: () => openSettings() });
    editor.addAction({
        id: "wt.collectDiagnostics",
        label: "Wiretrick: Collect Diagnostics…",
        run: () => {
            openSettings("settings-sec-about");
            void runDiagnostics();
        },
    });
}

function select(id: string): Promise<void> {
    if (dirty && selectedId && !(typingsShown && id === selectedId)) {
        if (!confirm("Discard unsaved changes?")) {
            return Promise.resolve();
        }
    }
    if (id === SETTINGS_ID) return selectSettings();
    const row = treeRow(id);
    if (row) revealInExplorer(row.path);
    selectReal(id);
    return Promise.resolve();
}

let monacoVerbose = false;

/** Navigation diagnostics. Warnings/errors always log; the rest only with the
 * "Verbose Monaco logging" setting. Verbose lines use "warn" so the panel's
 * level filter never hides them. */
function managerLog(msg: string, level: string): void {
    const text = `[editor] ${msg}`;
    appendLog({ at: Date.now(), message: text, level });
    chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "editor", msg, level } }, () => void chrome.runtime.lastError);
}

function navLog(msg: string, level = "info"): void {
    if (level === "info") {
        if (!monacoVerbose) return;
        level = "warn";
    }
    const text = `[editor] nav: ${msg}`;
    console.debug(text);
    appendLog({ at: Date.now(), message: text, level });
    chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "editor", msg: `nav: ${msg}`, level } }, () => void chrome.runtime.lastError);
}

/** Verbose-only tracing of the triggers and the TS worker's answer. */
function installMonacoTrace(): void {
    const m = (window as any).monaco;
    window.addEventListener("error", (e) => {
        // benign: a resize callback changed layout, notifications deferred a frame
        if (/^ResizeObserver loop/.test(e.message)) return;
        navLog(`window error: ${e.message}`, "error");
    });
    window.addEventListener("unhandledrejection", (e) => {
        const reason: any = (e as PromiseRejectionEvent).reason;
        // Monaco's internal async work (e.g. view-state restore scheduling)
        // rejects with its cancellation error when a rapid model switch
        // invalidates it — benign, don't litter the log
        if (reason && (reason.name === "Canceled" || reason.message === "Canceled")) return;
        // a dismissed file/folder picker is a user choice, not a failure
        if (reason && reason.name === "AbortError") return managerLog(`cancelled: ${reason.message}`, "warn");
        navLog(`unhandled rejection: ${String((reason && reason.stack) || reason)}`, "error");
    });
    editor.onDidChangeModel((e: MonacoEditor.IModelChangedEvent) => navLog(`model changed: ${e.oldModelUrl?.toString()} -> ${e.newModelUrl?.toString()}`));
    editor.onKeyDown((e: IKeyboardEvent) => {
        if (e.keyCode === m.KeyCode.F12) void traceDefinition("F12");
    });
    editor.onMouseDown((e: MonacoEditor.IEditorMouseEvent) => {
        if (e.event.leftButton && (e.event.ctrlKey || e.event.metaKey) && e.target.position) {
            navLog(`ctrl/cmd-click at ${e.target.position.lineNumber}:${e.target.position.column}`);
            void traceDefinition("click", e.target.position);
        }
    });
    navLog(`monaco trace installed; models=${[...models].map(([id, mo]) => `${id}=${mo.uri.toString()}`).join(", ")}`);
}

async function traceDefinition(trigger: string, pos?: IPosition): Promise<void> {
    if (!monacoVerbose) return;
    try {
        const m = (window as any).monaco;
        const model = editor.getModel();
        const p = pos ?? editor.getPosition();
        if (!model || !p) return navLog(`${trigger}: no model/position`, "warn");
        const getWorker = await m.languages.typescript.getTypeScriptWorker();
        const worker = await getWorker(model.uri);
        const defs = await worker.getDefinitionAtPosition(model.uri.toString(), model.getOffsetAt(p));
        navLog(`${trigger}: worker definitions at ${model.uri.toString()}:${p.lineNumber}:${p.column} = ${JSON.stringify(defs)}`);
    } catch (e) {
        navLog(`${trigger}: worker lookup failed: ${e instanceof Error ? e.stack || e.message : String(e)}`, "error");
    }
}

/** Go to Definition / peek targets: switch to the script owning `resource`
 * (honouring the unsaved-changes prompt) and reveal the target range. */
function openScriptAt(resource: Uri, selection?: IRange | IPosition): boolean {
    try {
        const known = [...models].map(([id, m]) => `${id}=${m.uri.toString()}`);
        navLog(`open ${resource.toString()} sel=${JSON.stringify(selection)} from=${typingsShown ? "wt-api.d.ts" : selectedId} dirty=${dirty}`);
        if (resource.toString() === API_TYPINGS_URI) {
            openTypingsAt(selection);
            navLog("opened wt-api.d.ts (read-only)");
            return true;
        }
        // a JSON import's declaration (mock/a.d.json.ts) stands for the data file
        const dataPath = dataPathOfDecl(resource.toString());
        const data = dataPath === null ? undefined : dataFiles.find((d) => d.path === dataPath);
        if (data) selection = undefined;
        const target = data ? ([data.id, dataModels.get(data.id)] as [string, any]) : [...models, ...dataModels].find(([, m]) => m.uri.toString() === resource.toString());
        if (!target) {
            navLog(`no script owns ${resource.toString()}; known models: ${known.join(", ")}`, "warn");
            return false;
        }
        const [id] = target;
        if (id !== selectedId || typingsShown) {
            if (id !== selectedId && dirty && selectedId && !confirm("Discard unsaved changes?")) {
                navLog("canceled by user (unsaved changes kept)");
                return true;
            }
            pushNav();
            const row = treeRow(id);
            if (row) revealInExplorer(row.path);
            selectReal(id);
        } else pushNav();
        revealSelection(selection);
        editor.focus();
        navLog(`opened ${id}`);
        return true;
    } catch (e) {
        navLog(`failed: ${e instanceof Error ? e.stack || e.message : String(e)}`, "error");
        return false;
    }
}

installTooltips();
main();
