/**
 * Manager page: script list + Monaco editor + logs + VS Code bridge.
 */

import { loadMonaco, STARTER_TEMPLATE } from "./monacoSetup";
import { API_REFERENCE } from "./apiReference";
import { SHORTCUTS, filterShortcuts, formatKey } from "./shortcuts";
import { SAMPLES } from "./samples";
import { settingsDiagnostics, settingsCompletions, settingsHover, type AssistScript } from "../shared/settingsAssist";
import { dependantsOf, missingImports } from "../shared/scriptImports";
import { pickRows } from "./bundlePicker";
import { resolveConflict } from "./conflictDialog";
import { watchTheme, saveTheme, type Theme, type ThemePref } from "./theme";
import * as fsBridge from "./fsBridge";
import { cleanScriptName, scriptNameProblem, scriptFileName, scriptFileKey, uniqueScriptName, MAX_NAME } from "../shared/scriptName";
import { buildBundle, parseBundleText, bundleSettingsDoc, pickBundle, vscodeTargetPath } from "./bundle";
import { createQuickOpenPalette } from "./quickOpen";
import { computeDirty } from "./dirtyState";
import { parseSettings, SETTINGS_FILE, type SettingsDoc } from "../shared/settingsYaml";
import { dlogLevel } from "../shared/debugLog";
import { helperInstallCommand, helperInstallShell } from "../shared/helperInstall";
import { mountNetworkPanel } from "./network/mount";
import { scriptHealth, type ScriptHealthInput } from "../shared/scriptHealth";
import type { Uri, IPosition, IRange, IKeyboardEvent, editor as MonacoEditor } from "monaco-editor";
import type { Script } from "../background/engine/scriptStore";
import { setupPanelDock, currentSide, currentDock } from "./panelDock";
import { badgeCount, LogBadge, NetBadge, type TabBadge } from "./logBadge";
import { touchState } from "./network/netFormat";
import type { NetPortMsg } from "../shared/netTypes";
import { aboutRows, aboutText, checkLatestRelease, collectDiagnostics, describeLatest, diagnosticsFileName, downloadText, RELEASES_URL, type HelperStatus } from "./about";

// ---- state ----
let scripts: (Script & { runtimeError?: ScriptHealthInput["runtimeError"]; typeErrors?: string[] })[] = [];
let selectedId: string | null = null;
let editor: any = null;
let dirty = false;

/** Central dirty-state toggle: dims/undims Save. */
function setDirty(v: boolean): void {
    dirty = v;
    document.querySelector("#script-list li.selected")?.classList.toggle("dirty", v);
    const btn = $("#btn-save");
    if (v) {
        btn.removeAttribute("disabled");
        btn.classList.remove("dim");
        btn.textContent = "Save";
    } else {
        btn.setAttribute("disabled", "");
        btn.classList.add("dim");
        btn.textContent = "Save";
    }
}
let applyingExternal = false;

/** last-saved content per open file (model uri → text): reverting to it clears dirty */
const baselines = new Map<string, string>();
const setBaseline = (m: any, text: string): void => {
    baselines.set(m.uri.toString(), text);
};

/** dirty = content differs from the file's baseline OR the name differs from the stored one */
function updateDirty(): void {
    if (!editor) return;
    const m = editor.getModel();
    const dirtyNow = computeDirty(
        m ? m.getValue() : "",
        m ? (baselines.get(m.uri.toString()) ?? null) : null,
        undefined,
        undefined
    );
    setDirty(dirtyNow);
    status(dirtyNow ? "unsaved…" : "saved ✓", dirtyNow ? "dirty" : "");
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
    scripts.map((s: any) => ({ name: s.meta.name, declared: s.meta.declared !== false, defs: s.paramDefs ?? {} }));
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
    selectedId = SETTINGS_ID;
    focusedId = null;
    renderList();
    $("#btn-save").removeAttribute("disabled");
    await loadSettingsModel(true);
    if (editor.getModel() !== settingsModel) {
        captureViewState();
        editor.setModel(settingsModel);
        restoreViewState(settingsModel);
    }
    setDirty(false);
    status("saved ✓");
    updateOpenVscode();
}

async function saveSettings(): Promise<void> {
    const res = await send({ type: "applySettingsYaml", text: editor.getValue() });
    if (res && res.error) {
        status(`settings.yaml: ${res.error}`, "error");
        return;
    }
    await loadSettingsModel(true); // re-canonicalize (restores commented defaults)
    setDirty(false);
    status("saved ✓");
    await refresh();
}

