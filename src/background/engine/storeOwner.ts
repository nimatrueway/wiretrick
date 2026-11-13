/**
 * The `tt.globalStore` owner (background): the one true state of every script's
 * stores. Replicas declare and change stores over wire endpoints
 * (src/shared/storeReplica.ts); the owner validates each change, applies
 * it, bumps the store's rev and patches every replica of the script.
 *
 * Persistence: a store's persisted fields go to the script's storage under
 * `"$store:<name>"` (write-behind); MV3 also keeps the full state in
 * `chrome.storage.session` so a service-worker restart resumes at the
 * same rev.
 *
 * `tt.pageStore`: a declare with `scope: "page"` sets the template; each
 * page's copy is made from it when a context first uses it on that page
 * (rev 0) and dropped when the page ends (`dropPage`). Copies are keyed
 * `storeKey(name, page)` and never persisted (MV3: session only).
 */
import type { Endpoint, Json, StoreOp, StorePersist, StoreSnapshot } from "../../shared/wire";
import { STORE_MAX_BYTES, applyOps, badPath, badValue, cloneJson, isPlainObject, isTabScope, jsonBytes, jsonEqual, missingOps, persistedPart, splitStoreKey, storeKey, tabScopeId, tabScopeOfPage } from "../../shared/storeOps";

export const STORE_KEY_PREFIX = "$store:";
const SESSION_PREFIX = "ttStores.";
const RING = 256;
const page = (p: unknown): string | undefined => (typeof p === "string" && p ? p : undefined);

export interface OwnerStoreInfo {
    name: string;
    scope: "global" | "tab" | "page";
    page?: string;
    rev: number;
    persist?: StorePersist;
    data: Json;
    hasTemplate: boolean;
}

export interface StoreOwnerDeps {
    /** the script's storage object (`tt.storage`), where `$store:<name>` keys live */
    storageAll(scriptId: string): Promise<Record<string, any>>;
    storageSet(scriptId: string, key: string, value: unknown): Promise<void>;
    storageDelete?(scriptId: string, key: string): Promise<void>;
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
    /** `tt.globalStore` names → initial defaults from `declare` */
    globalTemplates: Map<string, Json>;
    /** `tt.pageStore` names → the initial state of each page's copy */
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
        ep.on("store.declare", (a, s) => s && void this.run(s, () => (a.scope === "page" || a.scope === "tab" ? this.declarePage(s, a.name, a.initial) : this.declare(s, a.name, a.initial, a.persist))));
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

    /** the current stores of some scripts; `only.page`: of scoped copies, just that page's + its tab's (`null`: none, unless `tabs: true`) */
    async init(scriptIds: string[], only?: { page: string | null; tabs?: boolean }): Promise<{ [s: string]: { [name: string]: StoreSnapshot } }> {
        const out: { [s: string]: { [name: string]: StoreSnapshot } } = {};
        const tabOfOnly = only?.page ? tabScopeOfPage(only.page) : null;
        await Promise.all(
            scriptIds.map(async (s) => {
                out[s] = await this.run(s, () => {
                    const snaps: { [name: string]: StoreSnapshot } = {};
                    for (const [key, e] of this.state(s).stores) {
                        const pg = splitStoreKey(key).page;
                        if (pg && only) {
                            const ok = pg === only.page || (tabOfOnly !== null && pg === tabOfOnly) || (!!only.tabs && isTabScope(pg));
                            if (!ok) continue;
                        }
                        snaps[key] = { rev: e.rev, data: cloneJson(e.data) };
                    }
                    return snaps;
                });
            })
        );
        return out;
    }

    /** live browser `tabId`s whose `tt.tabStore` state differs from `initial` on any of `scriptIds` */
    async tabsOf(scriptIds: string[]): Promise<number[]> {
        const ids = new Set<number>();
        await Promise.all(
            scriptIds.map((s) =>
                this.run(s, () => {
                    const st = this.state(s);
                    for (const [key, e] of st.stores) {
                        const { name, page: pg } = splitStoreKey(key);
                        const tid = tabScopeId(pg);
                        if (tid !== undefined && pg && this.alive(pg) && !jsonEqual(e.data, st.templates.get(name) ?? {})) ids.add(tid);
                    }
                })
            )
        );
        return [...ids].sort((a, b) => a - b);
    }

