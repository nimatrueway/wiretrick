/**
 * `wt.store` replicas: the valtio proxy a script gets in one context, kept
 * in sync with the background owner (src/background/engine/storeOwner.ts)
 * over a wire Endpoint.
 *
 * A replica's view = the last state the owner confirmed (`data` at `rev`)
 * + this context's changes the owner hasn't applied yet (`pending`). Local
 * writes are batched per microtask into one `store.set`; owner patches
 * apply in rev order (a gap re-syncs with `store.sub`); after either the
 * proxy is brought to the view by writing only what differs, so
 * `useSnapshot` re-renders only what changed and there's no echo.
 *
 * Top-level function and accessor fields of `initial` stay local (methods,
 * computed values); everything else must be JSON.
 */
import { proxy, subscribe, unstable_enableOp, unstable_getInternalStates } from "valtio/vanilla";
import type { Endpoint, Json, StoreOp, StorePersist } from "./wire";
import { STORE_MAX_BYTES, applyOps, cloneJson, isPlainObject, jsonBytes, jsonEqual, missingOps, withMissing } from "./storeOps";

// replicas read valtio's mutation ops (off by default)
unstable_enableOp(true);

const { refSet } = unstable_getInternalStates();

interface Replica {
    s: string;
    name: string;
    proxy: Record<string, any>;
    /** the proxy's target: local (function/accessor) fields live there */
    base: Record<string, any>;
    persist: StorePersist;
    /** the owner's confirmed state; rev -1 = not synced yet */
    rev: number;
    data: Json;
    pending: { op: string; ops: StoreOp[] }[];
    batch: StoreOp[];
    bad: string | null;
    flushQueued: boolean;
    /** `initial`'s fields, shown until the owner confirms the latest declare */
    fill: Json | null;
    declareGen: number;
    syncing: boolean;
    syncTok: number;
    unsub: () => void;
}

export interface ReplicaHubOptions {
    /** this context's name, part of the op ids it makes (e.g. "bg", "sandbox") */
    ctx: string;
    log?: (scriptId: string, msg: string, level: "info" | "warn" | "error") => void;
    /** a store's visible state changed (local write or owner patch) */
    onChange?: (scriptId: string, name: string) => void;
}

export type StoreSnapshots = { [scriptId: string]: { [name: string]: { rev: number; data: Json } } };

const keyOf = (s: string, name: string) => `${s}\u0000${name}`;

function isLocalField(obj: object, k: PropertyKey): boolean {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    return !!d && (!("value" in d) || typeof d.value === "function");
}

/** a mutation's value as JSON (reading through nested proxies), or throws why it can't be */
function toJson(v: unknown, seen = new Set<object>()): Json {
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
function splitInitial(name: string, initial: object): { json: Record<string, Json>; local: [string, PropertyDescriptor][] } {
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
            throw new TypeError(`wt.store("${name}"): initial.${k}: ${why} — store values must be JSON (plain objects, arrays, strings, numbers, booleans, null)`);
        }
    }
    return { json, local };
}

/**
 * Bring `target` (a proxy) to `want` by writing only what differs. Local
 * fields are never touched; arrays shrink through `length`.
 */
