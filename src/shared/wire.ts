/**
 * The message protocol every Wiretrick link speaks (owner ⇄ script
 * instance, owner ⇄ bridge, later bridge ⇄ overlay and the Editor
 * preview): one envelope shape, typed ops, `req`/`res` with timeouts and
 * one-way `push`es.
 *
 * An Endpoint is one side of one link. It only needs a `send` function;
 * whatever carries the messages calls `receive` with what arrives. The
 * adapters below wire the usual carriers: a `chrome.runtime` port (JSON,
 * so bytes are packed as `{ __wtBytes }`), a `MessagePort` (structured
 * clone) and an in-process pair (tests, the MV2 background page).
 */
import { packBytes, unpackBytes } from "./bytesPack";
import type { RouteMeta } from "./route";
import type { ShippedLib } from "./scriptImports";
import type { RpcCall, RpcResult } from "./rpc";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** a store mutation: a path of keys/indexes, set to a value or deleted */
export type StoreOp = ["set", (string | number)[], Json] | ["del", (string | number)[]];

/** which top-level fields of a store persist across browser restarts */
export type StorePersist = boolean | string[];

/** `wt.fetch` request as it crosses a link (the body as bytes) */
export interface WireRequest {
    url: string;
    method: string;
    headers: [string, string][];
    body?: Uint8Array;
    credentials?: RequestCredentials;
    redirect?: RequestRedirect;
    cache?: RequestCache;
    referrer?: string;
    referrerPolicy?: ReferrerPolicy;
}

/** `wt.fetch` response as it crosses a link */
export interface WireResponse {
    status: number;
    statusText: string;
    url: string;
    headers: [string, string][];
    body: Uint8Array;
}

/** a store's replicated state */
export interface StoreSnapshot {
    rev: number;
    data: Json;
}

/**
 * Every op, declared once: `req`/`res` for calls, `push` for one-way
 * messages. `call`, `push`, `handle` and `on` are typed over it.
 */
export interface WireOps {
    /** a context ran `wt.store(name, initial)` */
    "store.declare": { push: { name: string; initial: Json; persist: StorePersist } };
    /** the owner's snapshot when `rev` is stale or missing; `ops` = recently applied op ids */
    "store.sub": { req: { name: string; rev?: number }; res: { rev: number; data?: Json; ops: string[] } };
    /** one context's mutations within one microtask */
    "store.set": { push: { name: string; op: string; ops: StoreOp[] } };
    /** the owner applied a `store.set` (or merged a declare): every replica of the script gets it */
    "store.patch": { push: { name: string; rev: number; ops: StoreOp[]; op?: string } };
    /** the owner refused a `store.set` */
    "store.reject": { push: { name: string; op: string; reason: string } };
    /** the current stores of some scripts (primes a context before its scripts compile) */
    "store.init": { req: { scripts: string[] }; res: { [scriptId: string]: { [name: string]: StoreSnapshot } } };
    /** `wt.fetch(..., { from: "background" })` */
    fetch: { req: { request: WireRequest; bypass: boolean; tabId?: number }; res: WireResponse };
    /** register a one-shot bypass (§3.5): the next matching request skips every script */
    "bypass.add": { req: { tabId: number; method: string; url: string }; res: {} };
    /** scripts changed: a bridge reloads what depends on them */
    "bundle.update": { push: { scripts: { s: string; codeHash: string }[] } };

