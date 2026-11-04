/**
 * The `wt.store` owner (background): the one true state of every script's
 * stores. Replicas declare and change stores over wire endpoints
 * (src/shared/storeReplica.ts); the owner validates each change, applies
 * it, bumps the store's rev and patches every replica of the script.
 *
 * Persistence: a store's persisted fields go to the script's storage under
 * `"$store:<name>"` (write-behind); MV3 also keeps the full state in
 * `chrome.storage.session` so a service-worker restart resumes at the
 * same rev.
 */
import type { Endpoint, Json, StoreOp, StorePersist, StoreSnapshot } from "../../shared/wire";
import { STORE_MAX_BYTES, applyOps, badPath, badValue, cloneJson, isPlainObject, jsonBytes, missingOps, persistedPart } from "../../shared/storeOps";

export const STORE_KEY_PREFIX = "$store:";
const SESSION_PREFIX = "wtStores.";
const RING = 256;

export interface StoreOwnerDeps {
    /** the script's storage object (`wt.storage`), where `$store:<name>` keys live */
    storageAll(scriptId: string): Promise<Record<string, any>>;
    storageSet(scriptId: string, key: string, value: unknown): Promise<void>;
    /** chrome.storage.session (MV3); absent: state lives as long as this context */
    sessionGet?(key: string): Promise<any>;
    sessionSet?(key: string, value: unknown): Promise<void>;
    log?(scriptId: string, msg: string, level: "info" | "warn" | "error"): void;
    persistDelayMs?: number;
    sessionDelayMs?: number;
}

interface Entry {
    rev: number;
    data: Json;
    persist: StorePersist | undefined;
    ring: string[];
    /** endpoints subscribed to this store (others get only their own script's L1 broadcast) */
    subs: Set<Endpoint>;
}

interface ScriptState {
    stores: Map<string, Entry>;
    chain: Promise<unknown>;
    loaded: Promise<void> | null;
}

