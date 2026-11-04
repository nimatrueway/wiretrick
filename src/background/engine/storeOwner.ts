/**
 * The `wt.globalStore` owner (background): the one true state of every script's
 * stores. Replicas declare and change stores over wire endpoints
 * (src/shared/storeReplica.ts); the owner validates each change, applies
 * it, bumps the store's rev and patches every replica of the script.
 *
 * Persistence: a store's persisted fields go to the script's storage under
 * `"$store:<name>"` (write-behind); MV3 also keeps the full state in
 * `chrome.storage.session` so a service-worker restart resumes at the
 * same rev.
 *
 * `wt.pageStore`: a declare with `scope: "page"` sets the template; each
 * page's copy is made from it when a context first uses it on that page
 * (rev 0) and dropped when the page ends (`dropPage`). Copies are keyed
 * `storeKey(name, page)` and never persisted (MV3: session only).
 */
import type { Endpoint, Json, StoreOp, StorePersist, StoreSnapshot } from "../../shared/wire";
import { STORE_MAX_BYTES, applyOps, badPath, badValue, cloneJson, isPlainObject, jsonBytes, missingOps, persistedPart, splitStoreKey, storeKey } from "../../shared/storeOps";

export const STORE_KEY_PREFIX = "$store:";
const SESSION_PREFIX = "wtStores.";
const RING = 256;
const page = (p: unknown): string | undefined => (typeof p === "string" && p ? p : undefined);

export interface StoreOwnerDeps {
    /** the script's storage object (`wt.storage`), where `$store:<name>` keys live */
    storageAll(scriptId: string): Promise<Record<string, any>>;
    storageSet(scriptId: string, key: string, value: unknown): Promise<void>;
    /** chrome.storage.session (MV3); absent: state lives as long as this context */
    sessionGet?(key: string): Promise<any>;
    sessionSet?(key: string, value: unknown): Promise<void>;
    log?(scriptId: string, msg: string, level: "info" | "warn" | "error"): void;
    /** a page still shows (src/background/engine/pages.ts); absent: every page does */
    pageAlive?(page: string): boolean;
    /** awaited before the first op (the pages restored) */
    ready?(): Promise<unknown>;
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
    /** by `storeKey(name, page)` */
    stores: Map<string, Entry>;
    /** `wt.pageStore` names → the initial state of each page's copy */
    templates: Map<string, Json>;
    chain: Promise<unknown>;
    loaded: Promise<void> | null;
}

