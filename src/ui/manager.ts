/**
 * Manager page: script list + Monaco editor + logs + VS Code bridge.
 */

import { loadMonaco, STARTER_TEMPLATE } from "./monacoSetup";
import { API_REFERENCE } from "./apiReference";
import { SAMPLES } from "./samples";
import * as fsBridge from "./fsBridge";
import { buildBundle, parseBundleText, bundleSettingsDoc, vscodeTargetPath } from "./bundle";
import { createQuickOpenPalette } from "./quickOpen";
import { computeDirty } from "./dirtyState";
import { parseSettings, SETTINGS_FILE, type SettingsDoc } from "../shared/settingsYaml";
import { dlogLevel } from "../shared/debugLog";
import type { Uri, IPosition, IRange, IKeyboardEvent, editor as MonacoEditor } from "monaco-editor";
import type { Script } from "../background/engine/scriptStore";

// ---- state ----
let scripts: Script[] = [];
let selectedId: string | null = null;
let editor: any = null;
let dirty = false;

/** Central dirty-state toggle: dims/undims Save. */
function setDirty(v: boolean): void {
    dirty = v;
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
    const isScript = !!selectedId && selectedId !== SETTINGS_ID;
    const script = isScript ? scripts.find((s) => s.id === selectedId) : null;
    const dirtyNow = computeDirty(
        m ? m.getValue() : "",
        m ? (baselines.get(m.uri.toString()) ?? null) : null,
        isScript ? $input("#script-name").value : undefined,
        script ? script.meta.name : undefined
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

function status(text: string, cls = ""): void {
    const el = $("#editor-status");
    el.textContent = text;
    el.className = cls;
}

// ---- script list ----
const SETTINGS_ID = "__settings__";
let settingsModel: any = null;

async function loadSettingsModel(force = false): Promise<void> {
    if (!editor) return;
    const monaco = (window as any).monaco;
    // Monaco's built-in yaml basic language provides colorization
    const { text } = await send({ type: "getSettingsYaml", text: settingsModel?.getValue() });
    if (!settingsModel) {
        settingsModel = monaco.editor.createModel(text, "yaml", monaco.Uri.parse("file:///settings.yaml"));
        setBaseline(settingsModel, text);
    } else if (settingsModel.getValue() !== text && (force || !dirty)) {
        applyingExternal = true;
        settingsModel.setValue(text);
        applyingExternal = false;
        setBaseline(settingsModel, text);
    }
}

async function selectSettings(): Promise<void> {
    selectedId = SETTINGS_ID;
    renderList();
    $input("#script-name").value = "settings.yaml";
    $("#script-name").setAttribute("disabled", "");
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
    scripts = await send({ type: "listScripts" });
    renderList();
    syncModels();
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

function renderList(): void {
    const list = $("#script-list");
    list.innerHTML = "";
    const sli = document.createElement("li");
    sli.className = "script-item utility" + (selectedId === SETTINGS_ID ? " selected" : "");
    sli.dataset.id = SETTINGS_ID;
    const gear = document.createElement("span");
    gear.className = "util-icon";
    gear.textContent = "⚙";
    gear.title = "Settings file — global settings and per-script params & enabled state";
    const sname = document.createElement("span");
    sname.className = "script-name";
    sname.textContent = "settings.yaml";
    sli.append(gear, sname);
    sli.addEventListener("click", () => select(SETTINGS_ID));
    list.appendChild(sli);
    for (const script of scripts) {
        const isLib = script.meta.declared === false;
        const li = document.createElement("li");
        li.className = "script-item" + (script.id === selectedId ? " selected" : "") + (isLib ? " utility" : "");
        li.dataset.id = script.id;

        let toggle: HTMLElement;
        if (isLib) {
            // utility module: no toggle — it's inert on its own, importable
            toggle = document.createElement("span");
            toggle.className = "util-icon";
            toggle.textContent = "𝑓";
            toggle.title = "Utility module — importable by other scripts, never runs on its own";
        } else {
            const sw = document.createElement("div");
            sw.className = "switch" + (script.enabled ? " on" : "");
            sw.title = script.enabled ? "Disable" : "Enable";
            sw.addEventListener("click", async (e) => {
                e.stopPropagation();
                await send({ type: "setEnabled", id: script.id, enabled: !script.enabled });
                await refresh();
            });
            toggle = sw;
        }

        const name = document.createElement("span");
        name.className = "script-name";
        name.textContent = script.meta.name + (script.error ? " ⚠" : "");
        name.title = script.error || script.meta.match.join(", ");

        const del = document.createElement("button");
        del.className = "btn-del";
        del.textContent = "✕";
        del.title = "Delete script";
        del.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${script.meta.name}"?`)) return;
            await send({ type: "deleteScript", id: script.id });
            if (fsBridge.isSyncing()) {
                await send({ type: "folderDelete", fileName: fsBridge.fileNameFor(script.id, script.meta.name) });
            }
            await refresh();
        });

        li.append(toggle, name, del);
        li.addEventListener("click", () => select(script.id));
        list.appendChild(li);
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

function safeFileName(name: string): string {
    return (name || "script").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "script";
}

function syncModels(): void {
    if (!editor) return;
    const monaco = (window as any).monaco;
    const seen = new Set<string>();
    for (const s of scripts) {
        seen.add(s.id);
        const uri = monaco.Uri.parse(`file:///${safeFileName(s.meta.name)}.ts`);
        let m = models.get(s.id);
        if (m && m.uri.toString() !== uri.toString()) {
            // renamed: fresh model at the new path, drop the old one
            m.dispose();
            m = null;
            models.delete(s.id);
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

async function renderEditorEmpty(): Promise<void> {
    $("#script-name").setAttribute("disabled", "");
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
    renderList();
    const script = scripts.find((s) => s.id === id);
    if (!script) return;
    $input("#script-name").value = script.meta.name;
    $("#script-name").removeAttribute("disabled");
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
    const name = $input("#script-name").value.trim() || "Untitled script";
    const result = await send({ type: "saveScript", id: selectedId, code, name });
    if (result && result.error) {
        status("script error — see log", "error");
        void result;
    } else {
        status("saved ✓");
        const m = models.get(selectedId);
        if (m) setBaseline(m, code); // the stored text is now the baseline
    }
    setDirty(false);
    // two-way sync: push the saved source into the VS Code folder
    if (fsBridge.isSyncing()) {
        await send({ type: "folderWriteBack", fileName: fsBridge.fileNameFor(selectedId, name), content: code });
    }
    await refresh();
    renderList();
}

// ---- logs ----
function connectLogs(): void {
    const port = chrome.runtime.connect({ name: "logs" });
    port.onMessage.addListener((msg: any) => {
        if (msg.type === "log") appendLog(msg.entry);
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

/** All received entries — filtered ones stay here (re-renderable), just not in the DOM. */
const logEntries: { text: string; level: string; source: string }[] = [];

function appendLog(entry: any): void {
    const time = new Date(entry.at).toLocaleTimeString();
    const source = sourceOf(entry.message || "");
    logEntries.push({ text: `[${time}] ${entry.message}`, level: entry.level || "info", source });
    if (logEntries.length > 2000) logEntries.splice(0, logEntries.length - 2000); // absolute buffer cap
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
function openDialog(id: string): void {
    document.getElementById(id)?.classList.remove("hidden");
}
function closeDialog(el: Element): void {
    el.classList.add("hidden");
}

function setupDialogs(): void {
    $("#btn-settings").addEventListener("click", () => openDialog("settings-panel"));
    $("#btn-help").addEventListener("click", () => openDialog("help-panel"));
    $("#btn-samples").addEventListener("click", () => {
        renderSamples();
        openDialog("samples-panel");
    });
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

    // panel history size
    const capInput = $("#settings-log-cap") as HTMLInputElement;
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
        if (c.resScripts || c.resParams || c.resLogLevel || c.resLogCap) {
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
            document.getElementById("samples-panel")?.classList.add("hidden");
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

function displayNameFromFile(fileName: string): string {
    return fileName.replace(/\.ts$/, "").replace(/_/g, " ").slice(0, 60) || "Imported script";
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
        status("scripts folder needs reconnect — click 'Scripts Folder…'");
        btn.textContent = "Scripts Folder… (reconnect)";
        $("#folder-state").textContent = "reconnect needed";
        btn.addEventListener("click", async () => {
            if (fsBridge.isSyncing()) return;
            const ok = await fsBridge.reconnectClicked();
            if (ok) {
                await markFolderSynced();
                status("scripts folder reconnected ✓");
            }
        }, { once: true });
    }
}

// ---- movable panels ----
interface PanelLayout {
    sidebarW?: number;
    logH?: number;
    logDock?: "bottom" | "right";
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
    if (l.logH) $("#log-panel").style.height = `${l.logH}px`;
    if (l.logDock === "right") {
        document.getElementById("app")?.classList.add("log-right");
        $("#editor-area")?.appendChild($("#log-panel").parentElement === $("#editor-area") ? $("#log-panel") : $("#log-panel"));
    }
}

function makeSplitV(): void {
    const handle = $("#split-v");
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        handle.classList.add("dragging");
        const move = (ev: MouseEvent) => {
            const w = Math.min(620, Math.max(200, ev.clientX));
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

function makeSplitH(): void {
    const handle = $("#split-h");
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (document.getElementById("app")?.classList.contains("log-right")) {
            // right-dock mode: adjust log width instead
            handle.classList.add("dragging");
            const move = (ev: MouseEvent) => {
                const w = Math.min(620, Math.max(200, window.innerWidth - ev.clientX));
                $("#log-panel").style.width = `${w}px`;
            };
            const up = () => {
                handle.classList.remove("dragging");
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
                const l = loadLayout();
                l.logH = $("#log-panel").offsetHeight;
                saveLayout(l);
            };
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
            return;
        }
        handle.classList.add("dragging");
        const startY = e.clientY;
        const startH = $("#log-panel").offsetHeight;
        const move = (ev: MouseEvent) => {
            const h = Math.min(window.innerHeight - 220, Math.max(80, startH + (startY - ev.clientY)));
            $("#log-panel").style.height = `${h}px`;
        };
        const up = () => {
            handle.classList.remove("dragging");
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            const l = loadLayout();
            l.logH = $("#log-panel").offsetHeight;
            saveLayout(l);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
}

function makeLogMovable(): void {
    const header = $("#log-header");
    header.addEventListener("mousedown", (e) => {
        // don't start a drag from the find input, level select, or the
        // clear button — preventDefault would block focusing/opening them
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "OPTION") return;
        e.preventDefault();
        const startX = e.clientX;
        const app = document.getElementById("app");
        const wasRight = app?.classList.contains("log-right");
        const move = (ev: MouseEvent) => {
            const dx = ev.clientX - startX;
            if (!wasRight && dx > 120) {
                app?.classList.add("log-right");
                app?.appendChild($("#log-panel")); // move into the app row (right of editor)
                const l = loadLayout();
                l.logDock = "right";
                saveLayout(l);
            } else if (wasRight && dx < -120) {
                app?.classList.remove("log-right");
                $("#editor-area")?.appendChild($("#log-panel")); // back under the editor
                const l = loadLayout();
                l.logDock = "bottom";
                saveLayout(l);
            }
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
}

// ---- wiring ----
async function main(): Promise<void> {
    await loadMonaco();
    // test/e2e seam: adopt an arbitrary directory handle (e.g. OPFS) for watching
    (window as any).__resAdoptFolder = (h: any) => fsBridge.adoptForWatch(h);
    editor = (window as any).monaco.editor.create($("#monaco-host"), {
        value: "",
        language: "typescript",
        theme: "vs-dark",
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
    });
    editor.addCommand((window as any).monaco.KeyMod.CtrlCmd | (window as any).monaco.KeyCode.KeyS, () => void saveCurrent());
    // VS Code shortcuts: ⌘P quick-open (scripts + settings.yaml), ⌘, opens
    // the Settings dialog. ⌘/ (comment), ⌘F (find), ⌘D (next occurrence)
    // and Shift+Alt+A (block comment) are Monaco built-ins.
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
            openDialog("settings-panel");
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

    $("#btn-save").addEventListener("click", () => void saveCurrent());
    $("#btn-debug-bg").addEventListener("click", () => {
        // MV2 has no API that opens DevTools for the live background event
        // page (chrome.debugger is CDP sessions for OTHER targets; opening
        // background.html in a tab spawns a second instance, not the live
        // one). chrome://extensions' "Inspect views" is the only way in —
        // and chrome.tabs.create may navigate to chrome:// URLs (links and
        // window.open may not).
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }, () => void chrome.runtime.lastError);
        status('inspect background: click "background page" under Inspect views');
    });
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
    $("#btn-clear-log").addEventListener("click", () => {
        $("#log-entries").innerHTML = "";
        void send({ type: "clearDebugLogs" });
    });
    $("#btn-logs").addEventListener("click", async () => {
        const bg = await send({ type: "getDebugLogs" });
        const lines: string[] = [
            `ResScript debug log — ${new Date().toISOString()}`,
            `UA: ${bg.ua} | extension v${bg.ver}`,
            `entries: ${bg.entries ? bg.entries.length : 0}`,
            "",
            ...(bg.entries || []).map((e: any) => `${new Date(e.at).toISOString()} [${e.src}] ${e.msg}`),
        ];
        const blob = new Blob([lines.join("\n")], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rescript-debug-${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);
        status("debug log downloaded");
    });
    $("#script-name").addEventListener("input", () => {
        updateDirty();
        if (dirty) status("unsaved (name) — save to apply", "dirty");
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
            await fsBridge.openFolder(async () => scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })));
            await markFolderSynced();
        });
    } else {
        btn.setAttribute("disabled", "");
        btn.title = "File System Access API unavailable (Firefox) — use Import/Export";
    }

    // import / export
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
        const payload = buildBundle(
            doc,
            scripts.map((s) => ({ name: s.meta.name, code: s.code, enabled: s.enabled }))
        );
        const blob = new Blob([payload], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "rescripts-export.yaml";
        a.click();
        URL.revokeObjectURL(url);
    });
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
                const bundle = parseBundleText(text);
                if (bundle) {
                    for (const item of bundle.scripts) {
                        await send({ type: "saveScript", id: uuid(), code: item.code, name: item.name, enabled: item.enabled });
                    }
                    // settings apply through the real path (params +
                    // globals); storage.onChanged refreshes the settings UI
                    const doc = bundleSettingsDoc(bundle);
                    if (doc) {
                        const res = await send({ type: "applySettingsDoc", doc });
                        if (res && res.error) {
                            status(`imported ${bundle.scripts.length} script(s); settings: ${res.error}`, "error");
                            return;
                        }
                        status(`imported ${bundle.scripts.length} script(s) + settings ✓`);
                        return;
                    }
                    status(`imported ${bundle.scripts.length} script(s) ✓`);
                    return;
                }
                if (isYaml) {
                    status('not a ResScript export (missing "format: rescript-bundle")', "error");
                    return;
                }
                // legacy: a plain json array / single script object
                const parsed = JSON.parse(text);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                    await send({ type: "saveScript", id: uuid(), code: item.code, name: item.name, enabled: item.enabled });
                }
                status(`imported ${items.length} script(s) ✓`);
            } else {
                await send({ type: "saveScript", id: uuid(), code: text, name: "Imported script" });
                status("imported script ✓");
            }
            await refresh();
        };
        input.click();
    });

    applyLayout();
    makeSplitV();
    makeSplitH();
    makeLogMovable();
    makeLogFilters();
    startKeepAlive();
    setupDialogs();
    

    // ensure the Tier-B proxy service worker is active
    void autoReconnectFolder();

    // remember the manager is open → the background reopens it after an
    // extension reload (the renderer itself cannot survive)
    chrome.storage.local.set({ resManagerOpen: true });
    window.addEventListener("beforeunload", () => {
        // only clear when the user actually closed the tab; a killed
        // renderer (extension reload) skips beforeunload entirely
        chrome.storage.local.set({ resManagerOpen: false });
    });

    // ensure the Tier-B proxy service worker is active — MV2 only (MV3 has
    // no proxy tier: DNR redirects cannot serve dynamic bodies —
    // proxyRules.ts logs the limitation)
    if (!__MV3__) {
        try {
            await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        } catch (e) {
            console.warn("[ResOverride] proxy SW registration failed", e);
            dlogLevel("proxy", "warn", `proxy SW registration failed — the proxy tier cannot intercept until it succeeds: ${e}`);
        }
    }

    connectLogs();
    await refresh();

    // deep link from the popup: manager.html?script=<id>
    const wanted = new URLSearchParams(location.search).get("script");
    if (wanted && scripts.some((s) => s.id === wanted)) {
        selectReal(wanted);
    }
}

void renderEditorEmpty;

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
    window.addEventListener("error", (e) => navLog(`window error: ${e.message}`, "error"));
    window.addEventListener("unhandledrejection", (e) => {
        const reason: any = (e as PromiseRejectionEvent).reason;
        // Monaco's internal async work (e.g. view-state restore scheduling)
        // rejects with its cancellation error when a rapid model switch
        // invalidates it — benign, don't litter the log
        if (reason && (reason.name === "Canceled" || reason.message === "Canceled")) return;
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