    // ---- the overlay (L3: overlay ⇄ bridge; L2 for what the bridge relays) ----
    /** L3: the overlay frame starts (its nonce proves it's the frame the bridge made) */
    hello: { req: { nonce: string }; res: OverlayInit };
    /** L2: the bridge is about to frame script `s`'s overlay for the page at `url` with this one-time nonce (also: re-grant after a reconnect) */
    "overlay.open": { req: { nonce: string; url: string }; res: {} };
    /** L2: what script `s`'s overlay runs in this frame (refused unless it has one here) */
    "overlay.init": { req: {}; res: OverlayInit };
    /** L2: script `s`'s overlay closed or reloaded */
    "overlay.closed": { push: {} };
    /** L3: `wt.fetch(…, { from: "page" })` — the bridge fetches, with the page's cookies */
    pagefetch: { req: { request: WireRequest; bypass: boolean }; res: WireResponse };
    /** L3: the page reached a `when` phase */
    when: { push: { phase: "document_start" | "document_end" | "document_idle" } };
    /** L3: the overlay's visible areas, `[x, y, width, height]` in CSS pixels (empty: nothing to show) */
    rects: { push: { rects: [number, number, number, number][] } };
    /** L3: the user pressed in the overlay: bring it to the front */
    focus: { push: {} };
    /** L3: the overlay's errors and console output, for the script's Log */
    log: { push: { level: "debug" | "info" | "warn" | "error"; msg: string } };
    /** L3: the page navigated in place (history API, hash) */
    nav: { push: { url: string } };
    /** L3: the overlay's `wt.storage` (the bridge relays it for this script) */
    "storage.get": { req: { key: string }; res: { value: any } };
    "storage.set": { req: { key: string; value: any }; res: {} };
    /** L3: `ctx.shortcut` registered keys (`id` is the overlay's); the bridge listens for them in the page */
    "shortcut.add": { push: { id: string; keys: string; priority: "before-page" | "after-page" } };
    "shortcut.remove": { push: { id: string } };
    /** L3: a shortcut's keys were pressed in the page */
    "shortcut.fire": { push: { id: string } };
    /** L3: the page's L2 link came back: replicas re-subscribe */
    "store.resync": { push: {} };
    /** a call between the overlay and onPage code (shared/rpc.ts) */
    "rpc.call": { push: RpcCall };
    /** its answer */
    "rpc.result": { push: RpcResult };

    // ---- MV3 isolated-world onPage code (L6: chrome.userScripts world ⇄ owner; L2 for the relay) ----
    /** L6: what script `s` runs in this frame's user-script world (refused unless it has isolated onPage code here) */
    "iso.load": { req: { url: string }; res: IsoInit };
    /** L6: scripts changed: load again, re-run when the code hash moved */
    "iso.update": { push: {} };
    /** L2: a call between script `s`'s overlay (via the top-frame bridge) and its isolated-world code (via the owner) */
    "iso.call": { push: RpcCall };
    /** L2: its answer */
    "iso.result": { push: RpcResult };

    // ---- the Editor preview (L5: the Editor ⇄ owner, one script at a time; L3 as above between the Editor and its frame) ----
    /**
     * L5: preview script `s`'s overlay as if on `url` ("": the first URL its
     * onOverlay routes name) in a frame with this one-time nonce. Then
     * `overlay.init`, `store.*`, `fetch`, `storage.*` and `log` work for `s`
     * on this link; scripts changing come as `bundle.update`.
     */
    "preview.open": { req: { nonce: string; url: string }; res: { url: string; name: string; handlers: number; matching: number } };
}

/** what a user-script world needs to run a script's `world: "isolated"` onPage code */
export interface IsoInit {
    s: string;
    name: string;
    /** the script's runnable JS */
    src: string;
    codeHash: string;
    params: Record<string, any>;
    libs: ShippedLib[];
    /** the script has an overlay on this page (top frame) */
    overlay: boolean;
}

/** what an overlay frame needs to run its script */
export interface OverlayInit {
    s: string;
    name: string;
    /** the script's runnable JS (never sent through the page) */
    code: string;
    codeHash: string;
    /** its onOverlay routes matching the page */
    routes: RouteMeta[];
    /** the page's URL */
    url: string;
    params: Record<string, any>;
    stores: { [name: string]: StoreSnapshot };
    libs: ShippedLib[];
    /** load the built-in React first */
    react: boolean;
    /** the page's current `when` phase */
    phase?: "document_start" | "document_end" | "document_idle";
}

type ReqOps = { [K in keyof WireOps]: WireOps[K] extends { req: any } ? K : never }[keyof WireOps];
type PushOps = { [K in keyof WireOps]: WireOps[K] extends { push: any } ? K : never }[keyof WireOps];
export type ReqOf<K extends ReqOps> = WireOps[K] extends { req: infer R } ? R : never;
export type ResOf<K extends ReqOps> = WireOps[K] extends { res: infer R } ? R : never;
export type PushOf<K extends PushOps> = WireOps[K] extends { push: infer P } ? P : never;
export type { ReqOps, PushOps };

