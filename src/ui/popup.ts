/**
 * Browser-action popup: list scripts, toggle them, open the full manager
 * on a specific script.
 */

interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    meta: { name: string };
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

function send<T = any>(msg: any): Promise<T> {
    return chrome.runtime.sendMessage(msg);
}

function openManager(scriptId?: string): void {
    const url =
        chrome.runtime.getURL("manager.html") + (scriptId ? `?script=${encodeURIComponent(scriptId)}` : "");
    chrome.tabs.create({ url });
    window.close();
}

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
        edit.className = "btn-edit";
        edit.textContent = "Edit";
        edit.title = "Open in full manager";
        edit.addEventListener("click", () => openManager(script.id));

        li.append(toggle, name, edit);
        list.appendChild(li);
    }
}

async function main(): Promise<void> {
    $("#btn-manager").addEventListener("click", () => openManager());
    render(await send({ type: "listScripts" }));
}

main();