function writeDiff(target: any, want: Json): void {
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

export class ReplicaHub {
    private ep: Endpoint | null = null;
    private readonly reps = new Map<string, Replica>();
    private readonly primed = new Map<string, { [name: string]: { rev: number; data: Json } }>();
    private readonly id: string;
    private seq = 0;
    private applying = false;

    constructor(private readonly opts: ReplicaHubOptions) {
        this.id = `${opts.ctx}.${Math.random().toString(36).slice(2, 8)}`;
    }

    /** connect (or reconnect, after the owner restarted or the link was replaced) to the owner */
    attach(ep: Endpoint): void {
        this.ep = ep;
        ep.on("store.patch", (a, s) => s !== undefined && this.onPatch(s, a));
        ep.on("store.reject", (a, s) => s !== undefined && this.onReject(s, a));
        this.reconnect();
    }

    /** the owner's current stores, so `wt.store` returns them synchronously when a script compiles */
    prime(snaps: StoreSnapshots): void {
        for (const [s, stores] of Object.entries(snaps)) this.primed.set(s, { ...(this.primed.get(s) ?? {}), ...stores });
    }

    isPrimed(s: string): boolean {
        return this.primed.has(s);
    }

    /** the owner may have lost state (MV3 service worker restart): re-declare, re-sync and re-send */
    reconnect(): void {
        for (const rep of this.reps.values()) {
            this.declare(rep);
            this.resync(rep, true);
        }
    }

    /** drop the replicas of scripts that are gone */
    retain(scriptIds: Iterable<string>): void {
        const keep = new Set(scriptIds);
        for (const [k, rep] of this.reps)
            if (!keep.has(rep.s)) {
                rep.unsub();
                this.reps.delete(k);
            }
        for (const s of [...this.primed.keys()]) if (!keep.has(s)) this.primed.delete(s);
    }

    /** `wt.store(name, initial, opts)` for script `s` */
    store<T extends object>(s: string, name: string, initial: T, persist: StorePersist = true): T {
        if (typeof name !== "string" || !name) throw new TypeError("wt.store: the first argument must be the store's name (a non-empty string)");
        if (!initial || typeof initial !== "object" || Array.isArray(initial)) throw new TypeError(`wt.store("${name}"): initial must be an object`);
        const { json, local } = splitInitial(name, initial);
        const key = keyOf(s, name);
        const old = this.reps.get(key);
        if (old) {
            // the script recompiled: same proxy, its new fields merged in
            old.persist = persist;
            old.fill = json;
            for (const [k, d] of local) Object.defineProperty(old.base, k, d);
            this.declare(old);
            this.render(old);
            this.resync(old, false);
            return old.proxy as T;
        }
        const primed = this.primed.get(s)?.[name];
        const data = primed ? withMissing(primed.data, json) : cloneJson(json);
        const base: Record<string, any> = {};
        for (const [k, d] of local) Object.defineProperty(base, k, d);
        if (isPlainObject(data)) for (const k of Object.keys(data)) if (!(k in base)) base[k] = cloneJson((data as any)[k]);
        const p = proxy(base);
        const rep: Replica = {
            s,
            name,
            proxy: p,
            base,
            persist,
            rev: primed ? primed.rev : -1,
            data,
            pending: [],
            batch: [],
            bad: null,
            flushQueued: false,
            fill: json,
            declareGen: 0,
            syncing: false,
            syncTok: 0,
            unsub: () => {},
        };
        rep.unsub = subscribe(p, (ops) => !this.applying && this.onLocal(rep, ops as any[]), true);
        this.reps.set(key, rep);
        this.declare(rep);
        this.resync(rep, false);
        return p as T;
    }

    // ---- local writes ----

    private onLocal(rep: Replica, ops: any[]): void {
        for (const op of ops) {
            const [kind, path] = op as [string, PropertyKey[]];
            if (!Array.isArray(path) || path.some((k) => typeof k === "symbol")) continue;
            const keys = path as string[];
            if (keys.length === 1 && Object.prototype.hasOwnProperty.call(rep.base, keys[0]) && isLocalField(rep.base, keys[0])) continue;
            if (kind === "delete") {
                if (typeof op[2] === "function" && keys.length === 1) continue;
                rep.batch.push(["del", keys]);
            } else if (kind === "set") {
                const v = op[2];
                if (typeof v === "function" && keys.length === 1) continue;
                if (v === undefined) {
                    rep.batch.push(["del", keys]);
                    continue;
                }
                try {
                    rep.batch.push(["set", keys, toJson(v)]);
                } catch (why) {
                    rep.bad ??= `${keys.join(".")}: ${why}`;
                }
            }
        }
        if (!rep.flushQueued) {
            rep.flushQueued = true;
            queueMicrotask(() => this.flush(rep));
        }
    }

    private flush(rep: Replica): void {
        rep.flushQueued = false;
        const batch = rep.batch;
        const bad = rep.bad;
        rep.batch = [];
        rep.bad = null;
        if (bad) {
            this.opts.log?.(rep.s, `store "${rep.name}": ${bad} — the change was reverted (store values must be JSON)`, "error");
            this.render(rep);
            return;
        }
        if (!batch.length) return;
        const op = `${this.id}:${++this.seq}`;
        rep.pending.push({ op, ops: batch });
        if (jsonBytes(this.view(rep)) > STORE_MAX_BYTES) {
            rep.pending.pop();
            this.opts.log?.(rep.s, `store "${rep.name}": over ${STORE_MAX_BYTES / 1024 / 1024} MB — the change was reverted`, "error");
            this.render(rep);
            return;
        }
        this.ep?.push("store.set", { name: rep.name, op, ops: batch }, rep.s);
        this.opts.onChange?.(rep.s, rep.name);
    }

    // ---- the owner ----

    private declare(rep: Replica): void {
        rep.declareGen++;
        this.ep?.push("store.declare", { name: rep.name, initial: rep.fill ?? {}, persist: rep.persist }, rep.s);
    }

    private resync(rep: Replica, resend: boolean): void {
        const ep = this.ep;
        if (!ep || ep.closed) return;
        const gen = rep.declareGen;
        const tok = ++rep.syncTok;
        rep.syncing = true;
        ep.call("store.sub", { name: rep.name, ...(rep.rev >= 0 ? { rev: rep.rev } : {}) }, rep.s).then(
            (res) => {
                if (tok !== rep.syncTok || this.reps.get(keyOf(rep.s, rep.name)) !== rep) return;
                rep.syncing = false;
                if (res.data !== undefined) rep.data = res.data;
                rep.rev = res.rev;
                const done = new Set(res.ops);
                rep.pending = rep.pending.filter((p) => !done.has(p.op));
                if (gen === rep.declareGen) rep.fill = null;
                if (resend) for (const p of rep.pending) ep.push("store.set", { name: rep.name, op: p.op, ops: p.ops }, rep.s);
                this.render(rep);
            },
            (e) => {
                if (tok !== rep.syncTok) return;
                rep.syncing = false;
                if (e?.name !== "DisconnectedError") this.opts.log?.(rep.s, `store "${rep.name}": sync failed: ${e?.message || e}`, "warn");
            }
        );
    }

    private onPatch(s: string, a: { name: string; rev: number; ops: StoreOp[]; op?: string }): void {
        const rep = this.reps.get(keyOf(s, a.name));
        if (!rep || rep.rev < 0 || rep.syncing || a.rev <= rep.rev) return;
        if (a.rev > rep.rev + 1) return this.resync(rep, true);
        applyOps(rep.data, a.ops);
        rep.rev = a.rev;
        if (a.op) rep.pending = rep.pending.filter((p) => p.op !== a.op);
        this.render(rep);
    }

    private onReject(s: string, a: { name: string; op: string; reason: string }): void {
        const rep = this.reps.get(keyOf(s, a.name));
        if (!rep) return;
        rep.pending = rep.pending.filter((p) => p.op !== a.op);
        this.opts.log?.(rep.s, `store "${a.name}": a change was rejected (${a.reason})`, "error");
        this.render(rep);
    }

    // ---- the view ----

    private view(rep: Replica): Json {
        const v = cloneJson(rep.data);
        for (const p of rep.pending) applyOps(v, p.ops);
        if (rep.batch.length && !rep.bad) applyOps(v, rep.batch);
        if (rep.fill) applyOps(v, missingOps(v, rep.fill));
        return v;
    }

    private render(rep: Replica): void {
        const want = this.view(rep);
        let changed = false;
        const unsub = subscribe(rep.proxy, () => (changed = true), true);
        this.applying = true;
        try {
            writeDiff(rep.proxy, want);
        } finally {
            this.applying = false;
            unsub();
        }
        if (changed) this.opts.onChange?.(rep.s, rep.name);
    }
}