export type Envelope =
    | { v: 1; t: "req"; id: number; op: string; s?: string; a: unknown }
    | { v: 1; t: "res"; id: number; ok: true; r: unknown }
    | { v: 1; t: "res"; id: number; ok: false; e: { name: string; message: string } }
    | { v: 1; t: "push"; op: string; s?: string; a: unknown };

/** a link's carrier delivers one envelope, or a batch of them, per message */
export type WireMessage = Envelope | Envelope[];

export const WIRE_TIMEOUT_MS = 30000;
/** largest message on a link (fetch bodies excepted) */
export const WIRE_MAX_BYTES = 1024 * 1024;
/** largest `wt.fetch` body */
export const FETCH_MAX_BYTES = 10 * 1024 * 1024;

function namedError(name: string, message: string): Error {
    const e = new Error(message);
    e.name = name;
    return e;
}

export interface EndpointOptions {
    /** `req` timeout (default 30 s) */
    timeoutMs?: number;
    /** coalesce outgoing pushes for this many ms into one batch message (0: send each now) */
    batchMs?: number;
    /** diagnostics for dropped or malformed messages */
    debug?: (msg: string) => void;
}

type ReqHandler = (a: any, s: string | undefined, ep: Endpoint) => unknown;
type PushHandler = (a: any, s: string | undefined, ep: Endpoint) => void;

export class Endpoint {
    private seq = 0;
    private readonly pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private readonly reqHandlers = new Map<string, ReqHandler>();
    private readonly pushHandlers = new Map<string, PushHandler[]>();
    private readonly closeHandlers: ((reason: string) => void)[] = [];
    private queue: Envelope[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    closed = false;

    constructor(
        private readonly sendRaw: (msg: WireMessage) => void,
        private readonly opts: EndpointOptions = {}
    ) {}

    /** send a request; rejects with TimeoutError, DisconnectedError or the remote error */
    call<K extends ReqOps>(op: K, a: ReqOf<K>, s?: string): Promise<ResOf<K>> {
        if (this.closed) return Promise.reject(namedError("DisconnectedError", `${op}: the link is closed`));
        const id = ++this.seq;
        return new Promise<ResOf<K>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(namedError("TimeoutError", `${op}: no answer within ${Math.round((this.opts.timeoutMs ?? WIRE_TIMEOUT_MS) / 1000)} s`));
            }, this.opts.timeoutMs ?? WIRE_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ v: 1, t: "req", id, op, ...(s !== undefined ? { s } : {}), a });
        });
    }

    /** send a one-way message */
    push<K extends PushOps>(op: K, a: PushOf<K>, s?: string): void {
        if (this.closed) return;
        const env: Envelope = { v: 1, t: "push", op, ...(s !== undefined ? { s } : {}), a };
        if (!this.opts.batchMs) return this.send(env);
        this.queue.push(env);
        this.flushTimer ??= setTimeout(() => this.flush(), this.opts.batchMs);
    }

    /** answer requests for `op` (one handler per op; a throw or rejection answers with the error) */
    handle<K extends ReqOps>(op: K, fn: (a: ReqOf<K>, s: string | undefined, ep: Endpoint) => ResOf<K> | Promise<ResOf<K>>): void {
        this.reqHandlers.set(op, fn as ReqHandler);
    }

    /** listen for pushes of `op` */
    on<K extends PushOps>(op: K, fn: (a: PushOf<K>, s: string | undefined, ep: Endpoint) => void): void {
        const list = this.pushHandlers.get(op) ?? [];
        list.push(fn as PushHandler);
        this.pushHandlers.set(op, list);
    }

    onClose(fn: (reason: string) => void): void {
        if (this.closed) fn("closed");
        else this.closeHandlers.push(fn);
    }

    /** a message from the other side */
    receive(msg: unknown): void {
        if (this.closed) return;
        if (Array.isArray(msg)) {
            for (const m of msg) this.receiveOne(m);
            return;
        }
        this.receiveOne(msg);
    }

    /** reject every pending call with DisconnectedError and stop */
    close(reason = "disconnected"): void {
        if (this.closed) return;
        this.flush();
        this.closed = true;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(namedError("DisconnectedError", reason));
        }
        this.pending.clear();
        for (const fn of this.closeHandlers.splice(0)) {
            try {
                fn(reason);
            } catch {}
        }
    }

    /** send queued pushes now */
    flush(): void {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        const q = this.queue;
        this.queue = [];
        if (q.length === 1) this.sendSafe(q[0]);
        else if (q.length) this.sendSafe(q);
    }

    private send(env: Envelope): void {
        // keep order: queued pushes go first
        if (this.queue.length) this.flush();
        this.sendSafe(env);
    }

    private sendSafe(msg: WireMessage): void {
        try {
            this.sendRaw(msg);
        } catch (e: any) {
            this.opts.debug?.(`send failed: ${e?.message || e}`);
            this.close(`send failed: ${e?.message || e}`);
        }
    }

    private receiveOne(env: any): void {
        if (!env || typeof env !== "object" || typeof env.t !== "string") return this.opts.debug?.("dropped a malformed message");
        if (env.v !== 1) {
            // a newer protocol: say so to a caller, drop anything else
            if (env.t === "req" && typeof env.id === "number") this.answerError(env.id, namedError("VersionError", `unsupported protocol version ${env.v}`));
            return;
        }
        if (env.t === "res") {
            const p = this.pending.get(env.id);
            if (!p) return;
            this.pending.delete(env.id);
            clearTimeout(p.timer);
            if (env.ok) p.resolve(env.r);
            else p.reject(namedError(String(env.e?.name || "Error"), String(env.e?.message || "error")));
            return;
        }
        if (env.t === "push") {
            const list = this.pushHandlers.get(env.op);
            if (!list) return this.opts.debug?.(`ignored unknown push "${env.op}"`);
            for (const fn of list) {
                try {
                    fn(env.a, env.s, this);
                } catch (e: any) {
                    this.opts.debug?.(`push "${env.op}" handler threw: ${e?.message || e}`);
                }
            }
            return;
        }
        if (env.t === "req") {
            const fn = this.reqHandlers.get(env.op);
            if (!fn) return this.answerError(env.id, namedError("UnknownOpError", `unknown op "${env.op}"`));
            let out: unknown;
            try {
                out = fn(env.a, env.s, this);
            } catch (e: any) {
                return this.answerError(env.id, e);
            }
            Promise.resolve(out).then(
                (r) => this.send({ v: 1, t: "res", id: env.id, ok: true, r: r === undefined ? null : r }),
                (e) => this.answerError(env.id, e)
            );
        }
    }

    private answerError(id: number, e: any): void {
        this.send({ v: 1, t: "res", id, ok: false, e: { name: String(e?.name || "Error"), message: String(e?.message ?? e) } });
    }
}

