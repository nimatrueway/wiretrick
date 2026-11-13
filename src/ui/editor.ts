/**
 * Manager page: script list + Monaco editor + logs + VS Code bridge.
 */

import "./shell/mount";
import { loadMonaco, STARTER_TEMPLATE, apiTypingsText, updateJsonSchemas } from "./monacoSetup";
import { createMonacoTsWorkspace, IMPORT_OWNER, JSX_IN_TS, UNPINNED, type TsWorkspace } from "./tsWorkspace";
import { API_TYPINGS_URI } from "./apiLinks";
import { NavHistory } from "./navHistory";
import type { SampleScript } from "./samples";
import { badPackageImports, folderOf, imageDataUrlToBytes, isImageDataPath, isMarkdownPath, isSvgPath, missingImports } from "../shared/scriptImports";
import { makeFolderPackagePlan, makePackagePlan } from "../shared/makePackage";
import { MANIFEST_FILE } from "../shared/packageMetadata";
import { manifestScriptCompletions, manifestScriptProblems } from "./manifestAssist";
import { entryStem } from "../shared/packageModel";
import { localPackage } from "../shared/localPackage";
import { writeZip } from "../shared/zip";
import { buildExportZip, emptyFolders, EXPORT_ZIP_NAME, filesGoneFrom, importedSettingsDoc, parseExportedStores, readExportZip, settingsForScripts, STORES_FILE, storesForScripts, type ExportContents } from "../shared/exportZip";
import { PACKAGE_ORIGIN } from "../shared/packageImports";
import { isInFolder, movedPath } from "../shared/folders";
import { baseName, folderPathOfRowId, folderRowId, isFolderRowId, movedCollapsed, type TreeRow } from "./explorerTree";
import { dataPathOfDecl } from "./jsonTypes";
import { dialogs, openHelp, openSettings, pickItems, resolveConflict } from "./state/dialogs";
import { folderStateText, setHelperStatus, settings } from "./state/settings";
import { watchTheme, type Theme } from "./theme";
import * as fsBridge from "./fsBridge";
import { cleanScriptName, isTsxName, scriptNameProblem, scriptFileName, scriptFileKey, scriptPathKey, scriptNameFromFile, uniqueScriptName, dataFilePathProblem, folderPathProblem } from "../shared/scriptName";
import { jsxElementAt } from "../shared/builtinSpecs";
import { vscodeTargetPath, editorLaunchUrl, launchAppName, type LaunchMode } from "./bundle";
import { computeDirty } from "./dirtyState";
import { parseSettings, SETTINGS_FILE, isBodyCap, BODY_CAP_KEY, DEFAULT_BODY_CAP } from "../shared/settingsJson";
import { createNetStore, type NetStore } from "./network/netStore";
import { installTooltips } from "./tooltip";
import type { ScriptHealthInput } from "../shared/scriptHealth";
import type { Uri, IPosition, IRange, IKeyboardEvent, editor as MonacoEditor } from "monaco-editor";
import type { Script } from "../background/engine/scriptStore";
import type { DataFile } from "../background/engine/dataFiles";
import { currentSide, currentDock } from "./panelDock";
import { collectProblems, settingsLink, type Problem, type ProblemGroup, type ProblemMarker } from "./problems";
import { touchCounts } from "./network/netFormat";
import { ref, subscribe } from "valtio";
import { flushSync } from "react-dom";
import { layout, panelTabOf, type PanelTab } from "./state/layout";
import { appendLog, clearLog, logState } from "./state/log";
import { badges, badgesChanged, panel, setNetStore, setProblems } from "./state/panel";
import { actions } from "./shell/actions";
import { clearSel, everyFolder, explorer, explorerIds, isVirtualRootId, moveFocus, pruneCollapsed, revealInExplorer, setCollapsed, setSel, SETTINGS_ID, STORES_ID, startCreate as startCreateRow, syncExplorer, treeRow, treeRows, visibleRows, type NewKind } from "./state/explorer";
import { watchPackages } from "./state/packages";
import { createCodeEditor } from "./shell/codeEditor";
import { toolbar, type SaveState } from "./state/toolbar";
import { refreshUserScripts } from "./state/userScripts";
import { SITE_DISALLOWED, SITE_NO_STORES } from "../shared/remote";
import { onPageEdit, siteStoreEdits, type TextEdit } from "./placeFix";
import { collectDiagnostics, diagnosticsFileName, downloadText, installedExtensions } from "./about";
import { DIAG_SECTIONS } from "../shared/diagnosticsSections";

// ---- state ----
let scripts: (Script & { runtimeError?: ScriptHealthInput["runtimeError"]; typeErrors?: string[]; ruleErrors?: string[]; routeWarnings?: string[] })[] = [];
/** data files (JSON), by path; folders: every folder (explicit + implied), sorted */
let dataFiles: DataFile[] = [];
let folders: string[] = [];
let selectedId: string | null = null;
let editor: any = null;
let tsWorkspace: TsWorkspace | null = null;
let dirty = false;
/** tt-api.d.ts is shown read-only over the selected script (whose model,
 * unsaved edits included, stays as it is underneath) */
let typingsShown = false;

/** Central dirty-state toggle: dims/undims Save. */
function setDirty(v: boolean): void {
    dirty = v;
    flushSync(() => void (explorer.dirty = v));
    setSaveState(v ? "unsaved" : "saved");
}

