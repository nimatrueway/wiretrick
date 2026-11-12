/**
 * What every store proxy shares (storeReplica.ts, siteStoreHost.ts,
 * siteStoreMirror.ts): reading a valtio proxy as JSON, splitting `initial`
 * into data and local (function/accessor) fields, and bringing a proxy to
 * a wanted state by writing only what differs.
 */
import { unstable_enableOp, unstable_getInternalStates } from "valtio/vanilla";
import type { Json } from "./wire";
import { cloneJson, isPlainObject, jsonEqual } from "./storeOps";

// stores read valtio's mutation ops (off by default)
unstable_enableOp(true);

const { refSet } = unstable_getInternalStates();

export interface Template {
    json: Record<string, Json>;
    local: [string, PropertyDescriptor][];
}

export function isLocalField(obj: object, k: PropertyKey): boolean {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    return !!d && (!("value" in d) || typeof d.value === "function");
}

/** a mutation's value as JSON (reading through nested proxies), or throws why it can't be */
export function toJson(v: unknown, seen = new Set<object>()): Json {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
        if (!Number.isFinite(v)) throw `${v} isn't JSON`;
        return v;
    }
    if (typeof v === "function") throw "a function can only be a top-level field (it stays local)";
    if (typeof v !== "object") throw `a ${typeof v} isn't JSON`;
    if (refSet.has(v)) throw "a ref() value isn't JSON";
    if (seen.has(v)) throw "a cycle isn't JSON";
    seen.add(v);
    try {
        if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toJson(x, seen)));
        if (!isPlainObject(v)) throw `a ${(v as any).constructor?.name || "non-plain object"} isn't JSON`;
        const out: Record<string, Json> = {};
        for (const k of Object.keys(v)) {
            const x = (v as any)[k];
            if (x !== undefined) out[k] = toJson(x, seen);
        }
        return out;
    } finally {
        seen.delete(v);
    }
}

/** `initial` → its JSON data fields + its local (function/accessor) field descriptors */
export function splitInitial(name: string, initial: object, api = "tt.globalStore"): Template {
    const json: Record<string, Json> = {};
    const local: [string, PropertyDescriptor][] = [];
    for (const k of Object.keys(initial)) {
        const d = Object.getOwnPropertyDescriptor(initial, k)!;
        if (!("value" in d) || typeof d.value === "function") {
            local.push([k, d]);
            continue;
        }
        if (d.value === undefined) continue;
        try {
            json[k] = toJson(d.value);
        } catch (why) {
            throw new TypeError(`${api}("${name}"): initial.${k}: ${why} — store values must be JSON (plain objects, arrays, strings, numbers, booleans, null)`);
        }
    }
    return { json, local };
}

/**
 * Bring `target` (a proxy) to `want` by writing only what differs. Local
 * fields are never touched; arrays shrink through `length`.
 */
export function writeDiff(target: any, want: Json): void {
    if (Array.isArray(target) && Array.isArray(want)) {
        for (let i = 0; i < want.length; i++) writeKey(target, String(i), want[i]);
        if (target.length > want.length) target.length = want.length;
        return;
    }
    if (!isPlainObject(want)) return;
    for (const k of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(want, k) && !isLocalField(target, k)) delete target[k];
    for (const k of Object.keys(want)) writeKey(target, k, (want as any)[k]);
}

function writeKey(target: any, k: string, want: Json): void {
    if (isLocalField(target, k)) return;
    const cur = target[k];
    const sameKind = (Array.isArray(cur) && Array.isArray(want)) || (isPlainObject(cur) && isPlainObject(want) && !refSet.has(cur));
    if (sameKind) writeDiff(cur, want);
    else if (!(Object.prototype.hasOwnProperty.call(target, k) && jsonEqual(cur, want))) target[k] = cloneJson(want);
}

