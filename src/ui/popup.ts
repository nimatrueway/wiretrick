/**
 * Browser-action popup: list scripts, toggle them, open the full manager
 * on a specific script.
 */

interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    meta: { name: string; declared?: boolean };
    paramDefs?: Record<string, any>;
}

interface ParamDef {
    type: "boolean" | "number" | "string" | "enum" | "stringList";
    default?: any;
    choices?: string[];
    description?: string;
    min?: number;
    max?: number;
    step?: number;
    multiline?: boolean;
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

/** MV3: the SW idles out after ~30s — the popup's first messages race its
 * wake-up ("Receiving end does not exist"). Retry until it answers. */
async function sendWake<T = any>(msg: any, attempts = 6): Promise<T> {
    let last: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await send<T>(msg);
        } catch (e: any) {
            if (!/receiving end|context invalidated|message port/i.test(e?.message || "")) throw e;
            last = e;
            await new Promise((r) => setTimeout(r, 350));
        }
    }
    throw last;
}

function openManager(scriptId?: string): void {
    const url =
        chrome.runtime.getURL("manager.html") + (scriptId ? `?script=${encodeURIComponent(scriptId)}` : "");
    chrome.tabs.create({ url });
    window.close();
}

// ---- resizable popup (Chrome ignores CSS resize on the popup viewport;
// dragging the grip sets explicit body size and the window follows) ----
const MIN_W = 320;
const MIN_H = 160;
const MAX_W = 780; // Chrome popup ceiling
const MAX_H = 580;

function applySize(w: number, h: number): void {
    document.body.style.width = `${Math.max(MIN_W, Math.min(MAX_W, w))}px`;
    document.body.style.height = `${Math.max(MIN_H, Math.min(MAX_H, h))}px`;
}

function makeResizable(): void {
    chrome.storage.local.get("resPopupSize", (d) => {
        const size = d?.resPopupSize;
        if (size && size.w && size.h) applySize(size.w, size.h);
    });
    const grip = $("#resize-grip");
    grip.addEventListener("mousedown", (e) => {
        e.preventDefault();
        document.body.classList.add("resizing");
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = document.body.offsetWidth;
        const startH = document.body.offsetHeight;
        const move = (ev: MouseEvent) => applySize(startW + ev.clientX - startX, startH + ev.clientY - startY);
        const up = (ev: MouseEvent) => {
            document.body.classList.remove("resizing");
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            const size = { w: startW + ev.clientX - startX, h: startH + ev.clientY - startY };
            chrome.storage.local.set({ resPopupSize: { w: Math.max(MIN_W, Math.min(MAX_W, size.w)), h: Math.max(MIN_H, Math.min(MAX_H, size.h)) } });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
}

const ICON_PEN =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';

function render(scripts: ScriptInfo[]): void {
    const list = $("#script-list");
    list.innerHTML = "";
    $("#empty").classList.toggle("hidden", scripts.length > 0);

    for (const script of scripts) {
        // libraries (no res.declareScript) never appear in the popup —
        // they're inert on their own and only imported by other scripts
        if (script.meta.declared === false) continue;
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
            conf.className = "btn-fold";
            conf.textContent = "▸";
            conf.title = "Show parameters";
            conf.setAttribute("aria-label", "Toggle parameters");
            conf.addEventListener("click", () => void toggleFold(script, li, conf));
            li.appendChild(conf);
        }
        list.appendChild(li);
    }
}

// ---- inline parameter folds ----
const openFolds = new Set<string>();

async function toggleFold(script: ScriptInfo, li: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    const existing = li.nextElementSibling;
    if (openFolds.has(script.id) && existing && existing.classList.contains("param-fold")) {
        existing.remove();
        openFolds.delete(script.id);
        btn.textContent = "▸";
        btn.title = "Show parameters";
        return;
    }
    openFolds.add(script.id);
    btn.textContent = "▾";
    btn.title = "Hide parameters";
    const fold = document.createElement("li");
    fold.className = "param-fold";
    fold.textContent = "Loading…";
    li.after(fold);
    const { defs, values } = await send<{ defs: Record<string, ParamDef>; values: Record<string, any> }>({
        type: "getScriptParams",
        scriptId: script.id,
    });
    if (!openFolds.has(script.id) || !fold.isConnected) return; // closed meanwhile
    fold.innerHTML = "";
    for (const [key, def] of Object.entries(defs)) {
        fold.appendChild(renderParam(script.id, key, def, values[key]));
    }
    if (!Object.keys(defs).length) fold.textContent = "This script declares no parameters.";
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
        const input = def.multiline ? document.createElement("textarea") : document.createElement("input");
        if (input instanceof HTMLInputElement) input.type = "text";
        else input.spellcheck = false;
        input.value = value ?? "";
        input.addEventListener("change", () => void setParam(scriptId, key, input.value));
        row.appendChild(input);
    } else if (def.type === "number") {
        const input = document.createElement("input");
        input.type = "number";
        input.value = String(value ?? 0);
        if (def.min !== undefined) input.min = String(def.min);
        if (def.max !== undefined) input.max = String(def.max);
        if (def.step !== undefined) input.step = String(def.step);
        input.addEventListener("change", () => {
            let n = Number(input.value);
            if (!isFinite(n)) n = 0;
            if (def.min !== undefined) n = Math.max(def.min, n);
            if (def.max !== undefined) n = Math.min(def.max, n);
            input.value = String(n);
            void setParam(scriptId, key, n);
        });
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
        const ta = document.createElement("textarea");
        ta.value = (Array.isArray(value) ? value : []).join("\n");
        ta.spellcheck = false;
        ta.placeholder = "one value per line";
        ta.addEventListener("change", () => {
            const list = ta.value.split("\n").map((x) => x.trim()).filter(Boolean);
            void setParam(scriptId, key, list);
        });
        row.appendChild(ta);
    }
    return row;
}

async function main(): Promise<void> {
    $("#btn-manager").addEventListener("click", () => openManager());
    makeResizable();
    try {
        // sendWake: the first message may race the SW's wake-up (MV3)
        render((await sendWake<ScriptInfo[]>({ type: "listScripts" })) || []);
    } catch (e: any) {
        console.warn("[res:popup] listing scripts failed", e);
        render([]);
        const status = $("#empty");
        if (status) status.textContent = "Could not reach the extension — close and reopen the popup.";
        return;
    }
    // ensure the Tier-B proxy service worker is active (persists after
    // close) — MV2 only: sw.js with scope "/". MV3 has no proxy tier at
    // all (DNR redirects cannot serve dynamic bodies — proxyRules.ts
    // logs the limitation); browser-initiated loads pass through.
    if (!__MV3__) {
        try {
            await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        } catch (e) {
            console.warn("[res:popup] proxy SW registration failed", e);
            try {
                chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "popup", msg: `proxy SW registration failed: ${e} (the proxy tier cannot intercept until it succeeds)`, level: "warn" } }, () => void chrome.runtime.lastError);
            } catch {}
        }
    }
}

main();
