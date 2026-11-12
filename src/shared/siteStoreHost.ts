/**
 * `tt.siteStore`'s source of truth: one valtio proxy per script and name,
 * living in the site's JavaScript world (the page hook, hook.ts) for the
 * life of the document. onSite code reads and writes it directly; the
 * script's onPage and onOverlay code see it through mirrors
 * (siteStoreMirror.ts) that connect here over window messages.
 *
 * Everything here is page data: the site can read and rewrite these
 * proxies, and can post any of these messages itself. Mirrors only ever
 * accept JSON from here, for subscriptions they made.
 */
import { proxy, subscribe } from "valtio/vanilla";
import type { Json, StoreOp } from "./wire";
import { applyOps, badPath, badValue, isPlainObject, missingOps, STORE_MAX_BYTES, jsonBytes } from "./storeOps";
import { isLocalField, splitInitial, toJson } from "./storeView";

/** a mirror → the site's world */
export type SiteUp =
    | { kind: "site.connect"; s: string; name: string; initial: Json; sub: string }
    | { kind: "site.set"; s: string; name: string; op: string; ops: StoreOp[] }
    | { kind: "site.disconnect"; sub: string };

/** the site's world → mirrors (`sub`: the subscription it answers) */
export type SiteDown =
    | { kind: "site.snapshot"; sub: string; value: Json }
    /** what changed, and which of the subscriber's `site.set` ops are now in it */
    | { kind: "site.ops"; sub: string; ops: StoreOp[]; acks: string[] }
    /** the site's world (re)started: mirrors connect again */
    | { kind: "site.ready" };

export const SITE_UP_KINDS = new Set(["site.connect", "site.set", "site.disconnect"]);
export const SITE_DOWN_KINDS = new Set(["site.snapshot", "site.ops", "site.ready"]);

export type SiteLog = (scriptId: string, msg: string, level: "info" | "warn" | "error") => void;

interface HostStore {
    s: string;
    name: string;
    proxy: Record<string, any>;
    subs: Set<string>;
    batch: StoreOp[];
    acks: string[];
    queued: boolean;
    /** recent op ids applied (a mirror that resends after a reconnect) */
    seen: string[];
    warned: boolean;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 512;

export class SiteStoreHost {
    private readonly stores = new Map<string, HostStore>();
    private readonly subs = new Map<string, HostStore>();

    constructor(private readonly o: { post: (m: SiteDown) => void; log?: SiteLog }) {}

    /** tell mirrors that connected before this world was ready */
    ready(): void {
        this.o.post({ kind: "site.ready" });
    }

    /** `tt.siteStore(name, initial)` in script `s`'s onSite code (the same proxy on every run) */
    store(s: string, name: string, initial: object): object {
        const t = splitInitial(name, initial, "tt.siteStore");
        const st = this.get(s, name, t.json);
        for (const [k, d] of t.local) Object.defineProperty(st.proxy, k, { ...d, configurable: true });
        return st.proxy;
    }

    /** a message from a mirror (or from the page: it's page data either way) */
    receive(m: any): void {
        if (!m || typeof m !== "object") return;
        if (m.kind === "site.connect") {
            if (!str(m.s) || !str(m.name) || !str(m.sub) || !isPlainObject(m.initial) || badValue(m.initial)) return;
            const st = this.get(m.s, m.name, m.initial);
            const was = this.subs.get(m.sub);
            if (was && was !== st) was.subs.delete(m.sub);
            // what's queued goes out first: the snapshot already holds it
            this.flush(st);
            st.subs.add(m.sub);
            this.subs.set(m.sub, st);
            this.o.post({ kind: "site.snapshot", sub: m.sub, value: this.data(st) });
            return;
        }
        if (m.kind === "site.set") {
            if (!str(m.s) || !str(m.name) || !str(m.op) || !Array.isArray(m.ops)) return;
            const st = this.stores.get(keyOf(m.s, m.name));
            if (!st) return;
            if (!st.seen.includes(m.op)) {
                st.seen.push(m.op);
                if (st.seen.length > 64) st.seen.shift();
                const ok = (m.ops as unknown[]).filter((op): op is StoreOp => this.validOp(st, op));
                if (ok.length) applyOps(st.proxy as Json, ok);
                if (jsonBytes(this.data(st)) > STORE_MAX_BYTES) this.warn(st, `over ${STORE_MAX_BYTES / 1024 / 1024} MB`);
            }
            st.acks.push(m.op);
            this.queue(st);
            return;
        }
        if (m.kind === "site.disconnect") {
            if (!str(m.sub)) return;
            this.subs.get(m.sub)?.subs.delete(m.sub);
            this.subs.delete(m.sub);
        }
    }

