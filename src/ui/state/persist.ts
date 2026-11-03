import { proxy, subscribe } from "valtio";

function load(key: string): Record<string, unknown> {
    try {
        const v = JSON.parse(localStorage.getItem(key) || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A store saved to localStorage under `key` as it changes. Only the keys this
 * page changed are written over what is stored (one level deep for objects),
 * so another Editor tab's changes to other keys survive.
 */
export function persistedProxy<T extends object>(key: string): T {
    const store = proxy(load(key) as T);
    const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(store));
    let last = copy();
    subscribe(
        store,
        () => {
            const now = copy();
            const stored = load(key);
            for (const k of new Set([...Object.keys(now), ...Object.keys(last)])) {
                if (JSON.stringify(now[k]) === JSON.stringify(last[k])) continue;
                stored[k] = isPlain(now[k]) && isPlain(stored[k]) ? { ...stored[k], ...now[k] } : now[k];
            }
            last = now;
            try {
                localStorage.setItem(key, JSON.stringify(stored));
            } catch {}
        },
        true
    );
    return store;
}
