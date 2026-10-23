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
    /** param definitions from wt.params / wt.defineParam (captured at save time) */
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

type RenameListener = (oldName: string, newName: string) => void | Promise<void>;
const renameListeners = new Set<RenameListener>();

/** a script's name changed — awaited before the change is announced */
export function onScriptRenamed(fn: RenameListener): () => void {
    renameListeners.add(fn);
    return () => renameListeners.delete(fn);
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
    // the script's name is the manager/file name — keep the previous name when the caller didn't pass one
    // (e.g. setEnabled re-saves the stored script). Resolved BEFORE
    // compiling so sandbox analyze logs identify the script.
    const name = partial.name ?? prev?.meta.name;
    // compile (not just parse) so handler routes and params land in meta;
    // imports resolve against the other stored scripts (a param definition
    // imported from a utility is captured with its real type) and to stubs
    // where they don't resolve — capture must not depend on other scripts
    // loading cleanly (routes built from imports are refined by the
    // reload-time analyze). MV3: compiles in the sandbox page (the SW
    // cannot eval) — see compileHost.
    const allValues = await loadAllParamValues();
    const compiled = await compileForStorage(partial.code, name, allValues[partial.id], { id: partial.id, scripts: plain(byId), paramValues: allValues });
    // MV3 sandbox RPC failure (host unavailable): keep the previous
    // meta/paramDefs rather than corrupting an active script into a
    // utility — the next save recomputes. (The sentinel error string comes
    // from compileHost — matched exactly: user compile errors carry stacks
    // that mention sandbox.js.)
    const rpcFailed = compiled.error === SANDBOX_COMPILE_FAILED;
    if (rpcFailed) dlogLevel("compile", "warn", `saveScript "${name ?? prev?.meta.name}": sandbox compile failed — keeping previous meta/paramDefs`);
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
    // new code/name → the scripts importing it see different exports (or,
    // for a library saved after its importers, see it at all)
    if (!prev || prev.code !== script.code || prev.meta.name !== script.meta.name) {
        const importers = dependantsOf(script.meta.name, plain(byId)).filter((id) => id !== script.id);
        if (prev && prev.meta.name !== script.meta.name) importers.push(...dependantsOf(prev.meta.name, plain(byId)).filter((id) => id !== script.id && !importers.includes(id)));
        await recompileMeta(byId, importers, allValues);
    }
    await storageSet({ [STORE_KEY]: byId, [ORDER_KEY]: order });
    if (prev && prev.meta.name !== script.meta.name) {
        for (const fn of renameListeners) await fn(prev.meta.name, script.meta.name);
    }
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

function plain(byId: { [id: string]: Script }): { id: string; name: string; code: string }[] {
    return Object.values(byId).map((x) => ({ id: x.id, name: x.meta.name, code: x.code }));
}

/**
 * Re-derive stored meta/paramDefs/error of `ids` in place (their code is
 * unchanged, but what they import or their param values changed — e.g. a
 * utility whose handlers register only for some param value becomes a
 * script). Returns the ids that changed. updatedAt is left alone: the
 * code didn't change.
 */
async function recompileMeta(byId: { [id: string]: Script }, ids: string[], allValues: { [scriptId: string]: Record<string, any> }): Promise<string[]> {
    const changed: string[] = [];
    for (const id of ids) {
        const s = byId[id];
        if (!s) continue;
        const c = await compileForStorage(s.code, s.meta.name, allValues[id], { id, scripts: plain(byId), paramValues: allValues });
        if (c.error === SANDBOX_COMPILE_FAILED) continue; // keep what we have
        const meta = { ...c.meta, name: s.meta.name };
        const paramDefs = c.paramDefs ?? s.paramDefs;
        if (JSON.stringify([meta, paramDefs, c.error]) === JSON.stringify([s.meta, s.paramDefs, s.error])) continue;
        byId[id] = { ...s, meta, paramDefs, error: c.error };
        changed.push(id);
    }
    return changed;
}

/**
 * Meta stored before routes recorded their registration line (Problems
 * view positions): recompile it once, at startup.
 */
export async function refreshStaleMeta(): Promise<void> {
    const byId: { [id: string]: Script } = (await storageGet(STORE_KEY))[STORE_KEY] || {};
    const stale = Object.values(byId).filter((s) => s.meta.routes?.some((r) => r.line === undefined)).map((s) => s.id);
    if (!stale.length) return;
    const changed = await recompileMeta(byId, stale, await loadAllParamValues());
    if (!changed.length) return;
    // re-read: a save may have landed while compiling (MV3: sandbox RPC)
    const fresh: { [id: string]: Script } = (await storageGet(STORE_KEY))[STORE_KEY] || {};
    for (const id of changed) if (fresh[id]?.code === byId[id].code) fresh[id] = { ...fresh[id], meta: byId[id].meta, paramDefs: byId[id].paramDefs, error: byId[id].error };
    await storageSet({ [STORE_KEY]: fresh });
    notify();
}

export async function deleteScript(id: string): Promise<void> {
    void clearScriptErrors(id);
    void clearScriptTypeErrors(id);
    const obj = await storageGet([STORE_KEY, ORDER_KEY]);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const order: string[] = obj[ORDER_KEY] || [];
    const gone = byId[id];
    const importers = gone ? dependantsOf(gone.meta.name, plain(byId)).filter((x) => x !== id) : [];
    delete byId[id];
    // its importers' imports now resolve to stubs: drop what came from it (e.g. imported param defs)
    if (importers.length) await recompileMeta(byId, importers, await loadAllParamValues());
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

// ---- per-script parameter values (wt.params / wt.defineParam) ----
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
    // handlers/params may depend on param values (a utility that registers
    // handlers only when a param is on turns into a script): refresh the
    // stored meta of the script and its importers
    const obj = await storageGet(STORE_KEY);
    const byId: { [id: string]: Script } = obj[STORE_KEY] || {};
    const s = byId[scriptId];
    const changed = s ? await recompileMeta(byId, [scriptId, ...dependantsOf(s.meta.name, plain(byId)).filter((id) => id !== scriptId)], all) : [];
    if (changed.length) {
        // re-read: a save may have landed while compiling (MV3: sandbox RPC)
        const fresh: { [id: string]: Script } = (await storageGet(STORE_KEY))[STORE_KEY] || {};
        for (const id of changed) {
            const u = byId[id];
            if (fresh[id]?.code !== u.code) continue;
            // a value the script can't load with (e.g. its `parse` throws) is
            // a compile error: stored below, shown in the Problems view
            fresh[id] = { ...fresh[id], meta: u.meta, paramDefs: u.paramDefs, error: u.error };
        }
        await storageSet({ [STORE_KEY]: fresh });
    }
    notify();
}
