/**
 * `tt.siteStore` mirrors: the valtio proxy onPage and onOverlay code get,
 * kept in sync with the store in the site's world (siteStoreHost.ts).
 *
 * A mirror's view = the last state the site's world sent (`data`) + this
 * context's writes it hasn't confirmed yet (`pending`). Local writes are
 * batched per microtask into one `site.set`; the site's `site.ops` apply
 * to `data` and confirm (`acks`) pending writes; after either the proxy is
 * brought to the view by writing only what differs (no echo).
 *
 * What arrives is page data: only messages for this context's own
 * subscriptions are read, and only JSON values are taken. One mirror per
 * script and name per context — a save of the script reuses it.
 */
import { proxy, subscribe } from "valtio/vanilla";
import type { Json, StoreOp } from "./wire";
import { applyOps, badPath, badValue, cloneJson, isPlainObject, jsonBytes, STORE_MAX_BYTES, withMissing } from "./storeOps";
import { isLocalField, splitInitial, toJson, writeDiff } from "./storeView";
import type { SiteDown, SiteLog, SiteUp } from "./siteStoreHost";

/** how long a mirror waits for the site's world before saying so (once) */
export const SITE_CONNECT_WARN_MS = 5000;

interface Mirror {
    s: string;
    name: string;
    sub: string;
    proxy: Record<string, any>;
    data: Json;
    pending: { op: string; ops: StoreOp[] }[];
    batch: StoreOp[];
    bad: string | null;
    queued: boolean;
    /** `initial`'s JSON fields, shown until the site's world answers */
    fill: Json | null;
    synced: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
    warned: boolean;
    unsub: () => void;
}

export interface SiteMirrorsOptions {
    /** this context's name, part of its subscription and op ids */
    ctx: string;
    post: (m: SiteUp) => void;
    log?: SiteLog;
}

export class SiteMirrors {
    private readonly mirrors = new Map<string, Mirror>();
    private readonly bySub = new Map<string, Mirror>();
    private readonly id: string;
    private seq = 0;
    private applying = false;

    constructor(private readonly o: SiteMirrorsOptions) {
        this.id = `${o.ctx}.${Math.random().toString(36).slice(2, 10)}`;
    }

    /** `tt.siteStore(name, initial)` for script `s` */
    store(s: string, name: string, initial: object): object {
        const t = splitInitial(name, initial, "tt.siteStore");
        const key = `${s}\u0000${name}`;
        const have = this.mirrors.get(key);
        if (have) {
            // the script was saved: same proxy; the site's world adds the new fields
            for (const [k, d] of t.local) Object.defineProperty(have.proxy, k, { ...d, configurable: true });
            have.fill = t.json;
            this.render(have);
            this.connect(have);
            return have.proxy;
        }
        const p = proxy({}) as Record<string, any>;
        for (const [k, d] of t.local) Object.defineProperty(p, k, { ...d, configurable: true });
        const m: Mirror = {
            s,
            name,
            sub: `${this.id}.${++this.seq}`,
            proxy: p,
            data: {},
            pending: [],
            batch: [],
            bad: null,
            queued: false,
            fill: t.json,
            synced: false,
            timer: undefined,
            warned: false,
            unsub: () => {},
        };
        this.render(m);
        m.unsub = subscribe(p, (ops) => !this.applying && this.onLocal(m, ops as any[]), true);
        this.mirrors.set(key, m);
        this.bySub.set(m.sub, m);
        this.connect(m);
        return p;
    }

    /** a message from the site's world (anyone on the page can post these) */
    receive(msg: unknown): void {
        const d = msg as SiteDown;
        if (!d || typeof d !== "object") return;
        if (d.kind === "site.ready") {
            for (const m of this.mirrors.values()) {
                m.synced = false;
                this.connect(m);
                for (const p of m.pending) this.o.post({ kind: "site.set", s: m.s, name: m.name, op: p.op, ops: p.ops });
            }
            return;
        }
        const m = typeof (d as any).sub === "string" ? this.bySub.get((d as any).sub) : undefined;
        if (!m) return;
        if (d.kind === "site.snapshot") {
            if (!isPlainObject(d.value) || badValue(d.value)) return;
            m.data = cloneJson(d.value);
            m.synced = true;
            m.fill = null;
            clearTimeout(m.timer);
            this.render(m);
            return;
        }
        if (d.kind === "site.ops") {
            if (!m.synced || !Array.isArray(d.ops) || !Array.isArray(d.acks)) return;
            const ops = d.ops.filter((op) => Array.isArray(op) && (op[0] === "del" || (op[0] === "set" && badValue(op[2]) === null)) && !badPath(op[1]));
            applyOps(m.data, ops);
            const acks = new Set(d.acks);
            m.pending = m.pending.filter((p) => !acks.has(p.op));
            this.render(m);
        }
    }

