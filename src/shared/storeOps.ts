/**
 * `wt.globalStore` data helpers shared by the owner (background) and the
 * replicas (every context running the script): applying ops, checking
 * paths and values, merging an `initial` into existing data.
 */
import type { Json, StoreOp, StorePersist } from "./wire";

/** a store's JSON size cap */
export const STORE_MAX_BYTES = 1024 * 1024;

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export const isPlainObject = (v: unknown): v is Record<string, any> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
};

export const cloneJson = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
        return true;
    }
    if (isPlainObject(a)) {
        if (!isPlainObject(b)) return false;
        const ka = Object.keys(a).filter((k) => a[k] !== undefined);
        const kb = Object.keys(b).filter((k) => b[k] !== undefined);
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (!jsonEqual(a[k], b[k])) return false;
        return true;
    }
    return false;
}

/** why a path can't be used, or null */
export function badPath(path: unknown): string | null {
    if (!Array.isArray(path) || !path.length) return "empty path";
    for (const k of path) {
        if (typeof k !== "string" && typeof k !== "number") return "non-string key";
        if (FORBIDDEN.has(String(k))) return `forbidden key "${k}"`;
    }
    return null;
}

/** why a value isn't JSON data (plain objects, arrays, finite numbers, strings, booleans, null), or null */
export function badValue(v: unknown, seen = new Set<object>()): string | null {
    if (v === null || typeof v === "string" || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? null : `${v} isn't JSON`;
    if (typeof v !== "object") return `a ${typeof v} isn't JSON`;
    if (seen.has(v)) return "a cycle isn't JSON";
    seen.add(v);
    try {
        if (Array.isArray(v)) {
            for (const x of v) {
                const bad = x === undefined ? null : badValue(x, seen);
                if (bad) return bad;
            }
            return null;
        }
        if (!isPlainObject(v)) return `a ${v.constructor?.name || "non-plain object"} isn't JSON`;
        for (const k of Object.keys(v)) {
            const x = (v as any)[k];
            if (x === undefined) continue;
            const bad = badValue(x, seen);
            if (bad) return bad;
        }
        return null;
    } finally {
        seen.delete(v);
    }
}

const isContainer = (v: unknown): v is Record<string, any> => Array.isArray(v) || isPlainObject(v);

/**
 * Apply ops to `root` in place. An op whose parent path no longer exists
 * (another context replaced or deleted it) is dropped. Returns the ops
 * that applied.
 */
export function applyOps(root: Json, ops: StoreOp[]): StoreOp[] {
    const applied: StoreOp[] = [];
    for (const op of ops) if (applyOp(root, op)) applied.push(op);
    return applied;
}

function applyOp(root: Json, op: StoreOp): boolean {
    const path = op[1];
    if (badPath(path)) return false;
    let at: any = root;
    for (let i = 0; i < path.length - 1; i++) {
        if (!isContainer(at) || !Object.prototype.hasOwnProperty.call(at, path[i])) return false;
        at = at[path[i]];
    }
    if (!isContainer(at)) return false;
    const key = path[path.length - 1];
    if (op[0] === "del") {
        if (Array.isArray(at) && String(key) === "length") return false;
        delete (at as any)[key];
        return true;
    }
    if (Array.isArray(at) && String(key) === "length") {
        const n = op[2];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > at.length) return false;
        at.length = n;
        return true;
    }
    if (Array.isArray(at)) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i > at.length + 1000) return false;
        // holes left by a sparse write become null, as JSON would have it
        while (at.length < i) at.push(null);
    }
    (at as any)[key] = cloneJson(op[2]);
    return true;
}

/**
 * The ops that add `initial`'s keys missing from `data` (recursing into
 * objects present on both sides; arrays and differing types are left
 * alone).
 */
export function missingOps(data: Json | any, initial: Json | any, path: string[] = []): StoreOp[] {
    if (!isPlainObject(data) || !isPlainObject(initial)) return [];
    const out: StoreOp[] = [];
    for (const k of Object.keys(initial)) {
        if (FORBIDDEN.has(k) || initial[k] === undefined) continue;
        if (!Object.prototype.hasOwnProperty.call(data, k)) out.push(["set", [...path, k], cloneJson(initial[k])]);
        else out.push(...missingOps(data[k], initial[k], [...path, k]));
    }
    return out;
}

/** `data` with `initial`'s missing keys added (a copy) */
export function withMissing(data: Json, initial: Json): Json {
    const out = cloneJson(data);
    applyOps(out, missingOps(out, initial));
    return out;
}

/** the persisted part of a store: all of it, some top-level fields, or nothing */
export function persistedPart(data: Json | any, persist: boolean | string[] | undefined): Json | undefined {
    if (!persist || !isPlainObject(data)) return undefined;
    if (persist === true) return data;
    const out: Record<string, Json> = {};
    for (const k of persist) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    return out;
}

export const jsonBytes = (v: unknown): number => {
    try {
        return JSON.stringify(v)?.length ?? 0;
    } catch {
        return Infinity;
    }
};

/** a store's key among its script's stores: `name`, or `name␀page` for a page's copy of a `wt.pageStore` */
export const storeKey = (name: string, page?: string): string => (page ? `${name}\u0000${page}` : name);

/** `storeKey`'s parts */
export function splitStoreKey(key: string): { name: string; page?: string } {
    const i = key.indexOf("\u0000");
    return i < 0 ? { name: key } : { name: key.slice(0, i), page: key.slice(i + 1) };
}

export const STORE_RENAMED = "wt.store was renamed: use wt.globalStore (one copy shared by every tab) or wt.pageStore (one copy per page)";

/** `wt.globalStore`'s `persist` option, checked */
export function storePersist(name: string, opts: unknown): StorePersist {
    if (opts === undefined || opts === null) return true;
    if (typeof opts !== "object") throw new TypeError(`wt.globalStore("${name}"): the third argument must be an options object`);
    const p = (opts as { persist?: unknown }).persist;
    if (p === undefined) return true;
    if (typeof p === "boolean") return p;
    if (Array.isArray(p) && p.every((k) => typeof k === "string")) return [...p];
    throw new TypeError(`wt.globalStore("${name}"): persist must be true, false or a list of top-level field names`);
}

/** a store's name and initial value, checked; `names` (name → the API that took it) holds each name once per script */
export function claimStoreName(names: Map<string, string>, api: string, name: unknown, initial: unknown): asserts name is string {
    if (typeof name !== "string" || !name) throw new TypeError(`${api}: the first argument must be the store's name (a non-empty string)`);
    const had = names.get(name);
    if (had) throw new Error(`${api}("${name}"): this script already has a store named "${name}" (${had}) — a name may be used once per script (call ${api} at top level and share the result)`);
    if (!initial || typeof initial !== "object" || Array.isArray(initial)) throw new TypeError(`${api}("${name}"): initial must be an object`);
}