    private get(s: string, name: string, json: Json): HostStore {
        const key = keyOf(s, name);
        const have = this.stores.get(key);
        if (have) {
            // a newer `initial` (the script was saved): its new fields are added
            const add = missingOps(this.data(have), json);
            if (add.length) applyOps(have.proxy as Json, add);
            return have;
        }
        const p = proxy(isPlainObject(json) ? JSON.parse(JSON.stringify(json)) : {}) as Record<string, any>;
        const st: HostStore = { s, name, proxy: p, subs: new Set(), batch: [], acks: [], queued: false, seen: [], warned: false };
        subscribe(p, (ops) => this.onOps(st, ops as any[]), true);
        this.stores.set(key, st);
        return st;
    }

    private validOp(st: HostStore, op: unknown): boolean {
        if (!Array.isArray(op) || (op[0] !== "set" && op[0] !== "del") || badPath(op[1])) return false;
        if (op[1].length === 1 && isLocalField(st.proxy, String(op[1][0]))) return false;
        return op[0] === "del" || (op.length === 3 && badValue(op[2]) === null);
    }

    /** the store's JSON fields (what mirrors see) */
    private data(st: HostStore): Json {
        const out: Record<string, Json> = {};
        for (const k of Object.keys(st.proxy)) {
            if (isLocalField(st.proxy, k)) continue;
            const v = st.proxy[k];
            if (v === undefined) continue;
            try {
                out[k] = toJson(v);
            } catch (why) {
                this.warn(st, `${k}: ${why}`);
            }
        }
        return out;
    }

    private onOps(st: HostStore, ops: any[]): void {
        for (const op of ops) {
            const [kind, path] = op as [string, PropertyKey[]];
            if (!Array.isArray(path) || path.some((k) => typeof k === "symbol")) continue;
            const keys = path as string[];
            if (keys.length === 1 && isLocalField(st.proxy, keys[0])) continue;
            const v = op[2];
            if (kind === "delete" || (kind === "set" && v === undefined)) {
                if (!(typeof v === "function" && keys.length === 1)) st.batch.push(["del", keys]);
            } else if (kind === "set" && !(typeof v === "function" && keys.length === 1)) {
                try {
                    st.batch.push(["set", keys, toJson(v)]);
                } catch (why) {
                    this.warn(st, `${keys.join(".")}: ${why}`);
                }
            }
        }
        this.queue(st);
    }

    private queue(st: HostStore): void {
        if (st.queued) return;
        st.queued = true;
        queueMicrotask(() => this.flush(st));
    }

    private flush(st: HostStore): void {
        st.queued = false;
        const ops = st.batch;
        const acks = st.acks;
        st.batch = [];
        st.acks = [];
        if (!ops.length && !acks.length) return;
        for (const sub of st.subs) this.o.post({ kind: "site.ops", sub, ops, acks });
    }

    private warn(st: HostStore, why: string): void {
        if (st.warned) return;
        st.warned = true;
        this.o.log?.(st.s, `tt.siteStore("${st.name}"): ${why} — onPage and onOverlay code only see JSON values (plain objects, arrays, strings, numbers, booleans, null)`, "warn");
    }
}

const keyOf = (s: string, name: string) => `${s}\u0000${name}`;
