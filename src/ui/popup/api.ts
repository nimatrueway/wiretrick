import { send, sendWake } from "../lib/messaging";
import type { ParamDef } from "../components/ParamField";
import type { ScriptHealthInput } from "../../shared/scriptHealth";

export interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    runtimeError?: ScriptHealthInput["runtimeError"];
    typeErrors?: string[];
    ruleErrors?: string[];
    meta: { name: string; active?: boolean; description?: string };
    paramDefs?: Record<string, any>;
}

export interface ScriptParams {
    defs: Record<string, ParamDef>;
    values: Record<string, any>;
}

/** Everything the popup needs from the extension — swapped for a fake in tests. */
export interface PopupApi {
    listScripts(): Promise<ScriptInfo[]>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    clearError(id: string): Promise<void>;
    getParams(scriptId: string): Promise<ScriptParams>;
    setParam(scriptId: string, key: string, value: any): Promise<void>;
    openManager(scriptId?: string): void;
    loadSize(): Promise<{ w: number; h: number } | null>;
    saveSize(size: { w: number; h: number }): void;
    /** scripts or params changed elsewhere (manager, import, folder sync) — returns an unsubscribe */
    onChange?(fn: () => void): () => void;
}

export const chromePopupApi: PopupApi = {
    // sendWake: the first message may race the SW's wake-up (MV3)
    listScripts: async () => (await sendWake<ScriptInfo[]>({ type: "listScripts" })) || [],
    setEnabled: async (id, enabled) => void (await send({ type: "setEnabled", id, enabled })),
    clearError: async (id) => void (await send({ type: "clearScriptError", scriptId: id })),
    getParams: (scriptId) => send({ type: "getScriptParams", scriptId }),
    setParam: async (scriptId, key, value) => void (await send({ type: "setScriptParam", scriptId, key, value })),
    openManager(scriptId) {
        const url = chrome.runtime.getURL("editor.html") + (scriptId ? `?script=${encodeURIComponent(scriptId)}` : "");
        chrome.tabs.create({ url });
        window.close();
    },
    loadSize: () =>
        new Promise((resolve) =>
            chrome.storage.local.get("resPopupSize", (d) => {
                const s = d?.resPopupSize;
                resolve(s && s.w && s.h ? s : null);
            })
        ),
    saveSize: (size) => void chrome.storage.local.set({ resPopupSize: size }),
    onChange(fn) {
        const l = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && (c.resScripts || c.resScriptOrder || c.resParams)) fn();
        };
        chrome.storage.onChanged.addListener(l);
        return () => chrome.storage.onChanged.removeListener(l);
    },
};
