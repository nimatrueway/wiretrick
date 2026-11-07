/**
 * `wt.globalStore` replicas: the valtio proxy a script gets in one context, kept
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
 *
 * `wt.pageStore`: one replica per page, made from the store's template
 * when first used there (or when the owner patches that page's copy) and
 * dropped with the page (`store.drop`). Code serving every tab gets a
 * forwarding proxy that picks the copy of the page whose handler is running
 * (src/shared/currentPage.ts); an overlay gets its page's replica.
 */
import { proxy, subscribe } from "valtio/vanilla";
import type { Endpoint, Json, StoreOp, StorePersist } from "./wire";
import { STORE_MAX_BYTES, applyOps, cloneJson, isPlainObject, jsonBytes, missingOps, storeKey, withMissing } from "./storeOps";
import { currentCall, currentPage, RULES_PAGE } from "./currentPage";
import { isLocalField, splitInitial, toJson, writeDiff, type Template } from "./storeView";

interface Replica {
    s: string;
    name: string;
    /** a page's copy of a `wt.pageStore` */
    page?: string;
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
    onChange?: (scriptId: string, name: string, page?: string) => void;
}

export type StoreSnapshots = { [scriptId: string]: { [name: string]: { rev: number; data: Json } } };

const keyOf = (s: string, name: string, page?: string) => `${s}\u0000${storeKey(name, page)}`;

/** `wt.pageStore` outside a handler's synchronous part */
export const noPageError = (name: string) =>
    new Error(`wt.pageStore("${name}"): no page here — a page's copy is reachable while a handler runs for one of the page's requests, until the handler's first await (read what you need before awaiting). Top-level code and timers have no page.`);

const pageOf = (rep: Replica): { page?: string } => (rep.page ? { page: rep.page } : {});