async function refresh(): Promise<void> {
    const prev = scripts;
    scripts = await send({ type: "listScripts" });
    if (dirty && selectedId && selectedId !== SETTINGS_ID && !scripts.some((s) => s.id === selectedId)) {
        // deleted elsewhere while edited here: keep the buffer (and its
        // model) so the unsaved text isn't lost; saving offers to recreate
        const orphan = prev.find((s) => s.id === selectedId);
        if (orphan) {
            scripts = [...scripts, orphan];
            status(`"${orphan.meta.name}" was deleted elsewhere — save to recreate it`, "error");
        }
    }
    renderList();
    syncModels();
    scheduleDiagnostics();
    scheduleSettingsMarkers();
    if (selectedId && selectedId !== SETTINGS_ID && !scripts.some((s) => s.id === selectedId)) {
        selectedId = null;
    }
    if (selectedId === SETTINGS_ID) return;
    if (!selectedId && scripts.length > 0) {
        select(scripts[0].id);
    } else if (!selectedId) {
        renderEditorEmpty();
    }
}

let renaming = false;
/** keyboard cursor in the explorer (VS Code "focused" row); null = follow the open file */
let focusedId: string | null = null;

function renderList(): void {
    updateEnabledToggle();
    if (renaming) return; // a rebuild would drop the inline rename input
    const list = $("#script-list");
    list.innerHTML = "";
    const cursor = focusedId ?? selectedId;
    const row = (id: string, cls: string): HTMLLIElement => {
        const li = document.createElement("li");
        li.className = "script-item" + cls + (id === selectedId ? " selected" : "") + (id === cursor ? " focused" : "") + (id === selectedId && dirty ? " dirty" : "");
        li.dataset.id = id;
        li.id = `explorer-${id}`;
        li.setAttribute("role", "treeitem");
        li.setAttribute("aria-selected", String(id === selectedId));
        if (id === cursor) list.setAttribute("aria-activedescendant", li.id);
        return li;
    };
    const icon = (kind: "ts" | "yaml", text: string): HTMLElement => {
        const el = document.createElement("span");
        el.className = `file-icon ${kind}`;
        el.textContent = text;
        el.setAttribute("aria-hidden", "true");
        return el;
    };
    const sli = row(SETTINGS_ID, " utility");
    sli.title = "Settings file — global settings and per-script params & enabled state";
    const sname = document.createElement("span");
    sname.className = "script-name";
    sname.textContent = "settings.yaml";
    sli.append(icon("yaml", "⚙"), sname);
    sli.addEventListener("click", () => {
        moveExplorerFocus(SETTINGS_ID);
        select(SETTINGS_ID);
    });
    list.appendChild(sli);
    for (const script of scripts) {
        const isLib = script.meta.declared === false;
        const off = !isLib && !script.enabled;
        const li = row(script.id, (isLib ? " utility" : "") + (off ? " disabled" : ""));

        const health = scriptHealth(script);
        const name = document.createElement("span");
        name.className = "script-name" + (health ? " error" : "");
        name.textContent = scriptFileName(script.meta.name);
        name.title = [
            isLib ? "Utility module — importable by other scripts, never runs on its own. Use wt.declareScript to turn it into a script" : script.meta.match.join(", "),
            off ? "Disabled — enable it from the editor toolbar or the right-click menu" : "",
            "Double-click or F2 to rename",
        ].filter(Boolean).join("\n");

        if (health) li.classList.add("has-error");

        const del = document.createElement("button");
        del.className = "btn-del";
        del.textContent = "✕";
        del.title = "Delete script (Delete)";
        del.tabIndex = -1;
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            void deleteScript(script);
        });

        li.append(icon("ts", "TS"), name);
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
        li.append(del);
        // re-selecting would rebuild the list and swallow a double-click
        li.addEventListener("click", () => {
            moveExplorerFocus(script.id);
            if (script.id !== selectedId) select(script.id);
        });
        list.appendChild(li);
    }
}

async function setScriptEnabled(script: Script, enabled: boolean): Promise<void> {
    await send({ type: "setEnabled", id: script.id, enabled });
    await refresh();
}

