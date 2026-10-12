/**
 * Manager page: script list + Monaco editor + logs + VS Code bridge.
 */

import { loadMonaco, STARTER_TEMPLATE } from "./monacoSetup";
import * as fsBridge from "./fsBridge";
import type { Script } from "../background/engine/scriptStore";

// ---- state ----
let scripts: Script[] = [];
let selectedId: string | null = null;
let editor: any = null;
let dirty = false;

// ---- elements ----
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const $input = (sel: string): HTMLInputElement => document.querySelector(sel) as HTMLInputElement;

// ---- helpers ----
function send<T = any>(msg: any): Promise<T> {
    return chrome.runtime.sendMessage(msg);
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
async function refresh(): Promise<void> {
    scripts = await send({ type: "listScripts" });
    renderList();
    if (selectedId && !scripts.some((s) => s.id === selectedId)) {
        selectedId = null;
    }
    if (!selectedId && scripts.length > 0) {
        select(scripts[0].id);
    } else if (!selectedId) {
        renderEditorEmpty();
    }
}

function renderList(): void {
    const list = $("#script-list");
    list.innerHTML = "";
    for (const script of scripts) {
        const li = document.createElement("li");
        li.className = "script-item" + (script.id === selectedId ? " selected" : "");
        li.dataset.id = script.id;

        const toggle = document.createElement("div");
        toggle.className = "switch" + (script.enabled ? " on" : "");
        toggle.title = script.enabled ? "Disable" : "Enable";
        toggle.addEventListener("click", async (e) => {
            e.stopPropagation();
            await send({ type: "setEnabled", id: script.id, enabled: !script.enabled });
            await refresh();
        });

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
            await refresh();
        });

        li.append(toggle, name, del);
        li.addEventListener("click", () => select(script.id));
        list.appendChild(li);
    }
}

// ---- editor ----
async function renderEditorEmpty(): Promise<void> {
    $("#script-name").setAttribute("disabled", "");
    $("#btn-save").setAttribute("disabled", "");
    if (editor) {
        editor.setValue("// Select or create a script to start editing.");
    }
}

function selectReal(id: string): void {
    selectedId = id;
    renderList();
    const script = scripts.find((s) => s.id === id);
    if (!script) return;
    $input("#script-name").value = script.meta.name;
    $("#script-name").removeAttribute("disabled");
    $("#btn-save").removeAttribute("disabled");
    if (editor) {
        editor.setValue(script.code);
        editor.clearHistory?.();
    }
    dirty = false;
    status("saved");
}

async function saveCurrent(): Promise<void> {
    if (!selectedId || !editor) return;
    const code = editor.getValue();
    const name = $input("#script-name").value.trim() || "Untitled script";
    const result = await send({ type: "saveScript", id: selectedId, code, name });
    if (result && result.error) {
        status("script error — see log", "error");
        void result;
    } else {
        status("saved ✓");
    }
    dirty = false;
    await refresh();
    renderList();
}

// ---- logs ----
function connectLogs(): void {
    const port = chrome.runtime.connect({ name: "logs" });
    port.onMessage.addListener((msg: any) => {
        if (msg.type === "log") appendLog(msg.entry);
    });
}

function appendLog(entry: any): void {
    const box = $("#log-entries");
    const line = document.createElement("div");
    line.className = "log-line " + entry.level;
    const time = new Date(entry.at).toLocaleTimeString();
    line.textContent = `[${time}] ${entry.message}`;
    box.appendChild(line);
    while (box.children.length > 300) box.removeChild(box.firstChild as Node);
    box.scrollTop = box.scrollHeight;
}

// ---- wiring ----
async function main(): Promise<void> {
    await loadMonaco();
    editor = (window as any).monaco.editor.create($("#monaco-host"), {
        value: "",
        language: "typescript",
        theme: "vs-dark",
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
    });
    editor.addCommand((window as any).monaco.KeyMod.CtrlCmd | (window as any).monaco.KeyCode.KeyS, () => void saveCurrent());

    editor.onDidChangeModelContent(() => {
        dirty = true;
        status("unsaved…", "dirty");
    });

    $("#btn-save").addEventListener("click", () => void saveCurrent());
    $("#btn-new").addEventListener("click", async () => {
        const id = uuid();
        await send({ type: "saveScript", id, code: STARTER_TEMPLATE, name: "My first script" });
        await refresh();
        selectReal(id);
    });
    $("#btn-clear-log").addEventListener("click", () => {
        $("#log-entries").innerHTML = "";
    });
    $("#script-name").addEventListener("input", () => {
        dirty = true;
        status("unsaved (name) — save to apply", "dirty");
    });

    // VS Code folder sync
    const btn = $("#btn-vscode");
    if (fsBridge.isSupported()) {
        btn.addEventListener("click", async () => {
            if (fsBridge.isSyncing()) {
                fsBridge.stopSync();
                btn.classList.remove("active");
                btn.textContent = "VS Code…";
                return;
            }
            await fsBridge.openFolder(async () => scripts.map((s) => ({ name: s.meta.name, code: s.code })));
            (window as any).__resFbOnFileChanged = async (fileName: string, js: string) => {
                const name = fileName.replace(/\.ts$/, "");
                const target = scripts.find((s) => s.meta.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) === name);
                if (!target) return;
                await send({ type: "saveScript", id: target.id, code: js, name: target.meta.name });
                status(`hot-reloaded ${fileName} from VS Code ✓`);
                await refresh();
            };
            btn.classList.add("active");
            btn.textContent = "VS Code ✓ (sync on)";
        });
    } else {
        btn.setAttribute("disabled", "");
        btn.title = "File System Access API unavailable (Firefox) — use Import/Export";
    }

    // import / export
    $("#btn-export").addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(scripts.map((s) => ({ name: s.meta.name, code: s.code, enabled: s.enabled })))], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "rescripts-export.json";
        a.click();
        URL.revokeObjectURL(url);
    });
    $("#btn-import").addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,.ts,.js";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const text = await file.text();
            if (file.name.endsWith(".json")) {
                const parsed = JSON.parse(text);
                for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
                    await send({ type: "saveScript", id: uuid(), code: item.code, name: item.name, enabled: item.enabled });
                }
            } else {
                await send({ type: "saveScript", id: uuid(), code: text, name: "Imported script" });
            }
            await refresh();
        };
        input.click();
    });

    connectLogs();
    await refresh();
}

void renderEditorEmpty;

function select(id: string): void {
    if (dirty && selectedId) {
        if (!confirm("Discard unsaved changes?")) {
            return;
        }
    }
    selectReal(id);
}

main();