    /** a store's current state (tests, rules); `page`: that page's copy */
    get(scriptId: string, name: string, page?: string): StoreSnapshot | undefined {
        const e = this.scripts.get(scriptId)?.stores.get(storeKey(name, page));
        return e && { rev: e.rev, data: cloneJson(e.data) };
    }

    /** the pages a script has `tt.pageStore` copies on */
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

    /** inspect all global and live page stores for `scriptIds` (hydrating persisted `$store:` keys first) */
    async inspect(scriptIds: string[]): Promise<Record<string, OwnerStoreInfo[]>> {
        const out: Record<string, OwnerStoreInfo[]> = {};
        await Promise.all(
            scriptIds.map(async (s) => {
                out[s] = await this.run(s, () => {
                    const st = this.state(s);
                    const list: OwnerStoreInfo[] = [];
                    for (const [key, e] of st.stores) {
                        const { name, page: pg } = splitStoreKey(key);
                        if (pg && !this.alive(pg)) continue;
                        list.push({
                            name,
                            scope: !pg ? "global" : isTabScope(pg) ? "tab" : "page",
                            ...(pg ? { page: pg } : {}),
                            rev: e.rev,
                            persist: e.persist,
                            data: cloneJson(e.data),
                            hasTemplate: pg ? st.templates.has(name) : st.globalTemplates.has(name),
                        });
                    }
                    return list;
                });
            })
        );
        return out;
    }

    /** replace a store's entire JSON object from the UI or Import…, broadcasting live patches and persisting */
    replace(scriptId: string, name: string, nextData: unknown, pg?: string): Promise<StoreSnapshot> {
        return this.run(scriptId, async () => {
            if (!name) throw new Error("store name is required");
            if (!isPlainObject(nextData)) throw new Error("store value must be a JSON object ({ … })");
            const bad = badValue(nextData);
            if (bad) throw new Error(bad);
            if (jsonBytes(nextData) > STORE_MAX_BYTES) throw new Error(`store exceeds ${STORE_MAX_BYTES / 1024 / 1024} MB`);
            if (pg && !this.alive(pg)) throw new Error("that tab's page is no longer open");
            const e = this.entry(scriptId, name, pg);
            const cur: Record<string, any> = isPlainObject(e.data) ? e.data : {};
            const ops: StoreOp[] = [];
            for (const k of Object.keys(cur)) {
                if (!Object.prototype.hasOwnProperty.call(nextData, k)) ops.push(["del", [k]]);
            }
            for (const [k, v] of Object.entries(nextData)) {
                if (v === undefined) continue;
                const badK = badPath([k]);
                if (badK) throw new Error(badK);
                if (!jsonEqual(cur[k], v)) ops.push(["set", [k], cloneJson(v)]);
            }
            if (!isPlainObject(e.data)) e.data = {};
            const applied = applyOps(e.data, ops);
            if (applied.length) {
                this.commit(scriptId, name, e, applied, undefined, pg);
            }
            if (!pg && e.persist !== false) {
                const timerKey = `${scriptId}\u0000${name}`;
                const t = this.persistTimers.get(timerKey);
                if (t) {
                    clearTimeout(t);
                    this.persistTimers.delete(timerKey);
                }
                await this.deps.storageSet(scriptId, STORE_KEY_PREFIX + name, persistedPart(e.data, e.persist ?? true));
            }
            return { rev: e.rev, data: cloneJson(e.data) };
        });
    }

    /** reset a store to the `initial` object declared by the script */
    reset(scriptId: string, name: string, pg?: string): Promise<StoreSnapshot> {
        const st = this.state(scriptId);
        const tpl = pg ? st.templates.get(name) : st.globalTemplates.get(name);
        if (!tpl) return Promise.reject(new Error("this script hasn't declared initial defaults for that store yet"));
        return this.replace(scriptId, name, cloneJson(tpl), pg);
    }

