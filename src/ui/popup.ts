/**
 * Browser-action popup: list scripts, toggle them, open the full manager
 * on a specific script.
 */

interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    meta: { name: string };
    paramDefs?: Record<string, any>;
}

interface ParamDef {
    type: "boolean" | "string" | "enum" | "stringList";
    default?: any;
    choices?: string[];
    description?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

function send<T = any>(msg: any): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp: T) => {
            const err = (chrome.runtime as any).lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp);
        });
    });
}

function openManager(scriptId?: string): void {
    const url =
        chrome.runtime.getURL("manager.html") + (scriptId ? `?script=${encodeURIComponent(scriptId)}` : "");
    chrome.tabs.create({ url });
    window.close();
}

const ICON_PEN =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';
const ICON_GEAR =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319z"/></svg>';

function render(scripts: ScriptInfo[]): void {
    const list = $("#script-list");
    list.innerHTML = "";
    $("#empty").classList.toggle("hidden", scripts.length > 0);

    for (const script of scripts) {
        const li = document.createElement("li");
        li.className = "script-item";

        const toggle = document.createElement("div");
        toggle.className = "switch" + (script.enabled ? " on" : "");
        toggle.title = script.enabled ? "Disable" : "Enable";
        toggle.addEventListener("click", async () => {
            await send({ type: "setEnabled", id: script.id, enabled: !script.enabled });
            render(await send({ type: "listScripts" }));
        });

        const name = document.createElement("span");
        name.className = "script-name" + (script.error ? " error" : "");
        name.textContent = script.meta.name;
        name.title = script.error || "";

        const edit = document.createElement("button");
        edit.className = "btn-icon";
        edit.innerHTML = ICON_PEN;
        edit.title = "Open in full manager";
        edit.setAttribute("aria-label", "Edit");
        edit.addEventListener("click", () => openManager(script.id));

        li.append(toggle, name, edit);

        if (script.paramDefs && Object.keys(script.paramDefs).length) {
            const conf = document.createElement("button");
            conf.className = "btn-icon";
            conf.innerHTML = ICON_GEAR;
            conf.title = "Configure parameters";
            conf.setAttribute("aria-label", "Configure");
            conf.addEventListener("click", () => void openConfig(script));
            li.appendChild(conf);
        }
        list.appendChild(li);
    }
}

// ---- parameter config panel ----
let configScriptId: string | null = null;

async function openConfig(script: ScriptInfo): Promise<void> {
    configScriptId = script.id;
    $("#config-title").textContent = script.meta.name;
    const panel = $("#config-panel");
    panel.classList.remove("hidden");
    const body = $("#config-body");
    body.textContent = "Loading…";
    const { defs, values } = await send<{ defs: Record<string, ParamDef>; values: Record<string, any> }>({
        type: "getScriptParams",
        scriptId: script.id,
    });
    if (configScriptId !== script.id) return; // closed meanwhile
    body.innerHTML = "";
    for (const [key, def] of Object.entries(defs)) {
        body.appendChild(renderParam(script.id, key, def, values[key]));
    }
    if (!Object.keys(defs).length) body.textContent = "This script declares no parameters.";
}

async function setParam(scriptId: string, key: string, value: any): Promise<void> {
    await send({ type: "setScriptParam", scriptId, key, value });
}

function renderParam(scriptId: string, key: string, def: ParamDef, value: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "param-row";

    const label = document.createElement("div");
    label.className = "param-label";
    const name = document.createElement("span");
    name.textContent = key;
    label.appendChild(name);
    row.appendChild(label);

    if (def.description) {
        const desc = document.createElement("div");
        desc.className = "param-desc";
        desc.textContent = def.description;
        row.appendChild(desc);
    }

    if (def.type === "boolean") {
        const sw = document.createElement("div");
        sw.className = "switch" + (value ? " on" : "");
        sw.title = value ? "On" : "Off";
        sw.addEventListener("click", async () => {
            const next = !sw.classList.contains("on");
            sw.classList.toggle("on", next);
            await setParam(scriptId, key, next);
        });
        label.appendChild(sw);
    } else if (def.type === "string") {
        const input = document.createElement("input");
        input.type = "text";
        input.value = value ?? "";
        input.addEventListener("change", () => void setParam(scriptId, key, input.value));
        row.appendChild(input);
    } else if (def.type === "enum") {
        const sel = document.createElement("select");
        for (const choice of def.choices || []) {
            const o = document.createElement("option");
            o.value = choice;
            o.textContent = choice;
            sel.appendChild(o);
        }
        sel.value = value ?? def.choices?.[0] ?? "";
        sel.addEventListener("change", () => void setParam(scriptId, key, sel.value));
        row.appendChild(sel);
    } else if (def.type === "stringList") {
        const list: string[] = Array.isArray(value) ? [...value] : [];
        const tags = document.createElement("div");
        tags.className = "param-tags";
        const addRow = document.createElement("div");
        addRow.className = "param-add";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "add…";
        const addBtn = document.createElement("button");
        addBtn.textContent = "+";

        const renderTags = () => {
            tags.innerHTML = "";
            for (const item of list) {
                const tag = document.createElement("span");
                tag.className = "param-tag";
                tag.textContent = item;
                const x = document.createElement("button");
                x.textContent = "✕";
                x.title = "Remove";
                x.addEventListener("click", async () => {
                    list.splice(list.indexOf(item), 1);
                    renderTags();
                    await setParam(scriptId, key, [...list]);
                });
                tag.appendChild(x);
                tags.appendChild(tag);
            }
        };
        const add = async () => {
            const v = input.value.trim();
            if (!v || list.includes(v)) return;
            list.push(v);
            input.value = "";
            renderTags();
            await setParam(scriptId, key, [...list]);
        };
        addBtn.addEventListener("click", () => void add());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") void add();
        });
        addRow.append(input, addBtn);
        renderTags();
        row.append(tags, addRow);
    }
    return row;
}

async function main(): Promise<void> {
    $("#btn-manager").addEventListener("click", () => openManager());
    $("#config-close").addEventListener("click", () => {
        configScriptId = null;
        $("#config-panel").classList.add("hidden");
    });
    render(await send({ type: "listScripts" }));
    // ensure the Tier-B proxy service worker is active (persists after close)
    try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        console.log("[res:popup] proxy SW registered");
    } catch (e) {
        console.warn("[res:popup] proxy SW registration failed", e);
    }
}

main();