/** The Save button is the save indicator: ● unsaved, spinner while saving, ✓ saved. */
function setSaveState(state: SaveState): void {
    const can = state === "unsaved" && !typingsShown;
    flushSync(() => void Object.assign(toolbar.save, { state, disabled: !can, dim: !can }));
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

/** an element React rendered (for focus) */
const byId = (id: string): HTMLElement => document.getElementById(id)!;

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

/** Toolbar status line; with onClick it renders as a link-like action. */
function status(text: string, cls = "", onClick?: () => void): void {
    toolbar.status = { text, cls, onClick: onClick ?? null };
}

// ---- script list ----
let settingsModel: any = null;
let storesModel: any = null;

async function loadSettingsModel(force = false): Promise<void> {
    if (!editor) return;
    const monaco = (window as any).monaco;
    const { text } = await send({ type: "getSettingsJson" });
    if (!settingsModel) {
        settingsModel = monaco.editor.createModel(text, "json", monaco.Uri.parse("file:///" + SETTINGS_FILE));
        setBaseline(settingsModel, text);
    } else if (settingsModel.getValue() !== text && (force || !(selectedId === SETTINGS_ID && dirty))) {
        applyingExternal = true;
        settingsModel.setValue(text);
        applyingExternal = false;
        setBaseline(settingsModel, text);
    }
}

async function loadStoresModel(force = false): Promise<void> {
    if (!editor) return;
    const monaco = (window as any).monaco;
    const { text } = await send({ type: "getStoresJson" });
    if (!storesModel) {
        storesModel = monaco.editor.createModel(text, "json", monaco.Uri.parse("file:///" + STORES_FILE));
        setBaseline(storesModel, text);
    } else if (storesModel.getValue() !== text && (force || !(selectedId === STORES_ID && dirty))) {
        applyingExternal = true;
        storesModel.setValue(text);
        applyingExternal = false;
        setBaseline(storesModel, text);
    }
}

function registerManifestAssist(): void {
    const monaco = (window as any).monaco;
    // a package's metadata.json: "scripts" completes the .ts/.tsx files in its folder
    monaco.languages.registerCompletionItemProvider("json", {
        triggerCharacters: ['"', "/"],
        provideCompletionItems(model: any, position: any) {
            const path = decodeURIComponent(model.uri.path).replace(/^\//, "");
            if (baseName(path) !== MANIFEST_FILE) return { suggestions: [] };
            const folder = path.slice(0, path.length - MANIFEST_FILE.length).replace(/\/$/, "");
            const r = manifestScriptCompletions(model.getValue(), model.getOffsetAt(position), folder, scripts.map((s) => scriptFileName(s.meta.name)));
            if (!r) return { suggestions: [] };
            const a = model.getPositionAt(r.replaceFrom);
            const b = model.getPositionAt(r.replaceTo);
            const range = { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
            return {
                suggestions: r.paths.map((p, i) => ({
                    label: p,
                    kind: monaco.languages.CompletionItemKind.File,
                    insertText: r.inString ? p : JSON.stringify(p),
                    filterText: r.inString ? p : JSON.stringify(p),
                    detail: "script in this package's folder",
                    sortText: String(i).padStart(4, "0"),
                    range,
                })),
            };
        },
    });
}

async function selectSettings(): Promise<void> {
    // back from the typings: settings.json's unsaved edits are still in its model
    const back = typingsShown && selectedId === SETTINGS_ID;
    leaveTypings();
    selectedId = SETTINGS_ID;
    explorer.focusedId = null;
    showWelcome(false);
    renderList();
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
    const res = await send({ type: "applySettingsJson", text: editor.getValue() });
    if (res && res.error) {
        setSaveState("unsaved");
        status(`${SETTINGS_FILE}: ${res.error}`, "error");
        return;
    }
    await loadSettingsModel(true);
    setDirty(false);
    status("");
    await refresh();
}

async function selectStores(): Promise<void> {
    const back = typingsShown && selectedId === STORES_ID;
    leaveTypings();
    selectedId = STORES_ID;
    explorer.focusedId = null;
    showWelcome(false);
    renderList();
    await loadStoresModel(!back);
    if (editor.getModel() !== storesModel) {
        captureViewState();
        editor.setModel(storesModel);
        restoreViewState(storesModel);
    }
    if (back) updateDirty();
    else {
        setDirty(false);
        status("");
    }
    updateOpenVscode();
}

async function saveStores(): Promise<void> {
    setSaveState("saving");
    const res = await send({ type: "applyStoresJson", text: editor.getValue() });
    if (res && res.error) {
        setSaveState("unsaved");
        status(`${STORES_FILE}: ${res.error}`, "error");
        return;
    }
    await loadStoresModel(true);
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
    if (dirty && selectedId && !isVirtualRootId(selectedId) && !known(selectedId)) {
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
    renderList();
    pruneCollapsed();
    syncWorkspace();
    updateJsonSchemas(scripts.map((s: any) => ({ name: scriptFileName(s.meta.name), declared: s.meta.active !== false, enabled: s.enabled, defs: s.paramDefs ?? {}, values: {} })));
    scheduleDiagnostics();
    if (selectedId && !isVirtualRootId(selectedId) && !known(selectedId)) {
        selectedId = null;
    }
    if (isVirtualRootId(selectedId)) return;
    if (!selectedId && scripts.length > 0) {
        selectReal(scripts[0].id);
    } else if (!selectedId) {
        renderEditorEmpty();
        if (!scripts.length) showWelcome(true);
    }
}

/** editor.ts's state → the explorer tree (rendered now) */
function renderList(): void {
    updateEnabledToggle();
    scheduleProblems();
    flushSync(() => syncExplorer({ scripts, dataFiles, folders, selectedId, typingsShown, dirty }));
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
    const cur = explorer.focusedId ?? selectedId;
    const gone = (id: string, path: string): boolean => chosen.has(id) || inside(path);
    if (cur && treeRow(cur) && gone(cur, treeRow(cur)!.path)) {
        const goneIds = new Set(visibleRows().filter((r) => gone(r.id, r.path)).map((r) => r.id));
        const ids = explorerIds();
        const i = ids.indexOf(cur);
        explorer.focusedId = ids.slice(i + 1).find((id) => !goneIds.has(id)) ?? ids.slice(0, Math.max(i, 0)).reverse().find((id) => !goneIds.has(id)) ?? null;
    }
    clearSel();
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

/** Editor toolbar switch: enable/disable the open script (hidden for settings.json, data files and libraries). */
function updateEnabledToggle(): void {
    const script = typingsShown ? undefined : scripts.find((s) => s.id === selectedId);
    toolbar.enabled = !script || script.meta.active === false ? null : !!script.enabled;
}

/** ⇧⌘E: show the explorer and put the focus in it */
function focusExplorer(): void {
    if (layout.sidebarHidden) setSidebarHidden(false);
    flushSync(() => void (explorer.sectionOpen = true));
    byId("script-list").focus();
    flushSync(() => moveFocus(explorer.focusedId ?? selectedId ?? SETTINGS_ID));
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

/** Rename or move scripts, data files or folders (with their contents) to their new paths. */
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
                setCollapsed(movedCollapsed(explorer.collapsed, row.path, to));
                const f = explorer.focusedId;
                if (f === row.id) explorer.focusedId = folderRowId(to);
                else if (f && isFolderRowId(f) && isInFolder(folderPathOfRowId(f), row.path)) explorer.focusedId = folderRowId(movedPath(folderPathOfRowId(f), row.path, to));
                if (explorer.sel.has(row.id)) setSel([...explorer.sel].map((id) => (id === row.id ? folderRowId(to) : id)));
            }
        }
        if (r?.error) status(`can't move "${row.path}": ${r.error}`, "error");
        else revealInExplorer(to);
    }
    await refresh();
}

/** every file of the scripts as saved (path → text), and what each path is */
function userFiles(): { files: Record<string, string>; owner: Map<string, { script?: Script; data?: DataFile }> } {
    const files: Record<string, string> = {};
    const owner = new Map<string, { script?: Script; data?: DataFile }>();
    for (const x of scripts) {
        files[scriptFileName(x.meta.name)] = x.code;
        owner.set(scriptFileName(x.meta.name), { script: x });
    }
    for (const d of dataFiles) {
        files[d.path] = d.text;
        owner.set(d.path, { data: d });
    }
    return { files, owner };
}

function download(name: string, data: BlobPart, type: string): void {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Explorer → Export Package…: a script (or a bundle's metadata.json, at
 * `start`) and every file it brings, as saved — one file as itself, more as
 * a .zip of a folder named after the package (Install Script… takes either).
 */
async function exportPackage(start: string): Promise<void> {
    const { files } = userFiles();
    let pkg;
    try {
        pkg = await localPackage(files, start);
    } catch (e: any) {
        return void status(`can't export "${start}": ${e?.message || e}`, "error");
    }
    const paths = Object.keys(pkg.files);
    const stem = (pkg.manifest ? baseName(folderOf(start)) : entryStem(pkg.entries[0])) || "package";
    if (paths.length === 1) download(baseName(paths[0]), isImageDataPath(paths[0]) ? (imageDataUrlToBytes(pkg.files[paths[0]]) as BlobPart) : pkg.files[paths[0]], "text/plain");
    else download(`${stem}.zip`, writeZip(Object.fromEntries(paths.map((p) => [`${stem}/${p}`, isImageDataPath(p) ? imageDataUrlToBytes(pkg.files[p]) : pkg.files[p]]))) as BlobPart, "application/zip");
    const warn = [
        pkg.bare.length ? `imports by bare name stay behind: ${[...new Set(pkg.bare.map((b) => `"${b.spec}"`))].join(", ")}` : "",
        pkg.missing.length ? `imports that point at no file: ${pkg.missing.map((m) => `"${m.spec}"`).join(", ")}` : "",
    ].filter(Boolean);
    const dirtyNote = dirty ? " (as saved)" : "";
    status(`exported "${stem}" — ${paths.length === 1 ? baseName(paths[0]) : `${stem}.zip, ${paths.length} files`}${dirtyNote}${warn.length ? ` · ${warn.join(" · ")}` : ""}`, warn.length ? "dirty" : undefined);
}

const pathList = (paths: string[]): string => paths.map((p) => `  ${p}`).join("\n");
const bareNote = (bare: { spec: string }[]): string =>
    bare.length ? `\nImports by bare name resolve from the root of the installer's scripts, not the package: ${[...new Set(bare.map((b) => `"${b.spec}"`))].join(", ")} — use a relative path ("./…") to take the file along.` : "";
const missingNote = (missing: { from: string; spec: string }[]): string => (missing.length ? `\nImports that point at no file: ${missing.map((m) => `"${m.spec}" in ${m.from}`).join(", ")}` : "");

/** save through the background; false (and a status) when it failed — a compile error still saves */
async function saveQuietly(msg: Record<string, unknown>, path: string): Promise<boolean> {
    const r = await send(msg);
    if (r?.error && !r.id) status(`can't write "${path}": ${r.error}`, "error");
    return !(r?.error && !r.id);
}

/**
 * Explorer → Make Package… on a script: name it with tt.metadata, or — when
 * it imports files — move it and them into a folder of their own with a
 * metadata.json (copying those other scripts use too) and rewrite their
 * imports (shared/makePackage).
 */
async function makePackage(id: string): Promise<void> {
    const s = scripts.find((x) => x.id === id);
    if (!s) return;
    const { files, owner } = userFiles();
    const plan = makePackagePlan(scriptFileName(s.meta.name), files, everyFolder());
    const changed = [...plan.files.filter((f) => !f.copy && (f.to !== f.from || f.text !== files[f.from])).map((f) => f.from), ...plan.edits.map((e) => e.path)];
    const open = changed.map((p) => owner.get(p)?.script?.id ?? owner.get(p)?.data?.id).find((x) => x === selectedId);
    if (open && dirty) return void status(`save "${treeRow(open)?.path ?? ""}" first — making the package changes it`, "error");
    if (!plan.manifest && !changed.length) return void status(`"${s.meta.name}" names itself (tt.metadata) already — share its URL, or Export Package…`);
    const moved = plan.files.filter((f) => !f.copy && f.to !== f.from);
    const copied = plan.files.filter((f) => f.copy);
    const lines = [
        !plan.manifest
            ? `Make "${scriptFileName(s.meta.name)}" a package? It gets a tt.metadata({ name, version… }) to fill in.`
            : plan.inPlace
              ? `"${plan.folder}/" holds this script and what it imports: make it a package with a ${MANIFEST_FILE}?`
              : `Make "${scriptFileName(s.meta.name)}" a package in the folder "${plan.folder}/" (with a ${MANIFEST_FILE})?`,
        moved.length ? `\nMoves:\n${pathList(moved.map((f) => `${f.from} → ${f.to}`))}` : "",
        copied.length ? `\nCopies (other scripts use them too):\n${pathList(copied.map((f) => `${f.from} → ${f.to}`))}` : "",
        plan.edits.length ? `\nUpdates the imports in:\n${pathList(plan.edits.map((e) => e.path))}` : "",
        bareNote(plan.bare),
        missingNote(plan.missing),
    ];
    if (!confirm(lines.filter(Boolean).join("\n"))) return;
    let ok = true;
    // what's imported first, the script last: each compiles against files in their new places
    for (const f of [...plan.files].reverse()) {
        const o = owner.get(f.from)!;
        if (o.data) ok = (f.copy ? await saveQuietly({ type: "saveDataFile", path: f.to, text: f.text }, f.to) : f.to === f.from || (await saveQuietly({ type: "renameDataFile", id: o.data.id, path: f.to }, f.to))) && ok;
        else if (f.copy) ok = (await saveQuietly({ type: "saveScript", id: uuid(), code: f.text, name: scriptNameFromFile(f.to) }, f.to)) && ok;
        else if (f.to !== f.from || f.text !== files[f.from]) ok = (await saveQuietly({ type: "saveScript", id: o.script!.id, code: f.text, ...(f.to !== f.from ? { name: scriptNameFromFile(f.to) } : {}) }, f.to)) && ok;
    }
    for (const e of plan.edits) ok = (await saveQuietly({ type: "saveScript", id: owner.get(e.path)!.script!.id, code: e.text }, e.path)) && ok;
    if (plan.manifest) ok = (await saveQuietly({ type: "saveDataFile", path: plan.manifest.path, text: plan.manifest.text }, plan.manifest.path)) && ok;
    await refresh();
    revealInExplorer(plan.manifest?.path ?? plan.files[0].to);
    if (plan.manifest) {
        const m = dataFiles.find((d) => d.path === plan.manifest!.path);
        await select(m?.id ?? id);
    } else await select(id);
    if (ok) status(plan.manifest ? `"${plan.folder}/" is a package — fill in its ${MANIFEST_FILE}, then share the folder (or Export Package…)` : `"${s.meta.name}" is a package — fill in its tt.metadata, then share its URL (or Export Package…)`);
}

/** Explorer → Make Package… on a folder: a metadata.json listing its scripts (shared/makePackage) */
async function makeFolderPackage(folder: string): Promise<void> {
    const { files } = userFiles();
    const plan = makeFolderPackagePlan(folder, files);
    if (!plan.scripts.length) return void status(`"${folder}/" holds no script to package`, "error");
    const lines = [
        `Make "${folder}/" a package? It gets a ${MANIFEST_FILE} listing its scripts:\n${pathList(plan.scripts)}`,
        plan.outside.length ? `\nImports of files outside the folder can't come along — move those files in first: ${plan.outside.map((m) => `"${m.spec}" in ${m.from}`).join(", ")}` : "",
        bareNote(plan.bare),
        missingNote(plan.missing),
    ];
    if (!confirm(lines.filter(Boolean).join("\n"))) return;
    const ok = await saveQuietly({ type: "saveDataFile", path: plan.manifest.path, text: plan.manifest.text }, plan.manifest.path);
    await refresh();
    revealInExplorer(plan.manifest.path);
    const m = dataFiles.find((d) => d.path === plan.manifest.path);
    if (m) await select(m.id);
    if (ok) status(`"${folder}/" is a package — fill in its ${MANIFEST_FILE}, then share the folder (or Export Package…)`);
}

/**
 * New Script / New JSON File / New Folder: shows the explorer, then an inline
 * name input in `folder` (default: the focused folder, or the focused file's folder).
 */
function startCreate(kind: NewKind, folder?: string): void {
    if (explorer.editing) return;
    if (layout.sidebarHidden) setSidebarHidden(false);
    flushSync(() => startCreateRow(kind, folder));
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
        const initial = isSvgPath(path)
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n</svg>\n'
            : isMarkdownPath(path)
              ? `# ${baseName(path).replace(/\.md$/i, "")}\n`
              : "{}\n";
        const r = await send({ type: "saveDataFile", path, text: initial });
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
        explorer.focusedId = folderRowId(path);
        await refresh();
        byId("script-list").focus();
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
            // not checked yet at its current version: keep what's stored
            if (!tsWorkspace?.isChecked(m)) continue;
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

// ---- JSX in a .ts script: quick fix that renames the script to .tsx ----
const RENAME_TO_TSX = "tt.renameToTsx";
const scriptIdOfModel = (m: any): string | undefined => [...models].find(([, x]) => x === m)?.[0];

async function renameToTsx(id: string): Promise<void> {
    const s = scripts.find((x) => x.id === id);
    if (!s || isTsxName(s.meta.name)) return;
    const to = s.meta.name + ".tsx";
    const problem = itemPathProblem("script", to, id);
    if (problem) return void status(`can't rename to "${to}": ${problem}`, "error");
    await moveRows([{ item: { kind: "script", id, path: s.meta.name } as TreeRow, to }]);
}

function registerTsxFix(): void {
    const monaco = (window as any).monaco;
    monaco.editor.registerCommand(RENAME_TO_TSX, (_accessor: unknown, id: string) => void renameToTsx(id));
    monaco.languages.registerCodeActionProvider("typescript", {
        provideCodeActions(model: any, _range: unknown, context: { markers: any[] }) {
            const mk = context.markers.find((x) => (typeof x.code === "object" ? x.code?.value : x.code) === JSX_IN_TS);
            const id = mk && scriptIdOfModel(model);
            const s = id && scripts.find((x) => x.id === id);
            if (!s) return { actions: [], dispose() {} };
            const title = `Rename to ${baseName(s.meta.name)}.tsx`;
            return { actions: [{ title, kind: "quickfix", isPreferred: true, diagnostics: [mk], command: { id: RENAME_TO_TSX, title, arguments: [s.id] } }], dispose() {} };
        },
    });
}

/** "<name>@<range>" → the exact version unpkg resolves it to */
const resolvedVersions = new Map<string, Promise<string>>();
function resolvePackageVersion(name: string, range: string): Promise<string> {
    const key = `${name}@${range}`;
    let v = resolvedVersions.get(key);
    if (!v) {
        v = send<{ version?: string; error?: string }>({ type: "resolvePackageVersion", name, range }).then((r) => (r?.version ? r.version : Promise.reject(new Error(r?.error || "no version"))));
        resolvedVersions.set(key, v);
        v.catch(() => resolvedVersions.delete(key));
    }
    return v;
}

function registerPinImportFix(): void {
    const monaco = (window as any).monaco;
    monaco.languages.registerCodeActionProvider("typescript", {
        async provideCodeActions(model: any, _range: unknown, context: { markers: any[] }) {
            const actions: any[] = [];
            for (const mk of context.markers) {
                if ((typeof mk.code === "object" ? mk.code?.value : mk.code) !== UNPINNED) continue;
                const pin = badPackageImports(`import "${model.getValueInRange(mk)}"`)[0]?.pin;
                if (!pin) continue;
                let version: string;
                try {
                    version = await resolvePackageVersion(pin.name, pin.range);
                } catch {
                    continue;
                }
                if (model.isDisposed()) break;
                actions.push({
                    title: `Pin to ${pin.name}@${version}${pin.range === "latest" ? " (latest)" : ` (${pin.range})`}`,
                    kind: "quickfix",
                    isPreferred: true,
                    diagnostics: [mk],
                    edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: mk, text: `${PACKAGE_ORIGIN}${pin.name}@${version}${pin.sub ? `/${pin.sub}` : ""}` } }] },
                });
            }
            return { actions, dispose() {} };
        },
    });
}