export class StoreOwner {
    private readonly scripts = new Map<string, ScriptState>();
    /** endpoints that get every patch (the contexts running all scripts) */
    private readonly broadcast = new Set<Endpoint>();
    private readonly changeFns: ((s: string, name: string) => void)[] = [];
    private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly deps: StoreOwnerDeps) {}

    /**
     * Serve store ops on `ep`. `all`: the endpoint hosts every script (a
     * compile context) and gets every patch; otherwise it gets patches for
     * the stores it subscribed to.
     */
    attach(ep: Endpoint, opts: { all: boolean }): void {
        if (opts.all) this.broadcast.add(ep);
        ep.onClose(() => {
            this.broadcast.delete(ep);
            for (const st of this.scripts.values()) for (const e of st.stores.values()) e.subs.delete(ep);
        });
        ep.on("store.declare", (a, s) => s && void this.run(s, () => this.declare(s, a.name, a.initial, a.persist)));
        ep.on("store.set", (a, s) => s && void this.run(s, () => this.set(ep, s, a.name, a.op, a.ops)));
        ep.handle("store.sub", (a, s) => {
            if (!s) throw new Error("store.sub: no script");
            return this.run(s, () => this.sub(ep, s, a.name, a.rev));
        });
        ep.handle("store.init", (a) => this.init(a.scripts));
    }

    /** a store changed (any context's write, or a declare's merge) */
    onChange(fn: (scriptId: string, name: string) => void): () => void {
        this.changeFns.push(fn);
        return () => {
            const i = this.changeFns.indexOf(fn);
            if (i >= 0) this.changeFns.splice(i, 1);
        };
    }

    /** the current stores of some scripts */
    async init(scriptIds: string[]): Promise<{ [s: string]: { [name: string]: StoreSnapshot } }> {
        const out: { [s: string]: { [name: string]: StoreSnapshot } } = {};
        await Promise.all(
            scriptIds.map(async (s) => {
                out[s] = await this.run(s, () => {
                    const snaps: { [name: string]: StoreSnapshot } = {};
                    for (const [name, e] of this.state(s).stores) snaps[name] = { rev: e.rev, data: cloneJson(e.data) };
                    return snaps;
                });
            })
        );
        return out;
    }

    /** a store's current state (tests, rules) */
    get(scriptId: string, name: string): StoreSnapshot | undefined {
        const e = this.scripts.get(scriptId)?.stores.get(name);
        return e && { rev: e.rev, data: cloneJson(e.data) };
    }

    /** the script was deleted: forget its stores */
    forget(scriptId: string): void {
        this.scripts.delete(scriptId);
    }

    /** forget every script not in `scriptIds` (the stored scripts) */
    retain(scriptIds: Iterable<string>): void {
        const keep = new Set(scriptIds);
        for (const s of [...this.scripts.keys()]) if (!keep.has(s)) this.scripts.delete(s);
    }

    /** write pending persistence now */
    async flush(): Promise<void> {
        await Promise.all([...this.scripts.values()].map((st) => st.chain.catch(() => {})));
        const persists = [...this.persistTimers.keys()];
        const sessions = [...this.sessionTimers.keys()];
        for (const t of this.persistTimers.values()) clearTimeout(t);
        for (const t of this.sessionTimers.values()) clearTimeout(t);
        this.persistTimers.clear();
        this.sessionTimers.clear();
        await Promise.all([...persists.map((k) => this.writePersist(k)), ...sessions.map((s) => this.writeSession(s))]);
    }

    // ---- ops (serialized per script) ----

    private state(s: string): ScriptState {
        let st = this.scripts.get(s);
        if (!st) {
            st = { stores: new Map(), chain: Promise.resolve(), loaded: null };
            this.scripts.set(s, st);
        }
        return st;
    }

    private run<T>(s: string, fn: () => T | Promise<T>): Promise<T> {
        const st = this.state(s);
        st.loaded ??= this.load(s, st);
        const next = st.chain.then(() => st.loaded).then(fn);
        st.chain = next.catch(() => {});
        return next;
    }

    /** rehydrate: the session copy (same revs), else the persisted fields at rev 0 */
    private async load(s: string, st: ScriptState): Promise<void> {
        try {
            const sess = await this.deps.sessionGet?.(SESSION_PREFIX + s);
            if (sess && typeof sess === "object") {
                for (const [name, v] of Object.entries<any>(sess))
                    if (v && typeof v.rev === "number" && !st.stores.has(name)) st.stores.set(name, { rev: v.rev, data: v.data ?? {}, persist: v.persist, ring: [], subs: new Set() });
                return;
            }
            const all = (await this.deps.storageAll(s)) ?? {};
            for (const [k, v] of Object.entries(all))
                if (k.startsWith(STORE_KEY_PREFIX) && isPlainObject(v) && !st.stores.has(k.slice(STORE_KEY_PREFIX.length)))
                    st.stores.set(k.slice(STORE_KEY_PREFIX.length), { rev: 0, data: v, persist: undefined, ring: [], subs: new Set() });
        } catch (e: any) {
            this.deps.log?.(s, `stores: couldn't load the saved state: ${e?.message || e}`, "warn");
        }
    }

    private entry(s: string, name: string): Entry {
        const st = this.state(s);
        let e = st.stores.get(name);
        if (!e) {
            e = { rev: 0, data: {}, persist: undefined, ring: [], subs: new Set() };
            st.stores.set(name, e);
        }
        return e;
    }

    private declare(s: string, name: string, initial: Json, persist: StorePersist): void {
        if (typeof name !== "string" || !name) return;
        const e = this.entry(s, name);
        const persistChanged = JSON.stringify(e.persist) !== JSON.stringify(persist);
        e.persist = persist;
        if (badValue(initial) || !isPlainObject(e.data)) return;
        const ops = missingOps(e.data, initial);
        if (ops.length) {
            applyOps(e.data, ops);
            this.commit(s, name, e, ops);
        } else if (persistChanged) this.schedulePersist(s, name);
    }

    private set(from: Endpoint, s: string, name: string, op: string, ops: StoreOp[]): void {
        const e = this.entry(s, name);
        if (typeof op !== "string" || e.ring.includes(op)) return;
        const reject = (reason: string) => from.push("store.reject", { name, op, reason }, s);
        if (!Array.isArray(ops)) return reject("malformed ops");
        for (const o of ops) {
            if (!Array.isArray(o) || (o[0] !== "set" && o[0] !== "del")) return reject("malformed op");
            const bad = badPath(o[1]) || (o[0] === "set" ? badValue(o[2]) : null);
            if (bad) return reject(bad);
        }
        const next = cloneJson(e.data);
        const applied = applyOps(next, ops);
        if (jsonBytes(next) > STORE_MAX_BYTES) return reject(`over ${STORE_MAX_BYTES / 1024 / 1024} MB`);
        e.data = next;
        e.ring.push(op);
        if (e.ring.length > RING) e.ring.splice(0, e.ring.length - RING);
        this.commit(s, name, e, applied, op);
    }

    private sub(ep: Endpoint, s: string, name: string, rev: number | undefined): { rev: number; data?: Json; ops: string[] } {
        const e = this.entry(s, name);
        if (!this.broadcast.has(ep)) e.subs.add(ep);
        return rev === e.rev ? { rev: e.rev, ops: [...e.ring] } : { rev: e.rev, data: cloneJson(e.data), ops: [...e.ring] };
    }

    private commit(s: string, name: string, e: Entry, ops: StoreOp[], op?: string): void {
        e.rev++;
        const patch = { name, rev: e.rev, ops, ...(op ? { op } : {}) };
        for (const ep of this.broadcast) ep.push("store.patch", patch, s);
        for (const ep of e.subs) if (!ep.closed) ep.push("store.patch", patch, s);
        this.schedulePersist(s, name);
        this.scheduleSession(s);
        for (const fn of this.changeFns) {
            try {
                fn(s, name);
            } catch {}
        }
    }

    // ---- persistence ----

    private schedulePersist(s: string, name: string): void {
        const k = `${s}\u0000${name}`;
        if (this.persistTimers.has(k)) return;
        this.persistTimers.set(
            k,
            setTimeout(() => {
                this.persistTimers.delete(k);
                void this.writePersist(k);
            }, this.deps.persistDelayMs ?? 500)
        );
    }

    private async writePersist(k: string): Promise<void> {
        const [s, name] = k.split("\u0000");
        const e = this.scripts.get(s)?.stores.get(name);
        if (!e || e.persist === undefined) return;
        try {
            await this.deps.storageSet(s, STORE_KEY_PREFIX + name, persistedPart(e.data, e.persist));
        } catch (err: any) {
            this.deps.log?.(s, `store "${name}": couldn't save: ${err?.message || err}`, "warn");
        }
    }

    private scheduleSession(s: string): void {
        if (!this.deps.sessionSet || this.sessionTimers.has(s)) return;
        this.sessionTimers.set(
            s,
            setTimeout(() => {
                this.sessionTimers.delete(s);
                void this.writeSession(s);
            }, this.deps.sessionDelayMs ?? 50)
        );
    }

    private async writeSession(s: string): Promise<void> {
        const st = this.scripts.get(s);
        if (!st || !this.deps.sessionSet) return;
        const out: Record<string, { rev: number; persist: StorePersist | undefined; data: Json }> = {};
        for (const [name, e] of st.stores) out[name] = { rev: e.rev, persist: e.persist, data: e.data };
        try {
            await this.deps.sessionSet(SESSION_PREFIX + s, out);
        } catch {}
    }
}