/** Delete with confirmation; the explorer cursor moves to the next row. */
async function deleteScript(script: Script): Promise<void> {
    if (!confirm(`Delete "${script.meta.name}"?`)) return;
    if ((focusedId ?? selectedId) === script.id) {
        const ids = explorerIds();
        const i = ids.indexOf(script.id);
        focusedId = ids[i + 1] ?? ids[i - 1] ?? null;
    }
    await send({ type: "deleteScript", id: script.id });
    await refresh();
}

/** Editor toolbar switch: enable/disable the open script (hidden for settings.yaml and libraries). */
function updateEnabledToggle(): void {
    const label = $("#script-enabled");
    const script = scripts.find((s) => s.id === selectedId);
    label.hidden = !script || script.meta.declared === false;
    if (!script) return;
    label.querySelector(".switch")!.classList.toggle("on", !!script.enabled);
    label.setAttribute("aria-checked", String(!!script.enabled));
}

// ---- explorer: keyboard navigation + context menu (VS Code style) ----
const explorerIds = (): string[] => [SETTINGS_ID, ...scripts.map((s) => s.id)];

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
    for (const li of list.querySelectorAll<HTMLElement>("li.script-item")) {
        const on = li.dataset.id === id;
        li.classList.toggle("focused", on);
        if (on) {
            list.setAttribute("aria-activedescendant", li.id);
            li.scrollIntoView({ block: "nearest" });
        }
    }
}

function renameInExplorer(id: string): void {
    const script = scripts.find((s) => s.id === id);
    const label = script && $("#script-list").querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"] .script-name`);
    if (label) startRename(label, script!, true);
}

