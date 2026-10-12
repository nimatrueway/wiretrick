/**
 * chrome.storage.local backed script store.
 */
import type { ResMeta } from "../../shared/metaParser";
import { parseMeta } from "../../shared/metaParser";

export interface Script {
    id: string;
    code: string;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    meta: ResMeta;
}

const STORE_KEY = "resScripts";
const ORDER_KEY = "resScriptOrder";

const listeners = new Set<() => void>();

export function onScriptsChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(): void {
    listeners.forEach((fn) => fn());
}

export async function listScripts(): Promise<Script[]> {
    const obj = await chrome.storage.local.get([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    return order.filter((id) => byId[id]).map((id) => byId[id]);
}

export async function getScript(id: string): Promise<Script | undefined> {
    const obj = await chrome.storage.local.get(STORE_KEY);
    return (obj[STORE_KEY] || {})[id];
}

export async function saveScript(partial: Pick<Script, "id" | "code"> & Partial<Script>): Promise<Script> {
    const obj = await chrome.storage.local.get([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    const prev = byId[partial.id];
    const meta = parseMeta(partial.code);
    const script: Script = {
        id: partial.id,
        code: partial.code,
        enabled: partial.enabled ?? prev?.enabled ?? true,
        createdAt: prev?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        error: null,
        meta,
    };
    byId[partial.id] = script;
    if (!order.includes(partial.id)) {
        order.push(partial.id);
    }
    await chrome.storage.local.set({ [STORE_KEY]: byId, [ORDER_KEY]: order });
    notify();
    return script;
}

export async function deleteScript(id: string): Promise<void> {
    const obj = await chrome.storage.local.get([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || [];
    delete byId[id];
    await chrome.storage.local.set({
        [STORE_KEY]: byId,
        [ORDER_KEY]: order.filter((x) => x !== id),
    });
    notify();
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
    const script = await getScript(id);
    if (!script) return;
    script.enabled = enabled;
    await saveScript(script);
}

export function newId(): string {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// ---- per-script KV storage ----
const SCRIPT_STORE_PREFIX = "resStore.";

export async function scriptStorageGet(scriptId: string, key: string): Promise<any> {
    const obj = await chrome.storage.local.get(SCRIPT_STORE_PREFIX + scriptId);
    return (obj[SCRIPT_STORE_PREFIX + scriptId] || {})[key];
}

export async function scriptStorageSet(scriptId: string, key: string, value: any): Promise<void> {
    const storeKey = SCRIPT_STORE_PREFIX + scriptId;
    const obj = await chrome.storage.local.get(storeKey);
    const data = obj[storeKey] || {};
    data[key] = value;
    await chrome.storage.local.set({ [storeKey]: data });
}