export class ReplicaHub {
    private ep: Endpoint | null = null;
    private readonly reps = new Map<string, Replica>();
    /** `wt.pageStore` templates by `keyOf(s, name)` */
    private readonly templates = new Map<string, Template>();
    /** a page-less handler call's throwaway copy, per store */
    private readonly scratch = new Map<string, { call: number; obj: object }>();
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
        ep.on("store.drop", (a, s) => s !== undefined && this.dropPage(s, a.page));
        this.reconnect();
    }

    /** the owner's current stores, so `wt.globalStore` returns them synchronously when a script compiles */
    prime(snaps: StoreSnapshots): void {
        for (const [s, stores] of Object.entries(snaps)) this.primed.set(s, { ...(this.primed.get(s) ?? {}), ...stores });
    }

    isPrimed(s: string): boolean {
        return this.primed.has(s);
    }

    /** the owner may have lost state (MV3 service worker restart): re-declare, re-sync and re-send */
    reconnect(): void {
        for (const [k, t] of this.templates) {
            const i = k.indexOf("\u0000");
            this.declarePage(k.slice(0, i), k.slice(i + 1), t);
        }
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
        for (const k of [...this.templates.keys()]) if (!keep.has(k.slice(0, k.indexOf("\u0000")))) this.templates.delete(k);
    }

    /** `wt.globalStore(name, initial, opts)` for script `s` */
    store<T extends object>(s: string, name: string, initial: T, persist: StorePersist = true): T {
        if (typeof name !== "string" || !name) throw new TypeError("wt.globalStore: the first argument must be the store's name (a non-empty string)");
        if (!initial || typeof initial !== "object" || Array.isArray(initial)) throw new TypeError(`wt.globalStore("${name}"): initial must be an object`);
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
        const rep = this.create(s, name, undefined, { json, local }, primed, persist);
        this.declare(rep);
        this.resync(rep, false);
        return rep.proxy as T;
    }

    /**
     * `wt.pageStore(name, initial)` for script `s`. `page`: the overlay's
     * page — its replica; absent: code serving every page — a proxy to the
     * copy of the page whose handler is running.
     */
    pageStore<T extends object>(s: string, name: string, initial: T, page?: string): T {
        if (typeof name !== "string" || !name) throw new TypeError("wt.pageStore: the first argument must be the store's name (a non-empty string)");
        if (!initial || typeof initial !== "object" || Array.isArray(initial)) throw new TypeError(`wt.pageStore("${name}"): initial must be an object`);
        const t = splitInitial(name, initial, "wt.pageStore");
        const tk = keyOf(s, name);
        const recompiled = this.templates.has(tk);
        this.templates.set(tk, t);
        this.declarePage(s, name, t);
        if (recompiled)
            for (const rep of this.reps.values()) {
                if (rep.s !== s || rep.name !== name || !rep.page) continue;
                rep.fill = t.json;
                for (const [k, d] of t.local) Object.defineProperty(rep.base, k, d);
                this.render(rep);
                this.resync(rep, false);
            }
        if (page !== undefined) return this.pageReplica(s, name, page)!.proxy as T;
        const target = (): Record<string, any> => {
            const pg = currentPage();
            if (pg === undefined) throw noPageError(name);
            if (pg === null) return this.scratchCopy(tk);
            if (pg === RULES_PAGE) throw new Error(`wt.pageStore("${name}") can't be read by a strategy "rules" handler — its rules are built once for every page; use another strategy`);
            return this.pageReplica(s, name, pg)!.proxy;
        };
        // `then`: an `await store` outside a handler shouldn't throw
        const quiet = (k: PropertyKey) => (k === "then" || typeof k === "symbol") && currentPage() === undefined;
        return new Proxy({} as T, {
            get: (_t, k) => (quiet(k) ? undefined : Reflect.get(target(), k)),
            set: (_t, k, v) => Reflect.set(target(), k, v),
            has: (_t, k) => Reflect.has(target(), k),
            deleteProperty: (_t, k) => Reflect.deleteProperty(target(), k),
            ownKeys: () => Reflect.ownKeys(target()),
            getOwnPropertyDescriptor: (_t, k) => {
                const d = Reflect.getOwnPropertyDescriptor(target(), k);
                return d && { ...d, configurable: true };
            },
            defineProperty: (_t, k, d) => Reflect.defineProperty(target(), k, d),
        });
    }

    /** page `page`'s replica of a `wt.pageStore`, made from its template on first use */
    private pageReplica(s: string, name: string, page: string): Replica | undefined {
        const key = keyOf(s, name, page);
        const have = this.reps.get(key);
        if (have) return have;
        const t = this.templates.get(keyOf(s, name));
        if (!t) return undefined;
        const primed = this.primed.get(s)?.[storeKey(name, page)];
        const rep = this.create(s, name, page, t, primed ?? { rev: 0, data: t.json }, false);
        rep.fill = null;
        this.resync(rep, false);
        return rep;
    }

    /** a request with no page (not from a tab): a copy of `initial` for this handler call */
    private scratchCopy(tk: string): Record<string, any> {
        const call = currentCall();
        const have = this.scratch.get(tk);
        if (have && have.call === call) return have.obj as Record<string, any>;
        const t = this.templates.get(tk)!;
        const obj: Record<string, any> = {};
        for (const [k, d] of t.local) Object.defineProperty(obj, k, d);
        for (const k of Object.keys(t.json)) if (!(k in obj)) obj[k] = cloneJson(t.json[k]);
        const p = proxy(obj);
        this.scratch.set(tk, { call, obj: p });
        return p;
    }

    private create(s: string, name: string, page: string | undefined, t: Template, primed: { rev: number; data: Json } | undefined, persist: StorePersist): Replica {
        const data = primed ? withMissing(cloneJson(primed.data), t.json) : cloneJson(t.json);
        const base: Record<string, any> = {};
        for (const [k, d] of t.local) Object.defineProperty(base, k, d);
        if (isPlainObject(data)) for (const k of Object.keys(data)) if (!(k in base)) base[k] = cloneJson((data as any)[k]);
        const p = proxy(base);
        const rep: Replica = {
            s,
            name,
            ...(page ? { page } : {}),
            proxy: p,
            base,
            persist,
            rev: primed ? primed.rev : -1,
            data,
            pending: [],
            batch: [],
            bad: null,
            flushQueued: false,
            fill: t.json,
            declareGen: 0,
            syncing: false,
            syncTok: 0,
            unsub: () => {},
        };
        rep.unsub = subscribe(p, (ops) => !this.applying && this.onLocal(rep, ops as any[]), true);
        this.reps.set(keyOf(s, name, page), rep);
        return rep;
    }

    /** the page ended: its replicas go */
    private dropPage(s: string, page: string): void {
        for (const [k, rep] of this.reps)
            if (rep.s === s && rep.page === page) {
                rep.unsub();
                rep.syncTok++;
                this.reps.delete(k);
            }
        const primed = this.primed.get(s);
        if (primed) for (const k of Object.keys(primed)) if (k.endsWith(`\u0000${page}`)) delete primed[k];
    }

    private declarePage(s: string, name: string, t: Template): void {
        this.ep?.push("store.declare", { name, initial: t.json, persist: false, scope: "page" }, s);
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
        this.ep?.push("store.set", { name: rep.name, op, ops: batch, ...pageOf(rep) }, rep.s);
        this.opts.onChange?.(rep.s, rep.name, rep.page);
    }

    // ---- the owner ----

    private declare(rep: Replica): void {
        if (rep.page) return; // the template is declared
        rep.declareGen++;
        this.ep?.push("store.declare", { name: rep.name, initial: rep.fill ?? {}, persist: rep.persist }, rep.s);
    }

    private resync(rep: Replica, resend: boolean): void {
        const ep = this.ep;
        if (!ep || ep.closed) return;
        const gen = rep.declareGen;
        const tok = ++rep.syncTok;
        rep.syncing = true;
        ep.call("store.sub", { name: rep.name, ...(rep.rev >= 0 ? { rev: rep.rev } : {}), ...pageOf(rep) }, rep.s).then(
            (res) => {
                if (tok !== rep.syncTok || this.reps.get(keyOf(rep.s, rep.name, rep.page)) !== rep) return;
                rep.syncing = false;
                if (res.data !== undefined) rep.data = res.data;
                rep.rev = res.rev;
                const done = new Set(res.ops);
                rep.pending = rep.pending.filter((p) => !done.has(p.op));
                if (gen === rep.declareGen) rep.fill = null;
                if (resend) for (const p of rep.pending) ep.push("store.set", { name: rep.name, op: p.op, ops: p.ops, ...pageOf(rep) }, rep.s);
                this.render(rep);
            },
            (e) => {
                if (tok !== rep.syncTok) return;
                rep.syncing = false;
                if (e?.name !== "DisconnectedError") this.opts.log?.(rep.s, `store "${rep.name}": sync failed: ${e?.message || e}`, "warn");
            }
        );
    }

    private onPatch(s: string, a: { name: string; rev: number; ops: StoreOp[]; op?: string; page?: string }): void {
        // a page's copy this context hasn't used yet: follow it from here (its template is rev 0)
        const rep = this.reps.get(keyOf(s, a.name, a.page)) ?? (a.page ? this.pageReplica(s, a.name, a.page) : undefined);
        if (!rep || rep.rev < 0 || rep.syncing || a.rev <= rep.rev) return;
        if (a.rev > rep.rev + 1) return this.resync(rep, true);
        applyOps(rep.data, a.ops);
        rep.rev = a.rev;
        if (a.op) rep.pending = rep.pending.filter((p) => p.op !== a.op);
        this.render(rep);
    }

    private onReject(s: string, a: { name: string; op: string; reason: string; page?: string }): void {
        const rep = this.reps.get(keyOf(s, a.name, a.page));
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
        if (changed) this.opts.onChange?.(rep.s, rep.name, rep.page);
    }
}