export class StoreOwner {
    private readonly scripts = new Map<string, ScriptState>();
    /** endpoints that get every patch (the contexts running all scripts) */
    private readonly broadcast = new Set<Endpoint>();
    private readonly changeFns: ((s: string, name: string, page?: string) => void)[] = [];
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
        ep.on("store.declare", (a, s) => s && void this.run(s, () => (a.scope === "page" ? this.declarePage(s, a.name, a.initial) : this.declare(s, a.name, a.initial, a.persist))));
        ep.on("store.set", (a, s) => s && void this.run(s, () => this.set(ep, s, a.name, a.op, a.ops, page(a.page))));
        ep.handle("store.sub", (a, s) => {
            if (!s) throw new Error("store.sub: no script");
            return this.run(s, () => this.sub(ep, s, a.name, a.rev, page(a.page)));
        });
        ep.handle("store.init", (a) => this.init(a.scripts));
    }

    /** a store changed (any context's write, or a declare's merge); `page`: a page's copy changed or was dropped */
    onChange(fn: (scriptId: string, name: string, page?: string) => void): () => void {
        this.changeFns.push(fn);
        return () => {
            const i = this.changeFns.indexOf(fn);
            if (i >= 0) this.changeFns.splice(i, 1);
        };
    }

    /** the current stores of some scripts; `only.page`: of the page copies, just that page's (null: none) */
    async init(scriptIds: string[], only?: { page: string | null }): Promise<{ [s: string]: { [name: string]: StoreSnapshot } }> {
        const out: { [s: string]: { [name: string]: StoreSnapshot } } = {};
        await Promise.all(
            scriptIds.map(async (s) => {
                out[s] = await this.run(s, () => {
                    const snaps: { [name: string]: StoreSnapshot } = {};
                    for (const [key, e] of this.state(s).stores) {
                        const pg = splitStoreKey(key).page;
                        if (pg && only && pg !== only.page) continue;
                        snaps[key] = { rev: e.rev, data: cloneJson(e.data) };
                    }
                    return snaps;
                });
            })
        );
        return out;
    }

    /** a store's current state (tests, rules); `page`: that page's copy */
    get(scriptId: string, name: string, page?: string): StoreSnapshot | undefined {
        const e = this.scripts.get(scriptId)?.stores.get(storeKey(name, page));
        return e && { rev: e.rev, data: cloneJson(e.data) };
    }

    /** the pages a script has `wt.pageStore` copies on */
    pagesOf(scriptId: string): Set<string> {
        const out = new Set<string>();
        for (const k of this.scripts.get(scriptId)?.stores.keys() ?? []) {
            const p = splitStoreKey(k).page;
            if (p) out.add(p);
        }
        return out;
    }

    /** the page ended: drop its copies (every context's replicas too) */
    dropPage(pageKey: string): void {
        const suffix = `\u0000${pageKey}`;
        for (const [s, st] of this.scripts) {
            const names: string[] = [];
            const told = new Set<Endpoint>(this.broadcast);
            for (const [k, e] of [...st.stores]) {
                if (!k.endsWith(suffix)) continue;
                st.stores.delete(k);
                names.push(splitStoreKey(k).name);
                for (const ep of e.subs) told.add(ep);
            }
            if (!names.length) continue;
            for (const ep of told) if (!ep.closed) ep.push("store.drop", { page: pageKey }, s);
            this.scheduleSession(s);
            for (const name of names) this.changed(s, name, pageKey);
        }
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
            st = { stores: new Map(), templates: new Map(), chain: Promise.resolve(), loaded: null };
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
            await this.deps.ready?.();
            const sess = await this.deps.sessionGet?.(SESSION_PREFIX + s);
            if (sess && typeof sess === "object") {
                for (const [key, v] of Object.entries<any>(sess)) {
                    const pg = splitStoreKey(key).page;
                    if (pg && !this.alive(pg)) continue;
                    if (v && typeof v.rev === "number" && !st.stores.has(key)) st.stores.set(key, { rev: v.rev, data: v.data ?? {}, persist: pg ? undefined : v.persist, ring: [], subs: new Set() });
                }
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

    private alive(page: string): boolean {
        return !this.deps.pageAlive || this.deps.pageAlive(page);
    }

    /** `page`: that page's copy, made from the template */
    private entry(s: string, name: string, page?: string): Entry {
        const st = this.state(s);
        const key = storeKey(name, page);
        let e = st.stores.get(key);
        if (!e) {
            e = { rev: 0, data: page ? cloneJson(st.templates.get(name) ?? {}) : {}, persist: undefined, ring: [], subs: new Set() };
            st.stores.set(key, e);
        }
        return e;
    }

    /** `wt.pageStore(name, initial)`: the template, its new fields merged into the copies too */
    private declarePage(s: string, name: string, initial: Json): void {
        if (typeof name !== "string" || !name || badValue(initial) || !isPlainObject(initial)) return;
        const st = this.state(s);
        const tpl = st.templates.get(name);
        st.templates.set(name, tpl && isPlainObject(tpl) ? (applyOps(tpl, missingOps(tpl, initial)), tpl) : cloneJson(initial));
        const prefix = `${name}\u0000`;
        for (const [k, e] of st.stores) {
            if (!k.startsWith(prefix) || !isPlainObject(e.data)) continue;
            const ops = missingOps(e.data, initial);
            if (!ops.length) continue;
            applyOps(e.data, ops);
            this.commit(s, name, e, ops, undefined, k.slice(prefix.length));
        }
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

    private set(from: Endpoint, s: string, name: string, op: string, ops: StoreOp[], page?: string): void {
        // a page that ended: its replicas get store.drop, no need to answer
        if (page && !this.alive(page)) return;
        const e = this.entry(s, name, page);
        if (typeof op !== "string" || e.ring.includes(op)) return;
        const reject = (reason: string) => from.push("store.reject", { name, op, reason, ...(page ? { page } : {}) }, s);
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
        this.commit(s, name, e, applied, op, page);
    }

    private sub(ep: Endpoint, s: string, name: string, rev: number | undefined, page?: string): { rev: number; data?: Json; ops: string[] } {
        if (page && !this.alive(page)) return { rev: 0, data: cloneJson(this.state(s).templates.get(name) ?? {}), ops: [] };
        const e = this.entry(s, name, page);
        if (!this.broadcast.has(ep)) e.subs.add(ep);
        return rev === e.rev ? { rev: e.rev, ops: [...e.ring] } : { rev: e.rev, data: cloneJson(e.data), ops: [...e.ring] };
    }

    private commit(s: string, name: string, e: Entry, ops: StoreOp[], op?: string, page?: string): void {
        e.rev++;
        const patch = { name, rev: e.rev, ops, ...(op ? { op } : {}), ...(page ? { page } : {}) };
        for (const ep of this.broadcast) ep.push("store.patch", patch, s);
        for (const ep of e.subs) if (!ep.closed) ep.push("store.patch", patch, s);
        if (!page) this.schedulePersist(s, name);
        this.scheduleSession(s);
        this.changed(s, name, page);
    }

    private changed(s: string, name: string, page?: string): void {
        for (const fn of this.changeFns) {
            try {
                fn(s, name, page);
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
        const i = k.indexOf("\u0000");
        const s = k.slice(0, i);
        const name = k.slice(i + 1);
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
        for (const [key, e] of st.stores) out[key] = { rev: e.rev, persist: e.persist, data: e.data };
        try {
            await this.deps.sessionSet(SESSION_PREFIX + s, out);
        } catch {}
    }
}