function setupExplorer(): void {
    const list = $("#script-list");
    list.addEventListener("keydown", (e) => {
        if (e.target !== list) return; // the inline rename input handles its own keys
        const ids = explorerIds();
        const cur = focusedId ?? selectedId ?? ids[0];
        const i = Math.max(0, ids.indexOf(cur));
        const script = scripts.find((s) => s.id === cur);
        const mod = e.metaKey || e.ctrlKey;
        let handled = true;
        if (e.key === "ArrowDown") moveExplorerFocus(ids[Math.min(i + 1, ids.length - 1)]);
        else if (e.key === "ArrowUp") moveExplorerFocus(ids[Math.max(i - 1, 0)]);
        else if (e.key === "Home" || e.key === "PageUp") moveExplorerFocus(ids[0]);
        else if (e.key === "End" || e.key === "PageDown") moveExplorerFocus(ids[ids.length - 1]);
        else if ((e.key === "Enter" || e.key === " ") && !mod) {
            if (cur !== selectedId) select(cur);
            if (e.key === "Enter") editor?.focus(); // Enter opens and focuses, Space just opens (preview)
        } else if (e.key === "F2" && script) renameInExplorer(cur);
        else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && script) void deleteScript(script);
        else if (e.key === "Escape") editor?.focus();
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
    list.addEventListener("contextmenu", (e) => {
        const li = (e.target as HTMLElement).closest<HTMLElement>("li.script-item");
        const script = li && scripts.find((s) => s.id === li.dataset.id);
        if (!script) return;
        e.preventDefault();
        moveExplorerFocus(script.id);
        const isLib = script.meta.declared === false;
        showContextMenu(e.clientX, e.clientY, [
            { label: "Open", key: "Enter", run: () => script.id !== selectedId && select(script.id) },
            null,
            ...(isLib ? [] : [{ label: script.enabled ? "Disable" : "Enable", run: () => void setScriptEnabled(script, !script.enabled) }]),
            { label: "Rename…", key: "F2", run: () => renameInExplorer(script.id) },
            { label: "Delete", key: "Delete", run: () => void deleteScript(script) },
        ]);
    });
    $("#explorer-section").addEventListener("click", toggleExplorerSection);
    $("#script-enabled").addEventListener("click", (e) => {
        e.preventDefault();
        const script = scripts.find((s) => s.id === selectedId);
        if (script) void setScriptEnabled(script, !script.enabled);
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

/** Inline rename in the script list (double-click a name, or F2). */
function startRename(label: HTMLElement, script: Script, refocusList = false): void {
    const input = document.createElement("input");
    input.className = "script-rename";
    input.value = cleanScriptName(script.meta.name);
    input.maxLength = MAX_NAME;
    input.title = 'The name is also the file name: any characters except < > : " / \\ | ? *';
    input.addEventListener("input", () => {
        const clean = cleanScriptName(input.value);
        if (clean === input.value) return;
        const pos = Math.max(0, (input.selectionStart ?? clean.length) - (input.value.length - clean.length));
        input.value = clean;
        input.setSelectionRange(pos, pos);
        input.classList.add("rejected");
        setTimeout(() => input.classList.remove("rejected"), 300);
    });
    label.replaceWith(input);
    renaming = true;
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit: boolean): Promise<void> => {
        if (done) return;
        done = true;
        renaming = false;
        if (refocusList) $("#script-list").focus();
        const next = cleanScriptName(input.value).trim();
        let problem = commit && next && next !== script.meta.name ? scriptNameProblem(next) : "";
        const clash =
            commit && next && !problem
                ? scripts.find((s) => s.id !== script.id && fsBridge.fileNameFor(s.id, s.meta.name).toLowerCase() === fsBridge.fileNameFor(script.id, next).toLowerCase())
                : undefined;
        if (clash) problem = `a script named "${clash.meta.name}" already exists`;
        if (problem) status(`can't rename: ${problem}`, "error");
        if (!commit || !next || next === script.meta.name || problem) {
            input.replaceWith(label);
            renderList(); // catch up on updates skipped while renaming
            return;
        }
        const result = await send({ type: "saveScript", id: script.id, code: script.code, name: next });
        if (result?.error) status("script error — see log", "error");
        await refresh();
        renderList();
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void finish(true);
        else if (e.key === "Escape") void finish(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
    });
    input.addEventListener("blur", () => void finish(true));
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
                .getModelMarkers({ resource: m.uri })
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

async function renderEditorEmpty(): Promise<void> {
    $("#btn-save").setAttribute("disabled", "");
    if (editor) {
        editor.setModel(null);
    }
}

/** Programmatic editor update (select / external hot-reload). */
function setEditorValue(code: string): void {
    if (!editor) return;
    const m = selectedId ? models.get(selectedId) : null;
    applyingExternal = true;
    if (m) {
        m.setValue(code);
        setBaseline(m, code);
    } else editor.setValue(code);
    editor.clearHistory?.();
    applyingExternal = false;
    dirty = false;
    status("saved ✓");
}

/** Enable ↗ VS Code only while folder sync is active and a script is selected. */
function updateOpenVscode(): void {
    const b = $("#btn-open-vscode") as HTMLButtonElement;
    const off = ((window as any).__resLaunchMode || "vscode") === "off";
    b.style.display = off ? "none" : "";
    if (!off && (window as any).__resSyncActive && selectedId) b.removeAttribute("disabled");
    else b.setAttribute("disabled", "");
}

/** Protocol scheme for the launch button (vscode | vscode-insiders | off). */
function vscodeScheme(): string {
    const mode = (window as any).__resLaunchMode || "vscode";
    return mode === "vscode-insiders" ? "vscode-insiders://file" : "vscode://file";
}

function selectReal(id: string): void {
    selectedId = id;
    focusedId = null;
    renderList();
    const script = scripts.find((s) => s.id === id);
    if (!script) return;
    $("#btn-save").removeAttribute("disabled");
    syncModels();
    const m = models.get(id);
    if (m && editor.getModel() !== m) {
        captureViewState();
        editor.setModel(m);
        dirty = false;
        status("saved ✓");
        restoreViewState(m);
    } else {
        setEditorValue(script.code);
    }
    setDirty(false);
    updateOpenVscode();
}

async function saveCurrent(): Promise<void> {
    if (selectedId === SETTINGS_ID) return saveSettings();
    if (!selectedId || !editor) return;
    const code = editor.getValue();
    const name = scripts.find((s) => s.id === selectedId)?.meta.name || "Untitled script";
    const id = selectedId;
    const m = models.get(id);
    const base = m ? baselines.get(m.uri.toString()) : undefined;
    let result = await send({ type: "saveScript", id, code, name, base });
    if (result?.conflict) {
        const deleted = result.conflict === "deleted";
        const choice = await resolveConflict({ name, theirs: deleted ? null : result.code, mine: code });
        if (choice === "cancel") return;
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
    if (result && result.error) {
        status("script error — see log", "error");
    } else {
        status("saved ✓");
        if (m) setBaseline(m, code); // the stored text is now the baseline
    }
    setDirty(false);
    await refresh();
    renderList();
}

// ---- process tier (local helper) ----
let helperStatus: HelperStatus | null = null;
function renderProcessStatus(st: any): void {
    helperStatus = st;
    if (!$("#settings-panel").classList.contains("hidden")) void renderAbout();
    const labels: Record<string, string> = {
        idle: "not needed — no enabled script lists \"process\"",
        unsupported: "unavailable in this browser (Chrome only) — scripts fall through their strategy lists",
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
        if (st.caTrusted === false) lines.push("Chrome does not trust the helper's CA yet — click Trust CA (or run: wiretrick-helper trust-ca).");
        if (st.caTrusted === true) lines.push("CA trusted ✓");
        if (st.caFingerprint) lines.push(`CA: ${st.caPath} (SHA-256 ${st.caFingerprint})`);
    }
    if (st.trust) lines.push(`Trust CA: ${st.trust.msg}`);
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
                if (updated && dirty) status("script changed on disk — editor has unsaved edits", "dirty");
            })();
        }
        if (msg.type === "sync") {
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

// ---- Tab badges: Log errors/warnings and Network tapped/modified requests
// that arrived while that tab was out of view ----
const logBadge = new LogBadge();
const netBadge = new NetBadge();
let logBadgeEnabled = true;

function tabInView(tab: "log" | "network"): boolean {
    return $("#log-panel").dataset.tab === tab && !$("#app").classList.contains("panel-hidden") && document.visibilityState === "visible";
}

function renderBadge(el: HTMLElement, badge: TabBadge, inView: boolean): void {
    if (!logBadgeEnabled || inView) badge.reset();
    el.hidden = badge.empty;
    el.title = badge.empty ? "" : badge.title;
    for (const [cls, n] of badge.counts) {
        const b = el.querySelector<HTMLElement>(`.tab-badge.${cls}`)!;
        b.hidden = !n;
        b.textContent = badgeCount(n);
    }
}

function renderTabBadges(): void {
    renderBadge($("#log-badge"), logBadge, tabInView("log"));
    renderBadge($("#net-badge"), netBadge, tabInView("network"));
}

/** Network recorder traffic (after the panel's store applied it): feeds the Network badge. */
function noteNetMessage(msg: NetPortMsg): void {
    if (msg.type === "netCleared") netBadge.clearAll();
    else if (msg.type === "netRemoved") netBadge.forget(msg.ids);
    else {
        const unseen = logBadgeEnabled && !tabInView("network");
        for (const e of msg.entries) netBadge.note(e.id, touchState(e), unseen);
    }
    renderBadge($("#net-badge"), netBadge, tabInView("network"));
}

/** All received entries — filtered ones stay here (re-renderable), just not in the DOM. */
const logEntries: { text: string; level: string; source: string; tapped?: boolean }[] = [];
/** "tapped (no change)" DEBUG lines (one per handler run) may fill at most this much of the buffer */
const MAX_TAPPED_ENTRIES = 300;
let tappedEntries = 0;

function appendLog(entry: any): void {
    const time = new Date(entry.at).toLocaleTimeString();
    const source = sourceOf(entry.message || "");
    const tapped = entry.kind === "tapped";
    logEntries.push({ text: `[${time}] ${entry.message}`, level: entry.level || "info", source, ...(tapped ? { tapped } : {}) });
    if (tapped && ++tappedEntries > MAX_TAPPED_ENTRIES) {
        logEntries.splice(logEntries.findIndex((e) => e.tapped), 1);
        tappedEntries--;
    }
    if (logEntries.length > 2000) {
        // absolute buffer cap
        for (const e of logEntries.splice(0, logEntries.length - 2000)) if (e.tapped) tappedEntries--;
    }
    rememberSource(source);

    const text = logEntries[logEntries.length - 1].text;
    const level = logEntries[logEntries.length - 1].level;
    if (!linePassesFilters(text, level, source)) return; // don't let hidden entries churn the DOM ring
    if (level === "error" || level === "warn") {
        logBadge.note(level);
        renderTabBadges();
    }

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
    btn.disabled = true;
    copy.hidden = true;
    state.textContent = "collecting…";
    try {
        const name = diagnosticsFileName();
        diagnosticsReport = await collectDiagnostics(managerUiState());
        downloadText(name, diagnosticsReport, "text/markdown");
        state.textContent = `downloaded (${Math.ceil(diagnosticsReport.length / 1024)} KB)`;
        state.title = name;
        copy.hidden = false;
    } catch (e: any) {
        state.textContent = `failed: ${e?.message || e}`;
    } finally {
        btn.disabled = false;
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
    $("#btn-help").addEventListener("click", () => openDialog("help-panel"));
    for (const tab of document.querySelectorAll<HTMLElement>("[data-help-tab]")) {
        tab.addEventListener("click", () => showHelpTab(tab.dataset.helpTab!));
    }
    $input("#shortcuts-filter").addEventListener("input", renderShortcuts);
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
        if (c.resLogCap?.newValue) {
            logCap = c.resLogCap.newValue;
            capInput.value = String(logCap);
            refilterLog();
        }
        if (c.resScripts || c.resParams || c.resLogLevel || c.resLogCap || c.resSettingsText) {
            void (async () => {
                if (selectedId === SETTINGS_ID) await loadSettingsModel();
                if (c.resScripts) await refresh();
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

    // launch target for the ↗ button (vscode | vscode-insiders | off)
    const launchSel = $("#settings-vscode-launch") as HTMLSelectElement;
    chrome.storage.local.get("resVscodeLaunch", (d) => {
        const mode = (d && d.resVscodeLaunch) || "vscode";
        (window as any).__resLaunchMode = mode;
        launchSel.value = mode;
        updateOpenVscode();
    });
    launchSel.addEventListener("change", () => {
        (window as any).__resLaunchMode = launchSel.value;
        chrome.storage.local.set({ resVscodeLaunch: launchSel.value });
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
    if (name === "samples" && !$("#samples-body").childElementCount) renderSamples();
    if (name === "shortcuts") {
        renderShortcuts();
        setTimeout(() => $input("#shortcuts-filter").focus());
    }
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
            s.keys.forEach((k, i) => {
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

function renderHelp(): void {
    const body = $("#help-body");
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
    const body = $("#samples-body");
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
        const reconnect = async (): Promise<void> => {
            btn.removeEventListener("click", reconnect);
            if (fsBridge.isSyncing()) return;
            const ok = await fsBridge.reconnectClicked();
            if (ok) {
                await markFolderSynced();
                status("scripts folder reconnected ✓");
            }
        };
        btn.addEventListener("click", reconnect);
        status("scripts folder needs reconnect — click to reconnect", "dirty", () => void reconnect());
    }
}

// ---- movable panels ----
interface PanelLayout {
    sidebarW?: number;
    panelTab?: "log" | "network";
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

/** VS Code–style bottom panel tabs: LOG | NETWORK */
function setupPanelTabs(): void {
    const show = (which: "log" | "network") => {
        for (const t of document.querySelectorAll<HTMLElement>(".panel-tab")) {
            const on = t.dataset.panel === which;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
        }
        $("#log-entries").hidden = which !== "log";
        $("#log-tools").hidden = which !== "log";
        $("#network-view").hidden = which !== "network";
        $("#log-panel").dataset.tab = which;
        renderTabBadges();
        // recording starts the first time the tab is shown (zero cost before)
        if (which === "network" && !networkMounted) {
            networkMounted = true;
            mountNetworkPanel($("#network-view"), noteNetMessage);
        }
        const l = loadLayout();
        l.panelTab = which;
        saveLayout(l);
    };
    for (const t of document.querySelectorAll<HTMLElement>(".panel-tab")) {
        t.addEventListener("click", () => show(t.dataset.panel as "log" | "network"));
    }
    show(loadLayout().panelTab === "network" ? "network" : "log");
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
    });
    editor.addCommand((window as any).monaco.KeyMod.CtrlCmd | (window as any).monaco.KeyCode.KeyS, () => void saveCurrent());
    registerLayoutActions();
    (window as any).monaco.editor.onDidChangeMarkers(() => scheduleDiagnostics());
    registerSettingsAssist();
    // Monaco re-checks only the edited file; its importers keep stale errors
    (window as any).monaco.editor.onDidCreateModel((m: any) => {
        if (m.getLanguageId() === "typescript") m.onDidChangeContent(() => scheduleDependantRecheck(m));
    });
    for (const m of models.values()) m.onDidChangeContent(() => scheduleDependantRecheck(m));
    // VS Code shortcuts: ⌘P quick-open (scripts + settings.yaml), ⌘, opens
    // the Settings dialog, ⌘⇧E focuses the explorer, ⌘B / ⌘J toggle the
    // explorer / panel, ⌥Z toggles word wrap (the last four are also editor
    // actions, so they work while Monaco has focus and show up in F1).
    // ⌘/ (comment), ⌘F (find), ⌘D (next occurrence) and Shift+Alt+A (block
    // comment) are Monaco built-ins.
    const palette = createQuickOpenPalette(
        $("#quick-open"),
        $input("#qo-input"),
        $("#qo-list"),
        () => [{ id: SETTINGS_ID, name: "settings.yaml" }, ...scripts.map((s) => ({ id: s.id, name: s.meta.name }))],
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
        if (!folder || !selectedId) return;
        // the ⚙ settings.yaml entry is virtual (not in `scripts`) — its
        // target is <folder>/settings.yaml, written by folderSync
        const file = vscodeTargetPath(folder, selectedId, scripts.find((s) => s.id === selectedId)?.meta.name, SETTINGS_ID, SETTINGS_FILE);
        const url = vscodeScheme() + file.split("/").map(encodeURIComponent).join("/");        // launch from THIS page (user gesture): external-protocol requests
        // from the background page are dropped by Chromium
        const a = document.createElement("a");
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        status(`opening ${file} in VS Code…`);
        const msg = `openInVscode → launching ${url}`;
        appendLog({ at: Date.now(), message: `[manager] ${msg}`, level: "info" });
        chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "manager", msg, level: "info" } }, () => void chrome.runtime.lastError);
    });
    $("#btn-new").addEventListener("click", async () => {
        const id = uuid();
        await send({ type: "saveScript", id, code: STARTER_TEMPLATE, name: "My first script" });
        await refresh();
        selectReal(id);
    });
    document.addEventListener("visibilitychange", renderTabBadges);
    $("#btn-clear-log").addEventListener("click", () => {
        $("#log-entries").innerHTML = "";
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
        const script = li && scripts.find((s) => s.id === li.dataset.id);
        const label = script && li!.querySelector<HTMLElement>(".script-name");
        if (label) startRename(label, script!);
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
                updateOpenVscode();
                return;
            }
            try {
                await fsBridge.openFolder();
            } catch (e: any) {
                if (e?.name === "AbortError") {
                    managerLog("scripts folder pick cancelled", "warn");
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

    // import / export
    // import / export — both open a checklist so any subset can travel
    const settingsRow = (g: Record<string, any>) => ({
        label: "Settings (globals)",
        detail: Object.entries(g).map(([k, v]) => `${k}: ${v}`).join(", "),
    });
    const importsWarning = (names: { name: string; code: string }[], offset: number) => (checked: number[]) => {
        const picked = checked.filter((i) => i >= offset).map((i) => i - offset);
        const missing = missingImports(picked, names);
        if (!missing.length) return null;
        return {
            text: `selected scripts import ${missing.map((i) => `"${names[i].name}"`).join(", ")}, which isn't selected`,
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
        const list = scripts.map((s) => ({ name: s.meta.name, code: s.code, enabled: s.enabled }));
        const chosen = await pickRows({
            title: "Export",
            intro: "Pick what goes into the YAML bundle. Each script carries its code, enabled state and non-default params.",
            rows: [
                ...(globals ? [settingsRow(globals)] : []),
                ...list.map((s) => ({ label: s.name, badge: s.enabled ? undefined : "disabled" })),
            ],
            confirm: "Export",
            warn: importsWarning(list, offset),
        });
        if (!chosen) return;
        const picked = chosen.filter((i) => i >= offset).map((i) => list[i - offset]);
        const payload = buildBundle({ ...doc, settings: globals && chosen.includes(0) ? globals : null }, picked);
        const blob = new Blob([payload], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = picked.length === 1 && chosen.length === 1 ? `${picked[0].name}.wiretrick.yaml` : "wiretrick-export.yaml";
        a.click();
        URL.revokeObjectURL(url);
        status(`exported ${picked.length} script(s)${offset && chosen.includes(0) ? " + settings" : ""} ✓`);
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
        input.accept = ".yaml,.yml,.json,.ts,.js";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const text = await file.text();
            const isYaml = /\.ya?ml$/i.test(file.name);
            if (isYaml || file.name.endsWith(".json")) {
                // bundle formats: yaml (new) or json (legacy, incl. its
                // settings object)
                const full = parseBundleText(text);
                if (full) {
                    const offset = full.settings ? 1 : 0;
                    const named = full.scripts.map((s, i) => ({ name: s.name ?? `script ${i + 1}`, code: s.code }));
                    const chosen = await pickRows({
                        title: `Import ${file.name}`,
                        intro: "Pick what to import. A script replaces the existing script of the same name.",
                        rows: [
                            ...(full.settings ? [settingsRow(full.settings)] : []),
                            ...named.map((s, i) => ({
                                label: s.name,
                                badge: existsBadge(full.scripts[i].name),
                                detail: full.scripts[i].params ? `params: ${Object.keys(full.scripts[i].params!).join(", ")}` : undefined,
                            })),
                        ],
                        confirm: "Import",
                        warn: importsWarning(named, offset),
                    });
                    if (!chosen) return;
                    const bundle = pickBundle(
                        full,
                        offset > 0 && chosen.includes(0),
                        chosen.filter((i) => i >= offset).map((i) => i - offset)
                    );
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
                    status(`imported ${bundle.scripts.length} script(s)${bundle.settings ? " + settings" : ""} ✓`);
                    return;
                }
                if (isYaml) {
                    status('not a Wiretrick export (missing "format: wiretrick-bundle")', "error");
                    return;
                }
                // legacy: a plain json array / single script object
                const parsed = JSON.parse(text);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) await saveImported(item);
                status(`imported ${items.length} script(s) ✓`);
            } else {
                const base = cleanScriptName(file.name.replace(/\.ts$/i, "").replace(/\.script$/i, "")) || "Imported script";
                const name = uniqueScriptName(base, scripts.map((s) => s.meta.name));
                await send({ type: "saveScript", id: uuid(), code: text, name });
                status("imported script ✓");
            }
            await refresh();
        };
        input.click();
    });

    applyLayout();
    makeSplitV();
    setupPanelDock();
    makeLogFilters();
    setupPanelTabs();
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

    // deep link from the popup: manager.html?script=<id>
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
    // ⌥Z types a character (Ω on macOS) in the log/network filter boxes
    const typing = (e.target as HTMLElement | null)?.matches?.("input, textarea, select");
    if (e.altKey && !mod && !e.shiftKey && e.code === "KeyZ" && !typing) return toggleWordWrap;
    return null;
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
        ["wt.showShortcuts", "Help: Keyboard Shortcuts", [], showShortcutsHelp],
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

function select(id: string): void {
    if (dirty && selectedId) {
        if (!confirm("Discard unsaved changes?")) {
            return;
        }
    }
    if (id === SETTINGS_ID) void selectSettings();
    else selectReal(id);
}

let monacoVerbose = false;

/** Navigation diagnostics. Warnings/errors always log; the rest only with the
 * "Verbose Monaco logging" setting. Verbose lines use "warn" so the panel's
 * level filter never hides them. */
function managerLog(msg: string, level: string): void {
    const text = `[manager] ${msg}`;
    appendLog({ at: Date.now(), message: text, level });
    chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "manager", msg, level } }, () => void chrome.runtime.lastError);
}

function navLog(msg: string, level = "info"): void {
    if (level === "info") {
        if (!monacoVerbose) return;
        level = "warn";
    }
    const text = `[manager] nav: ${msg}`;
    console.debug(text);
    appendLog({ at: Date.now(), message: text, level });
    chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "manager", msg: `nav: ${msg}`, level } }, () => void chrome.runtime.lastError);
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
        navLog(`open ${resource.toString()} sel=${JSON.stringify(selection)} from=${selectedId} dirty=${dirty}`);
        const target = [...models].find(([, m]) => m.uri.toString() === resource.toString());
        if (!target) {
            navLog(`no script owns ${resource.toString()}; known models: ${known.join(", ")}`, "warn");
            return false;
        }
        const [id] = target;
        if (id !== selectedId) {
            if (dirty && selectedId && !confirm("Discard unsaved changes?")) {
                navLog("canceled by user (unsaved changes kept)");
                return true;
            }
            selectReal(id);
        }
        if (selection) {
            if ("startLineNumber" in selection) {
                editor.setSelection(selection);
                editor.revealRangeInCenter(selection);
            } else {
                editor.setPosition(selection);
                editor.revealPositionInCenter(selection);
            }
        }
        editor.focus();
        navLog(`opened ${id}`);
        return true;
    } catch (e) {
        navLog(`failed: ${e instanceof Error ? e.stack || e.message : String(e)}`, "error");
        return false;
    }
}

main();
