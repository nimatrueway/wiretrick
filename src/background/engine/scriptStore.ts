/**
 * chrome.storage.local backed script store.
 */
import type { ResMeta } from "../../shared/metaParser";
import { compileScript, makeStubModule } from "../../shared/compile";

export interface Script {
    id: string;
    code: string;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    meta: ResMeta;
    /** param definitions from res.declareScript (captured at save time) */
    paramDefs?: Record<string, import("../../shared/scriptDef").ParamDef>;
}

const STORE_KEY = "resScripts";
const ORDER_KEY = "resScriptOrder";

// MV2 browsers don't support promise-based chrome.storage — wrap callbacks.
function storageGet(keys: string | string[] | null): Promise<Record<string, any>> {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys as any, (d) => {
            void chrome.runtime.lastError; // treat as empty
            resolve(d || {});
        });
    });
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set(items, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

const listeners = new Set<() => void>();

export function onScriptsChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(): void {
    listeners.forEach((fn) => fn());
}

export async function listScripts(): Promise<Script[]> {
    const obj = await storageGet([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    return order.filter((id) => byId[id]).map((id) => byId[id]);
}

export async function getScript(id: string): Promise<Script | undefined> {
    const obj = await storageGet(STORE_KEY);
    return (obj[STORE_KEY] || {})[id];
}

export async function saveScript(partial: Pick<Script, "id" | "code"> & Partial<Script> & { name?: string }): Promise<Script> {
    const obj = await storageGet([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || Object.keys(byId);
    const prev = byId[partial.id];
    // compile (not just parse) so res.declareScript values land in meta;
    // imports resolve to stubs here — declaration capture must not depend
    // on other scripts loading cleanly
    const compiled = compileScript(partial.code, { importModule: () => makeStubModule() });
    // the script's name is the manager/file name — declareScript has no
    // name field; keep the previous name when the caller didn't pass one
    // (e.g. setEnabled re-saves the stored script)
    const name = partial.name ?? prev?.meta.name;
    if (name) compiled.meta.name = name;
    const script: Script = {
        id: partial.id,
        code: partial.code,
        enabled: partial.enabled ?? prev?.enabled ?? true,
        createdAt: prev?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        error: null,
        meta: compiled.meta,
        paramDefs: compiled.paramDefs ?? prev?.paramDefs,
    };
    byId[partial.id] = script;
    if (!order.includes(partial.id)) {
        order.push(partial.id);
    }
    await storageSet({ [STORE_KEY]: byId, [ORDER_KEY]: order });
    notify();
    return script;
}

export async function deleteScript(id: string): Promise<void> {
    const obj = await storageGet([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || [];
    delete byId[id];
    await storageSet({
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
    const obj = await storageGet(SCRIPT_STORE_PREFIX + scriptId);
    return (obj[SCRIPT_STORE_PREFIX + scriptId] || {})[key];
}

export async function scriptStorageSet(scriptId: string, key: string, value: any): Promise<void> {
    const storeKey = SCRIPT_STORE_PREFIX + scriptId;
    const obj = await storageGet(storeKey);
    const data = obj[storeKey] || {};
    data[key] = value;
    await storageSet({ [storeKey]: data });
}

// ---- per-script parameter values (res.declareScript params) ----
const PARAMS_KEY = "resParams";

/** Load all stored param values: { scriptId: { key: value } }. */
export async function loadAllParamValues(): Promise<{ [scriptId: string]: Record<string, any> }> {
    const obj = await storageGet(PARAMS_KEY);
    return obj[PARAMS_KEY] || {};
}

export async function getParamValues(scriptId: string): Promise<Record<string, any>> {
    return (await loadAllParamValues())[scriptId] || {};
}

export async function setParamValue(scriptId: string, key: string, value: any): Promise<void> {
    const all = await loadAllParamValues();
    all[scriptId] = { ...(all[scriptId] || {}), [key]: value };
    await storageSet({ [PARAMS_KEY]: all });
    notify();
}