/**
 * Quick fixes for where a handler runs: an onSite handler calling a handle
 * (a runtime Problem) or using a store / handle (a route warning) moves to
 * tt.onPage; one using a store can keep running in the site, its stores
 * becoming `tt.siteStore`s.
 */
function registerPlaceFixes(): void {
    const monaco = (window as any).monaco;
    monaco.languages.registerCodeActionProvider("typescript", {
        provideCodeActions(model: any, _range: unknown, context: { markers: any[] }) {
            const actions: any[] = [];
            for (const mk of context.markers) {
                const msg = String(mk.message);
                if (!msg.includes(SITE_DISALLOWED)) continue;
                // the marker's end: inside the call, or (a route warning, on the registration line) past `tt.onSite(`
                const offset = model.getOffsetAt({ lineNumber: mk.endLineNumber, column: mk.endColumn });
                const textEdit = (fix: TextEdit) => {
                    const a = model.getPositionAt(fix.start);
                    const b = model.getPositionAt(fix.end);
                    return { resource: model.uri, versionId: model.getVersionId(), textEdit: { range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: fix.text } };
                };
                const fix = onPageEdit(model.getValue(), offset);
                if (!fix) continue;
                actions.push({
                    title: "Move this handler to tt.onPage (the isolated world)",
                    kind: "quickfix",
                    isPreferred: true,
                    diagnostics: [mk],
                    edit: { edits: [textEdit(fix)] },
                });
                const site = msg.includes(SITE_NO_STORES) ? siteStoreEdits(model.getValue(), offset) : [];
                if (site.length)
                    actions.push({
                        title: "Change to tt.siteStore (its data becomes page data)",
                        kind: "quickfix",
                        diagnostics: [mk],
                        edit: { edits: site.map(textEdit) },
                    });
            }
            return { actions, dispose() {} };
        },
    });
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

/** the model's path is the script's file: a .tsx script's (TypeScript parses JSX only there) is .tsx */
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
        }
        if (!m) {
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(s.code, "typescript", uri);
            models.set(s.id, m);
            setBaseline(m, s.code);
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
/** a data file's Monaco language: .svg is XML, .md is Markdown, raster images are plaintext */
const dataLanguage = (path: string): string => (isSvgPath(path) ? "xml" : isMarkdownPath(path) ? "markdown" : isImageDataPath(path) ? "plaintext" : "json");

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
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(old.getValue(), dataLanguage(d.path), uri);
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
            m.onDidChangeContent(scheduleManifestMarkers);
        }
        if (!m) {
            m = monaco.editor.getModel(uri) || monaco.editor.createModel(d.text, dataLanguage(d.path), uri);
            dataModels.set(d.id, m);
            setBaseline(m, d.text);
            m.onDidChangeContent(scheduleDataTypings);
            m.onDidChangeContent(scheduleManifestMarkers);
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
    scheduleManifestMarkers();
}

/** Stage script + data-file model changes as one atomic TypeScript workspace commit. */
function syncWorkspace(): void {
    if (!editor || !tsWorkspace) return;
    const shown = editor.getModel();
    const changedDecls = tsWorkspace.sync(
        () => {
            syncModels();
            syncDataModels();
        },
        () =>
            scripts.flatMap((s) => {
                const model = models.get(s.id);
                return model ? [{ id: s.id, name: s.meta.name, model }] : [];
            }),
        () => dataFiles.map((d) => ({ path: d.path, text: dataModels.get(d.id)?.getValue() ?? d.text }))
    );
    disposeStaleDeclModels(changedDecls, shown);
}