    /** the scripts still here: the others' mirrors disconnect */
    retain(scriptIds: Iterable<string>): void {
        const keep = new Set(scriptIds);
        for (const [k, m] of this.mirrors)
            if (!keep.has(m.s)) {
                this.drop(m);
                this.mirrors.delete(k);
            }
    }

    /** every mirror disconnects (the context goes away) */
    dispose(): void {
        for (const m of this.mirrors.values()) this.drop(m);
        this.mirrors.clear();
    }

    private drop(m: Mirror): void {
        m.unsub();
        clearTimeout(m.timer);
        this.bySub.delete(m.sub);
        this.o.post({ kind: "site.disconnect", sub: m.sub });
    }

    private connect(m: Mirror): void {
        this.o.post({ kind: "site.connect", s: m.s, name: m.name, initial: m.fill ?? {}, sub: m.sub });
        clearTimeout(m.timer);
        if (!m.synced && !m.warned)
            m.timer = setTimeout(() => {
                if (m.synced || m.warned) return;
                m.warned = true;
                this.o.log?.(
                    m.s,
                    `tt.siteStore("${m.name}"): the site's world hasn't answered after ${SITE_CONNECT_WARN_MS / 1000}s — the store keeps its local values until it does (TangiTweak's page hook may not run on this page)`,
                    "warn"
                );
            }, SITE_CONNECT_WARN_MS);
    }

    private view(m: Mirror): Json {
        const v = cloneJson(m.data);
        for (const p of m.pending) applyOps(v, p.ops);
        return m.fill ? withMissing(v, m.fill) : v;
    }

    private render(m: Mirror): void {
        this.applying = true;
        try {
            writeDiff(m.proxy, this.view(m));
        } finally {
            this.applying = false;
        }
    }

    private onLocal(m: Mirror, ops: any[]): void {
        for (const op of ops) {
            const [kind, path] = op as [string, PropertyKey[]];
            if (!Array.isArray(path) || path.some((k) => typeof k === "symbol")) continue;
            const keys = path as string[];
            if (keys.length === 1 && isLocalField(m.proxy, keys[0])) continue;
            const v = op[2];
            if (typeof v === "function" && keys.length === 1) continue;
            if (kind === "delete" || (kind === "set" && v === undefined)) m.batch.push(["del", keys]);
            else if (kind === "set")
                try {
                    m.batch.push(["set", keys, toJson(v)]);
                } catch (why) {
                    m.bad ??= `${keys.join(".")}: ${why}`;
                }
        }
        if (!m.queued) {
            m.queued = true;
            queueMicrotask(() => this.flush(m));
        }
    }

    private flush(m: Mirror): void {
        m.queued = false;
        const batch = m.batch;
        const bad = m.bad;
        m.batch = [];
        m.bad = null;
        if (bad) {
            this.o.log?.(m.s, `tt.siteStore("${m.name}"): ${bad} — the change was reverted (store values must be JSON)`, "error");
            this.render(m);
            return;
        }
        if (!batch.length) return;
        const op = `${m.sub}:${++this.seq}`;
        m.pending.push({ op, ops: batch });
        if (jsonBytes(this.view(m)) > STORE_MAX_BYTES) {
            m.pending.pop();
            this.o.log?.(m.s, `tt.siteStore("${m.name}"): over ${STORE_MAX_BYTES / 1024 / 1024} MB — the change was reverted`, "error");
            this.render(m);
            return;
        }
        this.o.post({ kind: "site.set", s: m.s, name: m.name, op, ops: batch });
    }
}
