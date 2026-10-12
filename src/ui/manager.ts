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
let applyingExternal = false;

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
            if (fsBridge.isSyncing()) {
                await fsBridge.deleteFile(fsBridge.fileNameFor(script.id, script.meta.name));
            }
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

/** Programmatic editor update (select / external hot-reload). */
function setEditorValue(code: string): void {
    if (!editor) return;
    applyingExternal = true;
    editor.setValue(code);
    editor.clearHistory?.();
    applyingExternal = false;
    dirty = false;
    status("saved ✓");
}

function selectReal(id: string): void {
    selectedId = id;
    renderList();
    const script = scripts.find((s) => s.id === id);
    if (!script) return;
    $input("#script-name").value = script.meta.name;
    $("#script-name").removeAttribute("disabled");
    $("#btn-save").removeAttribute("disabled");
    setEditorValue(script.code);
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
    // two-way sync: push the saved source into the VS Code folder
    if (fsBridge.isSyncing()) {
        await fsBridge.writeBack(fsBridge.fileNameFor(selectedId, name), code);
    }
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

let logFindRe: RegExp | null = null;

function appendLog(entry: any): void {
    const box = $("#log-entries");
    const line = document.createElement("div");
    line.className = "log-line " + entry.level;
    line.dataset.text = entry.message;
    const time = new Date(entry.at).toLocaleTimeString();
    const text = `[${time}] ${entry.message}`;

    if (logFindRe) {
        line.innerHTML = "";
        const match = text.match(logFindRe);
        if (!match) {
            line.style.display = "none";
        } else {
            // highlight the first match
            const idx = text.indexOf(match[0]);
            if (idx >= 0) {
                line.append(
                    document.createTextNode(text.slice(0, idx)),
                    Object.assign(document.createElement("mark"), { textContent: match[0] }),
                    document.createTextNode(text.slice(idx + match[0].length))
                );
            } else {
                line.textContent = text;
            }
        }
    } else {
        line.textContent = text;
    }

    box.appendChild(line);
    while (box.children.length > 500) box.removeChild(box.firstChild as Node);
    box.scrollTop = box.scrollHeight;
}

function makeLogFind(): void {
    const input = $("#log-find") as HTMLInputElement;
    input.addEventListener("input", () => {
        const q = input.value.trim();
        try {
            logFindRe = q ? new RegExp(q, "i") : null;
            input.style.borderColor = "";
        } catch {
            // fall back to plain substring on invalid regex
            logFindRe = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
            input.style.borderColor = "";
        }
        // re-apply filtering to existing lines
        const box = $("#log-entries");
        for (const line of Array.from(box.children) as HTMLElement[]) {
            const text = line.dataset.text || line.textContent || "";
            if (!logFindRe) {
                line.style.display = "";
                if (!line.textContent?.startsWith("[")) line.textContent = text;
                continue;
            }
            const m = text.match(logFindRe);
            const time = text.split("] ")[0] + "]";
            if (!m) {
                line.style.display = "none";
            } else {
                line.style.display = "";
                line.innerHTML = "";
                const idx = text.indexOf(m[0]);
                line.append(
                    document.createTextNode(text.slice(0, idx)),
                    Object.assign(document.createElement("mark"), { textContent: m[0] }),
                    document.createTextNode(text.slice(idx + m[0].length))
                );
                void time;
            }
        }
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

// ---- dedicated scripts folder: pick once, edits sync both ways ----
function markFolderSynced(): void {
    const btn = $("#btn-vscode");
    btn.classList.add("active");
    btn.textContent = "Folder ✓ (sync on)";
}

const folderSyncHandlers: fsBridge.FolderSyncHandlers = {
    onFileChanged: async (fileName, js) => {
        const target = scripts.find((sc) => fsBridge.matchesFile(sc.meta.name, fileName));
        if (!target) return;
        await send({ type: "saveScript", id: target.id, code: js, name: target.meta.name });
        await refresh();
        status(`hot-reloaded ${fileName} from VS Code ✓`);
        const updated = scripts.find((sc) => sc.id === target.id);
        if (updated && updated.id === selectedId) {
            setEditorValue(updated.code);
        }
    },
    onFileAdded: async (fileName, js) => {
        await send({ type: "saveScript", id: newId(), code: js, name: displayNameFromFile(fileName) });
        await refresh();
        status(`imported new script from ${fileName} ✓`);
    },
    onFileRemoved: async (fileName) => {
        const target = scripts.find((sc) => fsBridge.matchesFile(sc.meta.name, fileName));
        if (!target) return;
        await send({ type: "deleteScript", id: target.id });
        await refresh();
        status(`script deleted with ${fileName} ✓`);
    },
    onRenamed: async (oldName, newName, js) => {
        const target = scripts.find((sc) => fsBridge.matchesFile(sc.meta.name, oldName));
        const newNameTaken = scripts.some((sc) => fsBridge.matchesFile(sc.meta.name, newName));
        if (target && !newNameTaken) {
            await send({ type: "saveScript", id: target.id, code: js, name: displayNameFromFile(newName) });
            await refresh();
            status(`renamed ${oldName} → ${newName} ✓`);
        } else if (!target) {
            await send({ type: "saveScript", id: newId(), code: js, name: displayNameFromFile(newName) });
            await refresh();
            status(`imported new script from ${newName} ✓`);
        }
    },
};

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
        markFolderSynced();
    } else if (st === "prompt") {
        // one click re-grants (Chrome drops FS grants between restarts)
        status("scripts folder needs reconnect — click 'Folder…'");
        btn.textContent = "Folder… (reconnect)";
        btn.addEventListener("click", async () => {
            if (fsBridge.isSyncing()) return;
            const ok = await fsBridge.reconnectClicked(folderSyncHandlers);
            if (ok) {
                markFolderSynced();
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
        // don't start a drag from the find input or the clear button —
        // preventDefault would block focusing the input
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "INPUT") return;
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
        if (applyingExternal) return;
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
            await fsBridge.openFolder(
                async () => scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
                folderSyncHandlers
            );
            btn.classList.add("active");
            btn.textContent = "Folder ✓ (sync on)";
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

    applyLayout();
    makeSplitV();
    makeSplitH();
    makeLogMovable();
    makeLogFind();
    startKeepAlive();
    void autoReconnectFolder();

    // remember the manager is open → the background reopens it after an
    // extension reload (the renderer itself cannot survive)
    chrome.storage.local.set({ resManagerOpen: true });
    window.addEventListener("beforeunload", () => {
        // only clear when the user actually closed the tab; a killed
        // renderer (extension reload) skips beforeunload entirely
        chrome.storage.local.set({ resManagerOpen: false });
    });

    // ensure the Tier-B proxy service worker is active
    try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch (e) {
        console.warn("[ResOverride] proxy SW registration failed", e);
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
    selectReal(id);
}

main();
