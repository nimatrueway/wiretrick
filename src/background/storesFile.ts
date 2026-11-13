/**
 * stores.json ⇄ StoreOwner. Renders persisted `tt.globalStore` data as a
 * single root JSON document (keyed by script name → store name → JSON object),
 * and applies full-file edits (Editor ⌘S or synced folder) or partial imports
 * live to StoreOwner so open tabs and overlays update immediately.
 */
import { parseExportedStores, STORES_FILE } from "../shared/exportZip";
import { scriptFileName, scriptPathKey } from "../shared/scriptName";
import { listScripts } from "./engine/scriptStore";
import { exportPersistedStores, storeOwner } from "./engine/stores";

export { STORES_FILE };

export const STORES_SCHEMA = {
    type: "object",
    description: "Persisted tt.globalStore data for your scripts, keyed by script name → store name → JSON object.",
    additionalProperties: {
        type: "object",
        description: "Persisted globalStore entries belonging to this script.",
        additionalProperties: {
            type: "object",
            description: "Persisted store state (a plain JSON object).",
        },
    },
};

export async function getStoresText(): Promise<string> {
    const data = await exportPersistedStores();
    return JSON.stringify(data, null, 2) + "\n";
}

export function storesTextParses(text: string): boolean {
    try {
        parseExportedStores(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Apply parsed `stores.json` data to `StoreOwner`.
 * When `syncDeletes` is true (full-file save in the Editor or on disk), any
 * existing persisted `globalStore` omitted from `doc` is cleared/reset.
 */
export async function applyStoresDoc(
    doc: Record<string, Record<string, Record<string, any>>>,
    opts: { syncDeletes?: boolean } = {}
): Promise<void> {
    const scripts = await listScripts();
    const byKey = new Map(scripts.map((s) => [scriptPathKey(s.meta.name), s]));
    const kept = new Map<string, Set<string>>();

    for (const [scriptName, stores] of Object.entries(doc || {})) {
        const script = byKey.get(scriptPathKey(scriptName));
        if (!script || !stores || typeof stores !== "object") continue;
        let set = kept.get(script.id);
        if (!set) {
            set = new Set();
            kept.set(script.id, set);
        }
        for (const [storeName, data] of Object.entries(stores)) {
            set.add(storeName);
            await storeOwner.replace(script.id, storeName, data);
        }
    }

    if (opts.syncDeletes) {
        const current = await storeOwner.exportPersisted(scripts.map((s) => ({ id: s.id, name: scriptFileName(s.meta.name) })));
        for (const [scriptName, stores] of Object.entries(current)) {
            const script = byKey.get(scriptPathKey(scriptName));
            if (!script) continue;
            const keepSet = kept.get(script.id);
            for (const storeName of Object.keys(stores)) {
                if (!keepSet?.has(storeName)) {
                    await storeOwner.deleteStore(script.id, storeName);
                }
            }
        }
    }
}

/** Apply full `stores.json` text (Editor save or folder sync). Syntax/shape errors leave state untouched. */
export async function applyStoresText(text: string): Promise<{ error?: string }> {
    let doc: Record<string, Record<string, Record<string, any>>>;
    try {
        doc = parseExportedStores(text);
    } catch (e: any) {
        return { error: String(e?.message || e).split("\n")[0] };
    }
    try {
        await applyStoresDoc(doc, { syncDeletes: true });
        return {};
    } catch (e: any) {
        return { error: String(e?.message || e).split("\n")[0] };
    }
}