    /** delete a store's persisted state (and reset to initial if active, or drop if orphaned / page store) */
    deleteStore(scriptId: string, name: string, pg?: string): Promise<void> {
        return this.run(scriptId, async () => {
            const st = this.state(scriptId);
            if (pg) {
                const key = storeKey(name, pg);
                const tpl = st.templates.get(name);
                if (tpl && this.alive(pg)) {
                    await this.replace(scriptId, name, cloneJson(tpl), pg);
                } else if (st.stores.delete(key)) {
                    this.scheduleSession(scriptId);
                    this.changed(scriptId, name, pg);
                }
                return;
            }
            const timerKey = `${scriptId}\u0000${name}`;
            const t = this.persistTimers.get(timerKey);
            if (t) {
                clearTimeout(t);
                this.persistTimers.delete(timerKey);
            }
            await this.deps.storageDelete?.(scriptId, STORE_KEY_PREFIX + name);
            const tpl = st.globalTemplates.get(name);
            const e = st.stores.get(name);
            if (tpl && e && isPlainObject(tpl)) {
                const cur: Record<string, any> = isPlainObject(e.data) ? e.data : {};
                const tplRec = tpl as Record<string, any>;
                const ops: StoreOp[] = [];
                for (const k of Object.keys(cur)) if (!Object.prototype.hasOwnProperty.call(tplRec, k)) ops.push(["del", [k]]);
                for (const [k, v] of Object.entries(tplRec)) if (!jsonEqual(cur[k], v)) ops.push(["set", [k], cloneJson(v)]);
                if (ops.length) {
                    applyOps(e.data, ops);
                    e.rev++;
                    const patch = { name, rev: e.rev, ops };
                    for (const ep of this.broadcast) ep.push("store.patch", patch, scriptId);
                    for (const ep of e.subs) if (!ep.closed) ep.push("store.patch", patch, scriptId);
                }
                this.scheduleSession(scriptId);
                this.changed(scriptId, name);
            } else if (st.stores.delete(name)) {
                this.scheduleSession(scriptId);
                this.changed(scriptId, name);
            }
        });
    }

    /** persisted globalStore objects for `scripts`, keyed by script name → store name → JSON */
    async exportPersisted(scripts: readonly { id: string; name: string }[]): Promise<Record<string, Record<string, Json>>> {
        const out: Record<string, Record<string, Json>> = {};
        for (const s of scripts) {
            const perScript = await this.run(s.id, async () => {
                const st = this.state(s.id);
                const saved = (await this.deps.storageAll(s.id)) ?? {};
                const stores: Record<string, Json> = {};
                for (const [key, e] of st.stores) {
                    const { name, page: pg } = splitStoreKey(key);
                    if (pg || e.persist === false) continue;
                    const part = persistedPart(e.data, e.persist ?? true);
                    const inStorage = Object.prototype.hasOwnProperty.call(saved, STORE_KEY_PREFIX + name);
                    if (isPlainObject(part) && (Object.keys(part).length > 0 || inStorage)) {
                        stores[name] = cloneJson(part);
                    }
                }
                return stores;
            });
            if (Object.keys(perScript).length > 0) out[s.name] = perScript;
        }
        return out;
    }

    // ---- ops (serialized per script) ----

    private state(s: string): ScriptState {
        let st = this.scripts.get(s);
        if (!st) {
            st = { stores: new Map(), globalTemplates: new Map(), templates: new Map(), chain: Promise.resolve(), loaded: null };
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

    /** `tt.pageStore(name, initial)`: the template, its new fields merged into the copies too */
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
        const st = this.state(s);
        const e = this.entry(s, name);
        const persistChanged = JSON.stringify(e.persist) !== JSON.stringify(persist);
        e.persist = persist;
        if (badValue(initial) || !isPlainObject(e.data)) return;
        if (isPlainObject(initial)) {
            const tpl = st.globalTemplates.get(name);
            st.globalTemplates.set(name, tpl && isPlainObject(tpl) ? (applyOps(tpl, missingOps(tpl, initial)), tpl) : cloneJson(initial));
        }
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