// ---- adapters ----

/** a `chrome.runtime` port: JSON, so bytes travel packed */
export function portEndpoint(port: chrome.runtime.Port, opts?: EndpointOptions): Endpoint {
    const ep = new Endpoint((msg) => port.postMessage(packBytes(msg)), opts);
    port.onMessage.addListener((m: any) => ep.receive(unpackBytes(m)));
    port.onDisconnect.addListener(() => {
        void (globalThis as any).chrome?.runtime?.lastError;
        ep.close("the port disconnected");
    });
    return ep;
}

/** a `MessagePort` (structured clone: bytes as they are) */
export function messagePortEndpoint(mp: MessagePort, opts?: EndpointOptions): Endpoint {
    const ep = new Endpoint((msg) => mp.postMessage(msg), opts);
    mp.onmessage = (ev) => ep.receive(ev.data);
    return ep;
}

/** two connected endpoints in one context; delivery is async (a microtask) and cloned, like a real link */
export function endpointPair(opts?: EndpointOptions): [Endpoint, Endpoint] {
    const clone: (v: any) => any = typeof structuredClone === "function" ? structuredClone : (v) => JSON.parse(JSON.stringify(v));
    let a!: Endpoint;
    let b!: Endpoint;
    const deliver = (to: () => Endpoint) => (msg: WireMessage) => {
        const copy = clone(msg);
        queueMicrotask(() => to().receive(copy));
    };
    a = new Endpoint(deliver(() => b), opts);
    b = new Endpoint(deliver(() => a), opts);
    a.onClose((r) => b.close(r));
    b.onClose((r) => a.close(r));
    return [a, b];
}
