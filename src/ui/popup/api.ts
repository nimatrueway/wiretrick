import { send, sendWake } from "../lib/messaging";
import type { ParamDef } from "../components/ParamField";

export interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    meta: { name: string; declared?: boolean };
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
    getParams(scriptId: string): Promise<ScriptParams>;
    setParam(scriptId: string, key: string, value: any): Promise<void>;
    openManager(scriptId?: string): void;
    loadSize(): Promise<{ w: number; h: number } | null>;
    saveSize(size: { w: number; h: number }): void;
}

export const chromePopupApi: PopupApi = {
    // sendWake: the first message may race the SW's wake-up (MV3)
    listScripts: async () => (await sendWake<ScriptInfo[]>({ type: "listScripts" })) || [],
    setEnabled: async (id, enabled) => void (await send({ type: "setEnabled", id, enabled })),
    getParams: (scriptId) => send({ type: "getScriptParams", scriptId }),
    setParam: async (scriptId, key, value) => void (await send({ type: "setScriptParam", scriptId, key, value })),
    openManager(scriptId) {
        const url = chrome.runtime.getURL("manager.html") + (scriptId ? `?script=${encodeURIComponent(scriptId)}` : "");
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
};
