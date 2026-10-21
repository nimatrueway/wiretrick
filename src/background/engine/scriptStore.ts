/**
 * chrome.storage.local backed script store.
 */
import { dependantsOf } from "../../shared/scriptImports";
import type { ResMeta } from "../../shared/metaParser";
import { compileForStorage, SANDBOX_COMPILE_FAILED } from "../compileHost";
import { dlogLevel } from "../../shared/debugLog";
import { clearScriptErrors, clearScriptTypeErrors } from "./logs";

export interface Script {
    id: string;
    code: string;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    meta: ResMeta;
    /** param definitions from wt.declareScript (captured at save time) */
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
    // the script's name is the manager/file name — declareScript has no
    // name field; keep the previous name when the caller didn't pass one
    // (e.g. setEnabled re-saves the stored script). Resolved BEFORE
    // compiling so sandbox analyze logs identify the script.
    const name = partial.name ?? prev?.meta.name;
    // compile (not just parse) so wt.declareScript values land in meta;
    // imports resolve to stubs here — declaration capture must not depend
    // on other scripts loading cleanly. MV3: compiles in the sandbox page
    // (the SW cannot eval) — see compileHost.
    const compiled = await compileForStorage(partial.code, name);
    // MV3 sandbox RPC failure (host unavailable): keep the previous
    // meta/paramDefs rather than corrupting a declared script into a
    // library — the next save recomputes. (The sentinel error string comes
    // from compileHost — matched exactly: user compile errors carry stacks
    // that mention sandbox.js.)
    const rpcFailed = compiled.error === SANDBOX_COMPILE_FAILED;
    if (rpcFailed) dlogLevel("compile", "warn", `saveScript "${name ?? prev?.meta.name}": sandbox compile failed — keeping previous meta/paramDefs (declaration state preserved)`);
    const meta = rpcFailed ? prev?.meta ?? compiled.meta : compiled.meta;
    if (name) meta.name = name;
    const script: Script = {
        id: partial.id,
        code: partial.code,
        enabled: partial.enabled ?? prev?.enabled ?? true,
        createdAt: prev?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        error: rpcFailed ? prev?.error ?? null : compiled.error,
        meta,
        paramDefs: rpcFailed ? prev?.paramDefs ?? compiled.paramDefs : compiled.paramDefs ?? prev?.paramDefs,
    };
    byId[partial.id] = script;
    if (!order.includes(partial.id)) {
        order.push(partial.id);
    }
    await storageSet({ [STORE_KEY]: byId, [ORDER_KEY]: order });
    // new code → stale runtime errors no longer apply
    if (prev && prev.code !== script.code) {
        void clearScriptErrors(script.id);
        // …for the scripts importing it too: they run the new code from now on
        const all = Object.values(byId).map((x) => ({ id: x.id, name: x.meta.name, code: x.code }));
        for (const id of dependantsOf(script.meta.name, all)) if (id !== script.id) void clearScriptErrors(id);
    }
    notify();
    return script;
}

export async function deleteScript(id: string): Promise<void> {
    void clearScriptErrors(id);
    void clearScriptTypeErrors(id);
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

// ---- per-script parameter values (wt.declareScript params) ----
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