/** a declaration Go to Definition opened as a model hides the new extraLib from TypeScript */
function disposeStaleDeclModels(changedUris: string[], shown: any): void {
    const monaco = (window as any).monaco;
    for (const uri of changedUris) {
        const stale = monaco.editor.getModel(monaco.Uri.parse(uri));
        if (stale && stale !== shown) stale.dispose();
    }
}

/** a package's metadata.json: an error on each "scripts" entry that names no script */
const MANIFEST_OWNER = "tt-manifest";
let manifestMarkerTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleManifestMarkers(): void {
    if (manifestMarkerTimer) clearTimeout(manifestMarkerTimer);
    manifestMarkerTimer = setTimeout(() => {
        manifestMarkerTimer = null;
        const monaco = (window as any).monaco;
        const files = scripts.map((s) => scriptFileName(s.meta.name));
        for (const d of dataFiles) {
            const m = dataModels.get(d.id);
            if (!m || m.isDisposed() || baseName(d.path) !== MANIFEST_FILE) continue;
            const markers = manifestScriptProblems(m.getValue(), d.path.slice(0, -MANIFEST_FILE.length), files).map((p) => {
                const a = m.getPositionAt(p.start);
                const b = m.getPositionAt(p.end);
                return { severity: monaco.MarkerSeverity.Error, message: p.message, source: MANIFEST_FILE, startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
            });
            if (markers.length || monaco.editor.getModelMarkers({ resource: m.uri, owner: MANIFEST_OWNER }).length) monaco.editor.setModelMarkers(m, MANIFEST_OWNER, markers);
        }
    }, 250);
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
    if (!tsWorkspace) return;
    const shown = editor?.getModel();
    const changed = tsWorkspace.setDataFiles(dataFiles.map((d) => ({ path: d.path, text: dataModels.get(d.id)?.getValue() ?? d.text })));
    disposeStaleDeclModels(changed, shown);
}

async function renderEditorEmpty(): Promise<void> {
    leaveTypings();
    toolbar.save.disabled = true;
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

/** ↗ opens a file only while folder sync is active and one is open (the toolbar also needs a launch target). */
function updateOpenVscode(): void {
    toolbar.canOpen = syncActive && !!selectedId && !typingsShown;
}

function selectReal(id: string): void {
    // back from the typings to the script under them: keep its unsaved edits
    const back = typingsShown && id === selectedId;
    leaveTypings();
    selectedId = id;
    explorer.focusedId = null;
    renderList();
    const script = scripts.find((s) => s.id === id);
    const data = script ? undefined : dataFiles.find((d) => d.id === id);
    if (!script && !data) return;
    showWelcome(false);
    syncWorkspace();
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

// ---- tt-api.d.ts, read-only (Go to Definition) ----
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
    editor.updateOptions({ readOnly: true, readOnlyMessage: { value: "tt-api.d.ts is the TangiTweak API typings — read-only" } });
    restoreViewState(m);
    toolbar.typings = true;
    Object.assign(toolbar.save, { disabled: true, dim: true });
    renderList();
    updateOpenVscode();
}

/** Flip the Code view back to editable; the caller shows the next model. */
function leaveTypings(): void {
    if (!typingsShown) return;
    captureViewState();
    typingsShown = false;
    editor.updateOptions({ readOnly: false });
    toolbar.typings = false;
}

/** a place in the Code view: a script id / SETTINGS_ID / TYPINGS_ID + cursor and scroll */
interface NavEntry {
    target: string;
    view: any;
}
const TYPINGS_ID = "__tt_api_typings__";
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

/** Show a declaration in tt-api.d.ts read-only. */
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
    if (!isVirtualRootId(e.target) && !scripts.some((s) => s.id === e.target) && !isDataId(e.target)) return "skip";
    if (e.target !== selectedId && dirty && selectedId && !confirm("Discard unsaved changes?")) return false;
    if (e.target === SETTINGS_ID) {
        if (typingsShown || selectedId !== SETTINGS_ID) void selectSettings().then(restore);
        else restore();
        return true;
    }
    if (e.target === STORES_ID) {
        if (typingsShown || selectedId !== STORES_ID) void selectStores().then(restore);
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
    if (selectedId === STORES_ID) return saveStores();
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
        const choice = await resolveConflict({ name: data.path, theirs: deleted ? null : result.text, mine: text, kind: "data file", language: dataLanguage(data.path) });
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

// ---- logs ----
function connectLogs(): void {
    const port = chrome.runtime.connect({ name: "logs" });
    port.onMessage.addListener((msg: any) => {
        if (msg.type === "log") appendLog(msg.entry);
        if (msg.type === "processStatus") setHelperStatus(msg.status);
        if (msg.type === "scriptErrors") {
            for (const s of scripts) {
                s.runtimeError = msg.errors[s.id] ?? null;
                s.typeErrors = msg.typeErrors?.[s.id] ?? [];
                s.ruleErrors = msg.ruleErrors?.[s.id] ?? [];
                s.routeWarnings = msg.routeWarnings?.[s.id] ?? [];
            }
            renderList();
            // scripts or their routes changed: is isolated code waiting for user scripts?
            refreshUserScripts();
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
            syncActive = msg.status.active;
            fsBridge.setCachedActive(msg.status.active);
            if (msg.status.active) {
                markFolderSynced();
            } else {
                settings.folder.mode = "off";
            }
        }
    });
}

// ---- Panel counts: Log errors/warnings, Network observed/modified requests
// and Problems, shown in the status bar until that view is cleared (state/panel) ----

/** Network counts from a passive connection: live before the Network tab is ever opened. */
function watchNetCounts(): void {
    const store = createNetStore();
    netCounts = store;
    const update = () => {
        badges.network.set(touchCounts(store.state.entries));
        badgesChanged();
    };
    update();
    subscribe(store.state, update);
    store.connect(undefined, "network-counts");
}

// ---- Problems view: what is wrong with each script right now (VS Code's
// Problems). Entries go away by themselves once fixed; the Log keeps history. ----
let problemGroups: ProblemGroup[] = [];
let problemsTimer: ReturnType<typeof setTimeout> | null = null;

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

/** command behind a problem hover's settings link (command:…?["settings-sec-helper"]) */
const OPEN_SETTINGS_SECTION = "tt.openSettingsSection";
let settingsCommandRegistered = false;
function registerSettingsCommand(): void {
    if (settingsCommandRegistered) return;
    settingsCommandRegistered = true;
    (window as any).monaco.editor.registerCommand(OPEN_SETTINGS_SECTION, (_accessor: unknown, section?: string) => openSettings(section));
}

/** the owner of the markers for TangiTweak's own problems (compile, rules, runtime, route) */
const PROBLEM_OWNER = "tangitweak";
/** model → the problems its markers show */
const problemMarkerKeys = new WeakMap<any, string>();
let writingProblemMarkers = false;

function setProblemMarkers(m: any, markers: any[]): void {
    writingProblemMarkers = true;
    try {
        (window as any).monaco.editor.setModelMarkers(m, PROBLEM_OWNER, markers);
    } finally {
        writingProblemMarkers = false;
    }
}

/**
 * Squiggles for the problems Monaco doesn't mark itself (TypeScript and
 * settings.json problems are its own markers). Markers, like TypeScript's,
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
        // an import that can't load is already marked live (with its quick fix)
        const live = monaco.editor.getModelMarkers({ resource: m.uri, owner: IMPORT_OWNER }).map((x: any) => String(x.message));
        const own = (byId.get(s.id) || []).filter((p) => p.kind !== "ts" && p.kind !== "settings" && p.line && !(p.kind === "compile" && live.some((t: string) => p.message.includes(t))));
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
                // "(Settings → Local helper)" in the message: the hover links there
                const link = settingsLink(p.message);
                const code = link ? { value: ` · Open ${link.text}`, target: monaco.Uri.parse(`command:${OPEN_SETTINGS_SECTION}?${encodeURIComponent(JSON.stringify([link.section]))}`) } : p.kind;
                return { severity, message: p.message, source: "TangiTweak", code, startLineNumber: line, startColumn: column, endLineNumber: endLine, endColumn };
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
            if (!tsWorkspace?.isChecked(m) && m.getValue() === s.code && s.typeErrors?.length) continue;
            live.set(s.id, modelProblems(m));
        }
    }
    const settings = monaco && settingsModel && !settingsModel.isDisposed() ? modelProblems(settingsModel) : undefined;
    const data = monaco
        ? [
              ...(storesModel && !storesModel.isDisposed() ? [{ id: STORES_ID, label: STORES_FILE, markers: modelProblems(storesModel) }] : []),
              ...dataFiles.flatMap((d) => {
                  const m = dataModels.get(d.id);
                  return m && !m.isDisposed() ? [{ id: d.id, label: d.path, markers: modelProblems(m) }] : [];
              }),
          ]
        : [];
    // explorer order (settings.json, then stores.json, then tree rows)
    const order = new Map<string, number>([
        [SETTINGS_ID, -2],
        [STORES_ID, -1],
        ...treeRows(true).map((r, i) => [r.id, i] as [string, number]),
    ]);
    problemGroups = collectProblems(
        scripts.map((s) => ({ id: s.id, label: scriptFileName(s.meta.name), name: s.meta.name, error: s.error, ruleErrors: s.ruleErrors, runtimeError: s.runtimeError, typeErrors: s.typeErrors, routeWarnings: s.routeWarnings, routes: s.meta.routes, code: s.code })),
        live,
        settings,
        data
    ).sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
    const bad = new Set(problemGroups.filter((g) => g.file === "json" && g.problems.some((p) => p.severity === "error")).map((g) => g.id));
    if ([...bad].join() !== [...explorer.jsonErrorIds].join()) {
        explorer.jsonErrorIds = ref(bad);
        renderList();
    }
    markProblems();
    setProblems(problemGroups);
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

/** the filter box of a panel view (Network's lives in a portal, once mounted) */
function panelFilter(which: PanelTab): HTMLInputElement | null {
    if (which === "problems") return byId("problems-filter") as HTMLInputElement;
    if (which === "log") return document.querySelector<HTMLInputElement>("#log-filter-host input.net-filter, #log-filter-host input.net-query");
    if (which === "preview") return byId("preview-url") as HTMLInputElement | null;
    return document.querySelector<HTMLInputElement>("#net-filter-host input.net-filter, #net-filter-host input.net-query");
}

/** Show a panel view and focus its filter; again (already there, focus in the panel): close the panel. */
function focusPanelView(which: PanelTab): void {
    if (!layout.panelHidden && panelTabOf(layout) === which && byId("log-panel").contains(document.activeElement)) {
        setPanelHidden(true);
        return;
    }
    setPanelHidden(false);
    showPanelTab(which);
    // Network mounts on first show and renders its filter a frame later
    let tries = 10;
    const focus = () => {
        const f = panelFilter(which);
        if (f) {
            f.focus();
            f.select();
        } else if (tries-- > 0) requestAnimationFrame(focus);
    };
    focus();
}

const toggleProblems = () => focusPanelView("problems");

/** Clear the Log and Network (Problems clear themselves once fixed). */
function clearPanelView(): void {
    if (layout.panelHidden) return;
    const tab = panelTabOf(layout);
    if (tab === "log" || tab === "network") clearPanel();
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

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// ---- dialogs: settings / help / samples (components in dialogs/, state in state/dialogs + state/settings) ----
let currentTheme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
const monacoTheme = () => (currentTheme === "light" ? "vs" : "vs-dark");

/** Manager-side context for the diagnostics report. */
function managerUiState(): Record<string, unknown> {
    const l = layout;
    return {
        theme: currentTheme,
        themePref: settings.themePref,
        wordWrap: !!l.wordWrap,
        sidebarHidden: !!l.sidebarHidden,
        panelHidden: !!l.panelHidden,
        panelDock: currentDock(),
        sidebarSide: currentSide(),
        logLevel: logState.level,
        logCap: logState.cap,
        monacoVerbose: settings.monacoVerbose,
        logBadge: panel.statusBar,
        scriptsFolder: folderStateText(settings.folder) || null,
    };
}

/** Runs from a click or editor command: the permission prompt needs that gesture. */
/** Collect diagnostics…: pick the report's sections and scripts (all by default), then download it */
async function runDiagnostics(): Promise<void> {
    const d = settings.diagnostics;
    if (d.busy) return;
    const listed = scripts.slice();
    let extensions: Promise<unknown> | undefined;
    const chosen = await pickItems({
        title: "Collect diagnostics",
        intro: "Pick what goes into the report. Review the file before sharing: scripts, settings and URLs are included as-is; cookies and authorization headers are redacted.",
        items: [
            ...DIAG_SECTIONS.map((x) => ({ path: x.label, kind: x.id === "settings" ? ("settings" as const) : ("section" as const), detail: x.detail })),
            ...listed.map((s) => ({ path: `Scripts/${scriptFileName(s.meta.name)}`, kind: "script" as const, badge: s.enabled ? undefined : "disabled" })),
        ],
        confirm: "Download",
        // in the click: the management permission prompt needs the user gesture
        onConfirm: (checked) => void (checked.includes(DIAG_SECTIONS.findIndex((x) => x.id === "extensions")) && (extensions = installedExtensions())),
    });
    if (!chosen) return;
    const sections = DIAG_SECTIONS.filter((_, i) => chosen.includes(i)).map((x) => x.id);
    const include = { sections, scripts: chosen.filter((i) => i >= DIAG_SECTIONS.length).map((i) => listed[i - DIAG_SECTIONS.length].id) };
    const netState = (state: "busy" | "ok" | "error", title: string) => void (panel.diagnostics = { state, title });
    Object.assign(d, { busy: true, report: "", text: "collecting…" });
    netState("busy", "Collecting diagnostics…");
    try {
        const name = diagnosticsFileName();
        const report = await collectDiagnostics(managerUiState(), { problems: sections.includes("problems") ? problemGroups : undefined, extensions: await extensions, include });
        downloadText(name, report, "text/markdown");
        Object.assign(d, { report, text: `downloaded (${Math.ceil(report.length / 1024)} KB)`, title: name });
        netState("ok", `Diagnostics downloaded: ${name}`);
        status(`diagnostics downloaded: ${name}`);
    } catch (e: any) {
        d.text = `failed: ${e?.message || e}`;
        netState("error", `Diagnostics failed: ${e?.message || e}`);
        status(`diagnostics failed: ${e?.message || e}`, "error");
    } finally {
        d.busy = false;
        const shown = panel.diagnostics;
        setTimeout(() => panel.diagnostics === shown && (panel.diagnostics = null), 2500);
    }
}

function setMonacoVerbose(on: boolean, level?: string): void {
    settings.monacoVerbose = on;
    navLog(`verbose logging ${on ? "on" : "off"}`, level);
}

/** Load the stored settings into the stores, and follow later changes (settings.json edits land in storage). */
function setupSettings(): void {
    watchTheme((t, pref) => {
        currentTheme = t;
        settings.themePref = pref;
        (window as any).monaco?.editor.setTheme(monacoTheme());
    });
    settings.folder.supported = fsBridge.isSupported();
    const bodyCap = (v: unknown): number => (isBodyCap(v) ? v : DEFAULT_BODY_CAP);
    chrome.storage.local.get(["resLogLevel", "resMonacoVerbose", "resLogBadge", "resLogCap", BODY_CAP_KEY, "resVscodePath", "resVscodeLaunch", "resEditorUrl"], (d) => {
        if (d?.resLogLevel) logState.level = d.resLogLevel;
        setMonacoVerbose(!!d?.resMonacoVerbose);
        panel.statusBar = d?.resLogBadge !== false;
        if (d?.resLogCap) logState.cap = d.resLogCap;
        settings.bodyCap = bodyCap(d?.[BODY_CAP_KEY]);
        if (d?.resVscodePath) settings.vscodePath = d.resVscodePath;
        settings.launchMode = d?.resVscodeLaunch || "vscode";
        settings.editorUrl = d?.resEditorUrl || "";
        updateOpenVscode();
    });
    chrome.storage.onChanged.addListener((c) => {
        if (c[BODY_CAP_KEY]) settings.bodyCap = bodyCap(c[BODY_CAP_KEY].newValue);
        if (c.resLogLevel?.newValue) logState.level = c.resLogLevel.newValue;
        if (c.resLogCap?.newValue) logState.cap = c.resLogCap.newValue;
        const storeChanged = Object.keys(c).some((k) => k.startsWith("resStore."));
        if (storeChanged || c.resScripts) {
            if (selectedId === STORES_ID || storesModel) void loadStoresModel();
        }
        if (c.resScripts || c.resParams || c.resLogLevel || c.resLogCap || c[BODY_CAP_KEY] || c.resDataFiles || c.resFolders) {
            void (async () => {
                if (selectedId === SETTINGS_ID || settingsModel) await loadSettingsModel();
                // data files / folders change the script order (folders) or importers' errors
                if (c.resScripts || c.resDataFiles || c.resFolders) await refresh();
            })();
        }
    });
}

/** a script name not taken yet: `base`, else `base 2`, `base 3`… */
function freeScriptName(base: string, ext = ""): string {
    const taken = new Set(scripts.map((s) => s.meta.name));
    if (!taken.has(base + ext)) return base + ext;
    let n = 2;
    while (taken.has(`${base} ${n}${ext}`)) n++;
    return `${base} ${n}${ext}`;
}

/** add a sample as a new (enabled) script and open it; returns its id */
async function addSample(sample: SampleScript): Promise<string> {
    const id = newId();
    const name = freeScriptName(sample.name, jsxElementAt(sample.code) >= 0 ? ".tsx" : "");
    await send({ type: "saveScript", id, code: sample.code, name, enabled: true });
    await refresh();
    selectReal(id);
    status(`sample "${name}" added ✓`);
    return id;
}

/** Welcome → Try it: add the sample, wait until it runs (browser rules included) so the page loads with it, open the page. */
async function trySample(sample: SampleScript, url: string | null): Promise<void> {
    await addSample(sample);
    await send({ type: "settleScripts" });
    if (url) chrome.tabs.create({ url, active: true }, () => void chrome.runtime.lastError);
}

// ---- welcome page (onboarding): replaces the code view while there are no scripts; Help → Welcome reopens it ----
function showWelcome(open: boolean): void {
    dialogs.welcome = open;
}

// ---- toolbar folder sync button: off / disconnected / connected / sending / receiving ----
let folderNeedsGrant = false; // a saved folder waits for a permission click
/** folder sync is on; syncPath: the synced folder's absolute path, for ↗ */
let syncActive = false;
let syncPath = "";
function renderFolderSync(st: { active: boolean; path?: string; paused?: boolean; activity?: string }): void {
    if (st.active) folderNeedsGrant = false;
    else if (st.paused) folderNeedsGrant = true;
    const state = st.active ? (st.activity === "sending" || st.activity === "receiving" ? st.activity : "connected") : folderNeedsGrant ? "disconnected" : "off";
    toolbar.sync = { state, path: st.path ?? "" };
}

async function folderSyncButtonClicked(): Promise<void> {
    if (toolbar.sync.state === "disconnected" && (await fsBridge.reconnectClicked())) {
        await markFolderSynced();
        status("synced folder reconnected ✓");
        return;
    }
    openSettings("settings-sec-folder");
}

// ---- dedicated scripts folder: pick once, edits sync both ways ----
async function markFolderSynced(): Promise<void> {
    settings.folder.mode = "synced";
    syncActive = true;
    fsBridge.setCachedActive(true);
    updateOpenVscode();
    const st = await fsBridge.queryStatus();
    renderFolderSync(st);
    settings.folder.path = st.path || "";
    await refreshSyncPath();
    await checkFolderPath();
}

/** Absolute path used by the ↗ VS Code button. The sync-reported path is
 * absolute when Chrome can read it (handle.getPath); otherwise fall back
 * to the user-provided path from Settings. */
async function refreshSyncPath(): Promise<void> {
    const st = await fsBridge.queryStatus();
    if (st.path && st.path.startsWith("/")) {
        syncPath = st.path;
        return;
    }
    syncPath = settings.vscodePath;
}

/**
 * Flag Settings → Folder path while it's missing, or doesn't end in the name of
 * the folder that's synced (likely another folder's). `flash`: just picked —
 * draw the eye to it.
 */
async function checkFolderPath(flash = false): Promise<boolean> {
    const st = await fsBridge.queryStatus();
    const typed = settings.vscodePath.trim();
    const name = st.path && !st.path.startsWith("/") ? st.path : "";
    const need = !!st.active && !st.path?.startsWith("/") && (!typed || (!!name && baseName(typed.replace(/\\/g, "/")).toLowerCase() !== name.toLowerCase()));
    settings.folder.pathWarning = !need ? "" : !typed ? `⚠ Paste the absolute path of${name ? ` "${name}"` : " the synced folder"} here — the ↗ button can't open files without it.` : `⚠ This path doesn't end in "${name}", the synced folder — update it so ↗ opens the right files.`;
    if (need && flash) settings.folder.flash++;
    return need;
}

function newId(): string {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/** Settings → Choose / Change Folder…: pick a folder to sync (cancelling keeps the current one); Reconnect: re-grant the saved one */
async function folderButtonClicked(): Promise<void> {
    if (settings.folder.mode === "reconnect") {
        if (await fsBridge.reconnectClicked()) {
            await markFolderSynced();
            status("synced folder reconnected ✓");
        }
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
    await checkFolderPath(true);
}

/** Settings → Disconnect: stop syncing and forget the folder (its files stay) */
async function folderDisconnectClicked(): Promise<void> {
    await fsBridge.stopSync();
    syncActive = false;
    fsBridge.setCachedActive(false);
    settings.folder.mode = "off";
    settings.folder.path = "";
    folderNeedsGrant = false;
    renderFolderSync({ active: false });
    updateOpenVscode();
    void checkFolderPath();
    status("folder sync disconnected");
}

async function autoReconnectFolder(): Promise<void> {
    if (!fsBridge.isSupported()) return;
    const st = await fsBridge.autoReconnect();
    if (st === "synced") {
        await markFolderSynced();
    } else if (st === "prompt") {
        // one click re-grants (Chrome drops FS grants between restarts)
        settings.folder.mode = "reconnect";
        renderFolderSync({ active: false, paused: true });
        const reconnect = async (): Promise<void> => {
            if (fsBridge.isSyncing()) return;
            const ok = await fsBridge.reconnectClicked();
            if (ok) {
                await markFolderSynced();
                status("synced folder reconnected ✓");
            }
        };
        status("synced folder needs reconnect — click to reconnect", "dirty", () => void reconnect());
    }
}

// ---- movable panels ----
/** ⌘B: show/hide the explorer (VS Code's primary side bar). */
function setSidebarHidden(hidden: boolean): void {
    if (hidden && byId("sidebar").contains(document.activeElement)) editor?.focus();
    flushSync(() => void (layout.sidebarHidden = hidden));
    window.dispatchEvent(new Event("resize"));
}

/** ⌘J: show/hide the Log/Network panel wherever it is docked. */
function setPanelHidden(hidden: boolean): void {
    if (hidden && byId("log-panel").contains(document.activeElement)) editor?.focus();
    flushSync(() => void (layout.panelHidden = hidden));
    window.dispatchEvent(new Event("resize"));
}

const toggleSidebar = (): void => setSidebarHidden(!layout.sidebarHidden);
const togglePanel = (): void => setPanelHidden(!layout.panelHidden);

/** ⌥Z: soft-wrap long lines (remembered across sessions). */
function toggleWordWrap(): void {
    const on = !layout.wordWrap;
    layout.wordWrap = on;
    editor?.updateOptions({ wordWrap: on ? "on" : "off" });
}

/** the passive Network counts' store (the Network view records in its own once shown) */
let netCounts: NetStore | null = null;

/** VS Code–style panel views: PROBLEMS | LOG | NETWORK */
function showPanelTab(which: PanelTab): void {
    flushSync(() => {
        layout.panelTab = which;
        // recording starts the first time the view is shown (zero cost before)
        if (which === "network" && !panel.net) {
            const store = createNetStore();
            store.connect();
            setNetStore(store);
        }
    });
}

/** Clear the Log and Network: the recording too, whether or not the Network view was ever opened. */
function clearPanel(): void {
    (panel.net ?? netCounts)?.clear();
    clearLog();
    void send({ type: "clearDebugLogs" });
}

/** ↗: open the file in VS Code (or the custom editor) */
function openInEditor(): void {
    const folder = syncPath;
    if (!folder) {
        openSettings("settings-sec-folder");
        void checkFolderPath(true);
        return;
    }
    if (!selectedId || typingsShown) return;
    if (selectedId === STORES_ID) void send({ type: "ensureStoresOnDisk" });
    // the ⚙ settings.json and stores.json entries are virtual (not in `scripts`) — their
    // targets are <folder>/settings.json and <folder>/stores.json, written by folderSync
    const data = dataFiles.find((d) => d.id === selectedId);
    const file =
        selectedId === STORES_ID
            ? `${folder.replace(/\/+$/, "")}/${STORES_FILE}`
            : data
              ? `${folder.replace(/\/+$/, "")}/${data.path}`
              : vscodeTargetPath(folder, selectedId, scripts.find((s) => s.id === selectedId)?.meta.name, SETTINGS_ID, SETTINGS_FILE);
    const url = editorLaunchUrl(settings.launchMode, settings.editorUrl, file, editor?.getPosition?.()?.lineNumber || 1);
    if (!url) return;
    // launch from THIS page (user gesture): external-protocol requests
    // from the background page are dropped by Chromium
    const a = document.createElement("a");
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    status(`opening ${file} in ${launchAppName(settings.launchMode)}…`);
    const msg = `openInVscode → launching ${url}`;
    appendLog({ at: Date.now(), message: `[editor] ${msg}`, level: "info" });
    chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "editor", msg, level: "info" } }, () => void chrome.runtime.lastError);
}

// ---- import / export: a zip laid out like the scripts folder; both open a picker so any subset can travel ----
// the picker's items start with the scripts, then the data files (`data`, name = path)
const importsWarning = (names: { name: string; code: string; data?: boolean }[]) => (checked: number[]) => {
    const missing = missingImports(
        checked.filter((i) => i < names.length),
        names
    );
    if (!missing.length) return null;
    return {
        text: `selected scripts import ${missing.map((i) => `"${names[i].name}"`).join(", ")}, which ${missing.length > 1 ? "aren't" : "isn't"} selected`,
        fix: missing,
    };
};
/** Export…: pick what goes into the zip, then download it */
async function exportBundle(): Promise<void> {
    const { text } = selectedId === SETTINGS_ID && dirty && settingsModel ? { text: settingsModel.getValue() } : await send({ type: "getSettingsJson" });
    const dataFiles: { path: string; text: string }[] = (await send({ type: "listDataFiles" })) || [];
    const folders: string[] = (await send({ type: "listFolders" })) || [];
    const allStores: Record<string, Record<string, any>> = (await send({ type: "exportStores" }).catch(() => ({}))) || {};
    const hasStores = Object.keys(allStores).length > 0;
    const list = [
        ...scripts.map((s) => ({ name: s.meta.name, code: s.code, data: false })),
        ...dataFiles.map((d) => ({ name: d.path, code: d.text, data: true })),
    ];
    const empty = emptyFolders(folders, [...scripts.map((s) => scriptFileName(s.meta.name)), ...dataFiles.map((d) => d.path)]);
    const settingsAt = list.length;
    const storesAt = hasStores ? settingsAt + 1 : -1;
    const foldersAt = settingsAt + 1 + (hasStores ? 1 : 0);
    const chosen = await pickItems({
        title: "Export",
        intro: "Pick what goes into the zip. It's laid out like the scripts folder: scripts and data files by path, settings.json with globals and params, and optionally persisted globalStore data.",
        items: [
            ...scripts.map((s) => ({ path: scriptFileName(s.meta.name), kind: "script" as const, badge: s.meta.active !== false && !s.enabled ? "disabled" : undefined })),
            ...dataFiles.map((d) => ({ path: d.path, kind: "data" as const })),
            { path: SETTINGS_FILE, kind: "settings" as const, detail: "globals + the picked scripts' enabled state and params" },
            ...(hasStores
                ? [
                      {
                          path: STORES_FILE,
                          kind: "settings" as const,
                          badge: "opt-in",
                          detail: "persisted globalStore data for the picked scripts",
                          checked: false,
                      },
                  ]
                : []),
            ...empty.map((f) => ({ path: f, kind: "folder" as const, detail: "empty folder" })),
        ],
        confirm: "Export",
        warn: importsWarning(list),
    });
    if (!chosen) return;
    const picked = chosen.filter((i) => i < scripts.length).map((i) => list[i]);
    const pickedData = chosen.filter((i) => i >= scripts.length && i < settingsAt).map((i) => ({ path: list[i].name, text: list[i].code }));
    const withSettings = chosen.includes(settingsAt);
    const withStores = storesAt >= 0 && chosen.includes(storesAt);
    const pickedFolders = chosen.filter((i) => i >= foldersAt).map((i) => empty[i - foldersAt]);
    const storesJson = withStores ? storesForScripts(allStores, picked.map((s) => s.name)) : null;
    const zip = buildExportZip({
        settings: withSettings ? settingsForScripts(text, picked.map((s) => s.name)) : null,
        stores: storesJson,
        scripts: picked,
        dataFiles: pickedData,
        folders: pickedFolders,
    });
    download(picked.length === 1 && chosen.length === 1 ? `${baseName(picked[0].name)}.zip` : EXPORT_ZIP_NAME, zip as BlobPart, "application/zip");
    const parts = [
        plural(picked.length, "script"),
        ...(pickedData.length ? [plural(pickedData.length, "data file")] : []),
        ...(pickedFolders.length ? [plural(pickedFolders.length, "folder")] : []),
        ...(withSettings ? ["settings"] : []),
        ...(storesJson ? ["stores"] : []),
    ];
    status(`exported ${parts.join(" + ")} ✓`);
}
// an imported script replaces the existing script of the same name
const saveImported = async (item: { code: string; name?: string; enabled?: boolean }) => {
    // file names are case-insensitive on Windows/macOS: "Foo" replaces "foo"
    const existing = item.name ? scripts.find((s) => scriptFileKey(s.meta.name) === scriptFileKey(item.name!)) : undefined;
    await send({ type: "saveScript", id: existing?.id ?? uuid(), code: item.code, name: item.name, enabled: item.enabled });
};
const existsBadge = (name?: string) => (name && scripts.some((s) => scriptFileKey(s.meta.name) === scriptFileKey(name)) ? "replaces existing" : "new");
/** Import…: a zip (pick what of it to import) or a single script file */
function importBundle(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.ts,.tsx,.js";
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (/\.zip$/i.test(file.name)) return void (await importZip(file));
        const text = await file.text();
        const base = cleanScriptName(file.name.replace(/\.ts$/i, "")) || "Imported script";
        const name = uniqueScriptName(base, scripts.map((s) => s.meta.name));
        await send({ type: "saveScript", id: uuid(), code: text, name });
        status("imported script ✓");
        await refresh();
    };
    input.click();
}
async function importZip(file: File): Promise<void> {
    let zip: ExportContents;
    try {
        zip = await readExportZip(await file.arrayBuffer());
    } catch (e) {
        status(`${file.name}: not a zip (${(e as Error).message})`, "error");
        return;
    }
    if (!zip.scripts.length && !zip.dataFiles.length && !zip.folders.length && zip.settings === null && !zip.stores) {
        status(`${file.name}: no scripts, data files, ${SETTINGS_FILE} or ${STORES_FILE} in it`, "error");
        return;
    }
    const existingData: { id: string; path: string }[] = (await send({ type: "listDataFiles" })) || [];
    const dataFileIn = (path: string) => existingData.find((d) => d.path.toLowerCase() === path.toLowerCase());
    const existingFolders: string[] = zip.folders.length ? (await send({ type: "listFolders" })) || [] : [];
    let settingsError = "";
    if (zip.settings !== null) {
        try {
            parseSettings(zip.settings);
        } catch (e) {
            settingsError = (e as Error).message;
        }
    }
    let parsedStores: Record<string, Record<string, Record<string, any>>> | null = null;
    let storesError = "";
    if (zip.stores) {
        try {
            parsedStores = parseExportedStores(zip.stores);
        } catch (e) {
            storesError = (e as Error).message;
        }
    }
    const named = [...zip.scripts.map((s) => ({ name: s.name, code: s.code, data: false })), ...zip.dataFiles.map((d) => ({ name: d.path, code: d.text, data: true }))];
    const settingsAt = zip.settings === null ? -1 : named.length;
    const storesAt = !zip.stores ? -1 : named.length + (zip.settings === null ? 0 : 1);
    const foldersAt = named.length + (zip.settings === null ? 0 : 1) + (zip.stores ? 1 : 0);
    // a package's new version: its files that version doesn't have go (unless unchecked)
    const existingFiles = [...scripts.map((s) => ({ path: scriptFileName(s.meta.name), id: s.id, kind: "script" as const })), ...existingData.map((d) => ({ path: d.path, id: d.id, kind: "data" as const }))];
    const gonePaths = new Set(filesGoneFrom(zip, existingFiles.map((f) => f.path)));
    const gone = existingFiles.filter((f) => gonePaths.has(f.path));
    const goneAt = foldersAt + zip.folders.length;
    const ignored = zip.ignored.length ? ` ${plural(zip.ignored.length, "other file")} in it ${zip.ignored.length === 1 ? "isn't" : "aren't"} a script or data file and won't be imported.` : "";
    const chosen = await pickItems({
        title: `Import ${file.name}`,
        intro: `Pick what to import. A script (data file) replaces the existing script (data file) at the same path; ${SETTINGS_FILE} applies the globals and the picked scripts' enabled state and params.${gone.length ? " Files marked deleted are in the package here but not in this version: checked, they're deleted." : ""}${ignored}`,
        items: [
            ...zip.scripts.map((s) => ({ path: s.file, kind: "script" as const, badge: existsBadge(s.name) })),
            ...zip.dataFiles.map((d) => ({ path: d.path, kind: "data" as const, badge: dataFileIn(d.path) ? "replaces existing" : "new" })),
            ...(zip.settings === null
                ? []
                : [settingsError ? { path: SETTINGS_FILE, kind: "settings" as const, badge: "JSON error", detail: settingsError, checked: false } : { path: SETTINGS_FILE, kind: "settings" as const }]),
            ...(!zip.stores
                ? []
                : [
                      storesError
                          ? { path: STORES_FILE, kind: "settings" as const, badge: "JSON error", detail: storesError, checked: false }
                          : { path: STORES_FILE, kind: "settings" as const, detail: `persisted globalStore data (${plural(Object.keys(parsedStores || {}).length, "script")})` },
                  ]),
            ...zip.folders.map((f) => ({ path: f, kind: "folder" as const, badge: existingFolders.some((e) => e.toLowerCase() === f.toLowerCase()) ? "exists" : "new" })),
            ...gone.map((f) => ({ path: f.path, kind: f.kind, badge: "deleted", detail: "not in this version", removed: true })),
        ],
        confirm: "Import",
        warn: importsWarning(named),
    });
    if (!chosen) return;
    const pickedScripts = chosen.filter((i) => i < zip.scripts.length).map((i) => zip.scripts[i]);
    const pickedData = chosen.filter((i) => i >= zip.scripts.length && i < named.length).map((i) => zip.dataFiles[i - zip.scripts.length]);
    const pickedFolders = chosen.filter((i) => i >= foldersAt && i < goneAt).map((i) => zip.folders[i - foldersAt]);
    const pickedGone = chosen.filter((i) => i >= goneAt).map((i) => gone[i - goneAt]);
    const withSettings = settingsAt >= 0 && chosen.includes(settingsAt);
    const withStores = storesAt >= 0 && chosen.includes(storesAt) && !!parsedStores;
    // folders and data files first: the scripts compile against them
    const failed: string[] = [];
    for (const f of pickedFolders) {
        if (existingFolders.some((e) => e.toLowerCase() === f.toLowerCase())) continue;
        const r = await send({ type: "createFolder", path: f });
        if (r?.error) failed.push(r.error);
    }
    for (const d of pickedData) {
        const r = await send({ type: "saveDataFile", id: dataFileIn(d.path)?.id, path: d.path, text: d.text });
        if (r?.error) failed.push(r.error);
    }
    for (const s of pickedScripts) await saveImported({ name: s.name, code: s.code });
    for (const f of pickedGone) {
        const r = await send({ type: f.kind === "script" ? "deleteScript" : "deleteDataFile", id: f.id });
        if (r?.error) failed.push(`can't delete "${f.path}": ${r.error}`);
    }
    await refresh();
    const parts = [plural(pickedScripts.length, "script"), ...(pickedData.length ? [plural(pickedData.length, "data file")] : []), ...(pickedFolders.length ? [plural(pickedFolders.length, "folder")] : []), ...(pickedGone.length ? [`${plural(pickedGone.length, "file")} deleted`] : [])];
    // settings apply through the real path (globals + the scripts'
    // enabled state and params); storage.onChanged refreshes the settings UI
    if (withSettings) {
        let res: any;
        try {
            res = await send({ type: "applySettingsDoc", doc: importedSettingsDoc(zip.settings!, pickedScripts.map((s) => s.name), zip.scripts.length > 0) });
        } catch (e) {
            res = { error: (e as Error).message };
        }
        if (res && res.error) {
            status(`imported ${parts.join(" + ")}; settings: ${res.error}`, "error");
            return;
        }
        parts.push("settings");
    }
    if (withStores && parsedStores) {
        const wanted = zip.scripts.length > 0 ? new Set(pickedScripts.map((s) => scriptPathKey(s.name))) : null;
        const storesToApply = wanted
            ? Object.fromEntries(Object.entries(parsedStores).filter(([k]) => wanted.has(scriptPathKey(k))))
            : parsedStores;
        const res: any = await send({ type: "importStores", stores: storesToApply });
        if (res && res.error) failed.push(`stores: ${res.error}`);
        else parts.push("stores");
    }
    if (failed.length) {
        status(`imported ${parts.join(" + ")}; ${failed.join("; ")}`, "error");
        return;
    }
    status(`imported ${parts.join(" + ")} ✓`);
}

// ---- wiring ----
async function main(): Promise<void> {
    Object.assign(actions, {
        showPanelTab,
        setPanelHidden,
        setSidebarHidden,
        clearPanel,
        runDiagnostics: () => void runDiagnostics(),
        openProblem: (id: string, p: Problem) => void openProblem(id, p),
        dismissError: (id: string) => void send({ type: "clearScriptError", scriptId: id }),
        focusEditor: () => editor?.focus(),
        status: (text: string, cls?: string) => status(text, cls),
        select: (id: string) => void select(id),
        deleteRows: (rows: TreeRow[]) => void deleteRows(rows),
        moveRows,
        makePackage: (id: string) => void makePackage(id),
        makeFolderPackage: (folder: string) => void makeFolderPackage(folder),
        exportPackage: (start: string) => void exportPackage(start),
        itemPathProblem,
        createItem: (kind: NewKind, path: string) => void createItem(kind, path),
        startCreate,
        save: () => void saveCurrent(),
        toggleEnabled: () => {
            const script = scripts.find((s) => s.id === selectedId);
            if (script) void setScriptEnabled(script, !script.enabled);
        },
        folderSyncButton: () => void folderSyncButtonClicked(),
        openInEditor,
        exportBundle: () => void exportBundle(),
        importBundle,
        setScriptEnabled: (id: string, enabled: boolean) => {
            const script = scripts.find((s) => s.id === id);
            if (script) void setScriptEnabled(script, enabled);
        },
        quickOpenItems: () => [
            { id: SETTINGS_ID, name: SETTINGS_FILE },
            { id: STORES_ID, name: STORES_FILE },
            ...scripts.map((s) => ({ id: s.id, name: scriptFileName(s.meta.name) })),
            ...dataFiles.map((d) => ({ id: d.id, name: d.path })),
        ],
        openQuick: (id: string) => {
            void select(id);
            editor.focus(); // VS Code behavior: a ⌘P jump focuses the editor
        },
        addSample,
        trySample,
        closeWelcome: () => {
            showWelcome(false);
            if (!selectedId && scripts.length) selectReal(scripts[0].id);
        },
        folderButton: () => void folderButtonClicked(),
        folderDisconnect: () => void folderDisconnectClicked(),
        setVscodePath: (path: string) => {
            settings.vscodePath = path;
            chrome.storage.local.set({ resVscodePath: path }, () => void refreshSyncPath());
            void checkFolderPath();
        },
        setLaunchMode: (mode: LaunchMode) => {
            settings.launchMode = mode;
            chrome.storage.local.set({ resVscodeLaunch: mode });
            updateOpenVscode();
        },
        setEditorUrl: (url: string) => {
            settings.editorUrl = url;
            chrome.storage.local.set({ resEditorUrl: url });
            updateOpenVscode();
        },
        setMonacoVerbose: (on: boolean) => {
            chrome.storage.local.set({ resMonacoVerbose: on });
            setMonacoVerbose(on, "warn");
        },
    } satisfies typeof actions);
    await loadMonaco();
    watchPackages();
    // test/e2e seam: adopt an arbitrary directory handle (e.g. OPFS) for watching
    (window as any).__resAdoptFolder = (h: any) => fsBridge.adoptForWatch(h);
    editor = createCodeEditor({
        value: "",
        language: "typescript",
        theme: monacoTheme(),
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
        scrollBeyondLastLine: false,
        wordWrap: layout.wordWrap ? "on" : "off",
        hover: { sticky: true }, // reachable, so tooltip.ts can copy it on click
    });
    tsWorkspace = createMonacoTsWorkspace({
        monaco: (window as any).monaco,
        getActiveModel: () => editor?.getModel() ?? null,
        send,
        onChecked: () => {
            scheduleDiagnostics();
            scheduleProblems();
        },
    });
    editor.onDidChangeModel(() => tsWorkspace?.prioritize(editor.getModel()));
    editor.addCommand((window as any).monaco.KeyMod.CtrlCmd | (window as any).monaco.KeyCode.KeyS, () => void saveCurrent());
    registerLayoutActions();
    (window as any).monaco.editor.onDidChangeMarkers(() => {
        if (!writingProblemMarkers) scheduleProblems();
    });
    (window as any).monaco.editor.onWillDisposeModel((m: any) => {
        if ((problemMarkerKeys.get(m) ?? "[]") !== "[]") setProblemMarkers(m, []);
        scheduleProblems();
    });
    registerManifestAssist();
    registerPinImportFix();
    registerPlaceFixes();
    registerTsxFix();
    // VS Code shortcuts: ⌘P quick-open (scripts + settings.json), ⌘, opens
    // the Settings dialog, ⌘⇧E focuses the explorer, ⌘B / ⌘J toggle the
    // explorer / panel, ⌘⇧M or ⌥⇧P/L/N show a panel view (filter focused), ⌥⇧K clears it, ⌥Z toggles word wrap
    // (the last five are also editor actions, so they work while Monaco has
    // focus and show up in F1).
    // ⌘/ (comment), ⌘F (find), ⌘D (next occurrence) and Shift+Alt+A (block
    // comment) are Monaco built-ins.
    document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
            e.preventDefault();
            dialogs.quickOpen = !dialogs.quickOpen;
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


    showPanelTab(panelTabOf(layout));
    watchNetCounts();
    startKeepAlive();
    setupSettings();
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
    refreshUserScripts();
    // back from chrome://extensions (Allow User Scripts flipped): the background re-checks and re-registers
    window.addEventListener("focus", refreshUserScripts);
    document.addEventListener("visibilitychange", () => !document.hidden && refreshUserScripts());
    await refresh();

    // deep link from the popup: editor.html?script=<id>
    const wanted = new URLSearchParams(location.search).get("script");
    if (wanted && scripts.some((s) => s.id === wanted)) {
        selectReal(wanted);
    }
}

/** Layout shortcuts outside the editor (the editor's own copies are below). */
function layoutShortcut(e: KeyboardEvent): (() => void) | null {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && !e.altKey && e.code === "KeyE") return focusExplorer;
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyB") return toggleSidebar;
    if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyJ" || e.code === "Backquote")) return togglePanel;
    if (mod && e.shiftKey && !e.altKey && e.code === "KeyM") return toggleProblems;
    // ⌥⇧ + letter: free in Chrome, Firefox and the OSes (⌃⇧/⌘⇧ letters are nearly all taken)
    if (e.altKey && e.shiftKey && !mod) {
        if (e.code === "KeyP") return toggleProblems;
        if (e.code === "KeyL") return () => focusPanelView("log");
        if (e.code === "KeyN") return () => focusPanelView("network");
        if (e.code === "KeyV") return () => focusPanelView("preview");
        if (e.code === "KeyK") return clearPanelView;
    }
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
        ["tt.toggleWordWrap", "View: Toggle Word Wrap", [KeyMod.Alt | KeyCode.KeyZ], toggleWordWrap],
        ["tt.focusExplorer", "View: Focus on Explorer", [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE], focusExplorer],
        ["tt.toggleSidebar", "View: Toggle Explorer Visibility", [KeyMod.CtrlCmd | KeyCode.KeyB], toggleSidebar],
        ["tt.togglePanel", "View: Toggle Panel Visibility", [KeyMod.CtrlCmd | KeyCode.KeyJ, KeyMod.CtrlCmd | KeyCode.Backquote], togglePanel],
        ["tt.toggleProblems", "View: Show Problems", [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM, KeyMod.Alt | KeyMod.Shift | KeyCode.KeyP], toggleProblems],
        ["tt.showLog", "View: Show Log", [KeyMod.Alt | KeyMod.Shift | KeyCode.KeyL], () => focusPanelView("log")],
        ["tt.showNetwork", "View: Show Network", [KeyMod.Alt | KeyMod.Shift | KeyCode.KeyN], () => focusPanelView("network")],
        ["tt.showPreview", "View: Show Preview", [KeyMod.Alt | KeyMod.Shift | KeyCode.KeyV], () => focusPanelView("preview")],
        ["tt.clearPanel", "View: Clear Log / Network", [KeyMod.Alt | KeyMod.Shift | KeyCode.KeyK], clearPanelView],
        ["tt.showShortcuts", "Help: Keyboard Shortcuts", [], () => openHelp("shortcuts")],
        ["tt.navigateBack", "Go Back", navKeybindings().back, navigateBack],
        ["tt.navigateForward", "Go Forward", navKeybindings().forward, navigateForward],
    ];
    for (const [id, label, keybindings, run] of actions) editor.addAction({ id, label, keybindings, run });
    editor.addAction({ id: "tt.openSettings", label: "Preferences: Open Settings", run: () => openSettings() });
    registerSettingsCommand();
    editor.addAction({
        id: "tt.collectDiagnostics",
        label: "TangiTweak: Collect Diagnostics…",
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
    if (id === STORES_ID) return selectStores();
    const row = treeRow(id);
    if (row) revealInExplorer(row.path);
    selectReal(id);
    return Promise.resolve();
}

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
        if (!settings.monacoVerbose) return;
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
    if (!settings.monacoVerbose) return;
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
        navLog(`open ${resource.toString()} sel=${JSON.stringify(selection)} from=${typingsShown ? "tt-api.d.ts" : selectedId} dirty=${dirty}`);
        if (resource.toString() === API_TYPINGS_URI) {
            openTypingsAt(selection);
            navLog("opened tt-api.d.ts (read-only)");
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
