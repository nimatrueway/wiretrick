/**
 * Calls between a script's overlay and its onPage code (`await
 * page.highlight("a")`, `overlay.picked(tag)`), shared by the overlay
 * runtime, the bridge's isolated-world runtime and the main-world hook.
 *
 * The caller side is an `RpcClient`: each handle (`"onSite:0"`, the
 * script's first wt.onSite call; `"onOverlay:1"`, its second wt.onOverlay
 * one) is a Proxy whose properties are async functions. A call sends `{ cid,
 * h, fn, args }` and waits — with no time limit — for the `{ cid, ok, value |
 * error }` with the same `cid`. When the caller's run ends first, the call
 * rejects with AbortError and a cancel (the same `cid`, `fn` = CANCEL_FN)
 * goes the same way, so the callee drops it.
 *
 * The callee side is an `Exposer`: a handler's return value is what it
 * exposes (a plain object's own functions; anything else exposes
 * nothing). Until the handler has returned, calls queue (at most 100 per
 * handle), also across a reload of the script; a handler that won't run
 * here (its route didn't match, it threw) answers `not running on this
 * page`. A call still running when the script reloads rejects with
 * ReloadedError (call again: the new run answers).
 *
 * Arguments and results are JSON, ≤ 1 MB, checked on both sides; a callee
 * error crosses as its message only.
 */
import type { Json } from "./wire";
import { badValue, isPlainObject, jsonBytes } from "./storeOps";

export const RPC_QUEUE_MAX = 100;
export const RPC_MAX_BYTES = 1024 * 1024;

export const NOT_RUNNING = "not running on this page";
export const NO_SUCH_FUNCTION = "no such function";
export const TOP_FRAME_ONLY = "only the top frame can call the overlay";
export const NO_PAGE_IN_PREVIEW = "there's no page in the Editor preview: onPage code doesn't run there";

/** a call's `fn` that cancels the call with the same `cid` (no function has this name) */
export const CANCEL_FN = "\u0000cancel";

/** the caller's run ended (the script reloaded, or the page navigated) before the answer */
export class AbortError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AbortError";
    }
}

/** the callee's script reloaded while the call ran: call again, the new run answers */
export class ReloadedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReloadedError";
    }
}

/** the callee threw (its message only), has no such function, or isn't running */
export class WtCallError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WtCallError";
    }
}

/** the other side went away (the overlay reloaded or closed) before answering */
export class DisconnectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DisconnectedError";
    }
}

export interface RpcCall {
    cid: string;
    h: string;
    fn: string;
    args: Json[];
}

export interface RpcResult {
    cid: string;
    ok: boolean;
    value?: Json;
    error?: { name: string; message: string };
}

/** a random 128-bit call id */
export function newCid(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** is this a well-formed call (anything may arrive over postMessage)? */
export function isRpcCall(c: any): c is RpcCall {
    return !!c && typeof c === "object" && typeof c.cid === "string" && typeof c.h === "string" && typeof c.fn === "string" && Array.isArray(c.args);
}

/** is this a well-formed result within the size limit? */
export function isRpcResult(r: any): r is RpcResult {
    if (!r || typeof r !== "object" || typeof r.cid !== "string" || typeof r.ok !== "boolean") return false;
    if (!r.ok && (!r.error || typeof r.error.message !== "string")) return false;
    return jsonBytes(r) <= RPC_MAX_BYTES + 1024;
}

/** `args` as JSON; throws a TypeError at the caller when they aren't */
export function toJsonArgs(fn: string, args: unknown[]): Json[] {
    const out = args.map((a) => (a === undefined ? null : a)) as Json[];
    const bad = badValue(out);
    if (bad) throw new TypeError(`${fn}(): arguments must be JSON — ${bad}`);
    const json = JSON.stringify(out);
    if (json.length > RPC_MAX_BYTES) throw new TypeError(`${fn}(): arguments are larger than 1 MB`);
    // a plain copy: a store's object (a Proxy) can't be posted
    return JSON.parse(json);
}

const callError = (message: string): RpcResult["error"] => ({ name: "WtCallError", message });

/** an error from a result, as the caller sees it */
export function resultError(e: RpcResult["error"]): Error {
    const msg = String(e?.message ?? "error");
    if (e?.name === "DisconnectedError") return new DisconnectedError(msg);
    if (e?.name === "AbortError") return new AbortError(msg);
    if (e?.name === "ReloadedError") return new ReloadedError(msg);
    return new WtCallError(msg);
}

type Pending = { h: string; fn: string; resolve: (v: any) => void; reject: (e: Error) => void; unlisten?: () => void };

/** the caller side: handles and pending calls */
export class RpcClient {
    private readonly pending = new Map<string, Pending>();

    constructor(private readonly send: (call: RpcCall) => void) {}

    /** the handle for `h`: every string property is an async function; `signal()` is the calling run's (its end aborts the call) */
    remote(h: string, signal?: () => AbortSignal | undefined): any {
        return new Proxy(Object.create(null), {
            get: (_t, prop) => {
                // not a thenable (`await handle` must not hang), no symbol methods
                if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
                return (...args: unknown[]) => this.call(h, prop, args, signal?.());
            },
            set: () => false,
        });
    }

    /** call `fn` on handle `h`; non-JSON arguments throw right here. `signal` aborting rejects the call with AbortError and cancels it. */
    call(h: string, fn: string, args: unknown[], signal?: AbortSignal): Promise<any> {
        const json = toJsonArgs(fn, args);
        if (signal?.aborted) return Promise.reject(new AbortError(`${fn}(): ${abortReason(signal)}`));
        const cid = newCid();
        return new Promise((resolve, reject) => {
            const p: Pending = { h, fn, resolve, reject };
            if (signal) {
                const onAbort = () => this.cancel(cid, abortReason(signal));
                signal.addEventListener("abort", onAbort);
                p.unlisten = () => signal.removeEventListener("abort", onAbort);
            }
            this.pending.set(cid, p);
            try {
                this.send({ cid, h, fn, args: json });
            } catch (e: any) {
                this.pending.delete(cid);
                p.unlisten?.();
                reject(new DisconnectedError(`${fn}(): ${e?.message || e}`));
            }
        });
    }

    /** the caller's run ended: reject pending calls (all, or those whose handle `which` accepts) with AbortError and cancel them */
    abort(reason: string, which?: (h: string) => boolean): void {
        for (const [cid, p] of [...this.pending]) if (!which || which(p.h)) this.cancel(cid, reason);
    }

    private cancel(cid: string, reason: string): void {
        const p = this.pending.get(cid);
        if (!p) return;
        this.pending.delete(cid);
        p.unlisten?.();
        p.reject(new AbortError(`${p.fn}(): ${reason}`));
        try {
            this.send({ cid, h: p.h, fn: CANCEL_FN, args: [] });
        } catch {}
    }

    /** a result arrived; unknown or settled `cid`s are dropped. Returns whether it was ours. */
    receive(r: unknown): boolean {
        if (!isRpcResult(r)) return false;
        const p = this.pending.get(r.cid);
        if (!p) return false;
        this.pending.delete(r.cid);
        p.unlisten?.();
        if (r.ok) p.resolve(r.value);
        else p.reject(resultError(r.error));
        return true;
    }

    /** reject pending calls (all, or those whose handle `which` accepts) with DisconnectedError */
    disconnect(reason: string, which?: (h: string) => boolean): void {
        for (const [cid, p] of this.pending) {
            if (which && !which(p.h)) continue;
            this.pending.delete(cid);
            p.unlisten?.();
            p.reject(new DisconnectedError(reason));
        }
    }
}

function abortReason(signal: AbortSignal): string {
    const r = signal.reason;
    return typeof r === "string" ? r : r instanceof Error && r.name !== "AbortError" ? r.message : "the calling run ended";
}

/** the call whose function is running right now (synchronously): its signal aborts on cancel or reload */
let running: AbortSignal | undefined;
/** inside an exposed function (its synchronous part): the call's signal — aborted when the caller cancels or this script reloads */
export function callSignal(): AbortSignal | undefined {
    return running;
}

type Reply = (r: RpcResult) => void;
type Slot = { state: "pending"; queue: [RpcCall, Reply][] } | { state: "ready"; obj: Record<string, any> | null } | { state: "not-running"; why: string };

/** the callee side: one script's handles in one runtime */
export class Exposer {
    private readonly slots = new Map<string, Slot>();
    /** the ready handles before the last `reset` (a failed reload goes back to them) */
    private prev = new Map<string, Slot>();
    /** calls for handles not registered yet (the script hasn't compiled) */
    private early: [RpcCall, Reply][] = [];
    private settled = false;
    /** calls whose function is running (its promise pending) */
    private readonly inflight = new Map<string, { reply: Reply; ctl: AbortController }>();

    /** a handler registered; its calls queue until `expose` / `fail` */
    register(h: string): void {
        const old = this.slots.get(h);
        this.slots.set(h, { state: "pending", queue: old?.state === "pending" ? old.queue : [] });
    }

    /** the handler returned `value` (awaited when it's a Promise) */
    expose(h: string, value: unknown): void {
        if (value && typeof (value as any).then === "function") {
            (value as Promise<unknown>).then(
                (v) => this.expose(h, v),
                () => this.fail(h)
            );
            return;
        }
        const obj = isPlainObject(value) ? (value as Record<string, any>) : null;
        this.settle(h, { state: "ready", obj });
    }

    /** the handler won't answer here (didn't match, threw) */
    fail(h: string, why = NOT_RUNNING): void {
        this.settle(h, { state: "not-running", why });
    }

    /**
     * The reload of `h` failed (its handler threw; no `h`: the script didn't
     * compile): it answers from the run that's still alive, when it had one
     */
    revert(h?: string): void {
        for (const k of h === undefined ? new Set([...this.slots.keys(), ...this.prev.keys()]) : [h]) {
            const p = this.prev.get(k);
            if (p) this.settle(k, p);
            else this.fail(k);
        }
    }

    /** every handle is registered: calls for unknown ones answer `not running` */
    done(): void {
        this.settled = true;
        const early = this.early;
        this.early = [];
        for (const [c, reply] of early) this.answer(c, reply);
    }

    /** the script is recompiling (hot reload): handles register again. Waiting calls wait for the new run; running ones reject with ReloadedError. */
    reset(): void {
        this.prev = new Map([...this.slots].filter(([, s]) => s.state === "ready"));
        for (const s of this.slots.values()) if (s.state === "pending") this.early.push(...s.queue);
        this.slots.clear();
        this.settled = false;
        for (const [cid, f] of [...this.inflight]) {
            this.inflight.delete(cid);
            f.ctl.abort("the script reloaded");
            f.reply({ cid, ok: false, error: { name: "ReloadedError", message: "the script reloaded while the call ran: call again" } });
        }
    }

    /** the script stopped here (disabled, deleted, the page went away): every call answers `why` */
    close(why = NOT_RUNNING): void {
        this.reset();
        this.prev.clear();
        for (const [c, reply] of this.early.splice(0)) reply({ cid: c.cid, ok: false, error: callError(why) });
        this.settled = true;
    }

    /** is `h` a handle this runtime has (in any state)? */
    has(h: string): boolean {
        return this.slots.has(h);
    }

    /** answer a call (now, or once its handler has returned) */
    answer(c: RpcCall, reply: Reply): void {
        if (c.fn === CANCEL_FN) return this.cancel(c, reply);
        const slot = this.slots.get(c.h);
        if (!slot) {
            if (this.settled) return reply({ cid: c.cid, ok: false, error: callError(NOT_RUNNING) });
            if (this.early.length >= RPC_QUEUE_MAX) return reply({ cid: c.cid, ok: false, error: callError(`${c.fn}(): too many calls waiting for the page`) });
            this.early.push([c, reply]);
            return;
        }
        if (slot.state === "not-running") return reply({ cid: c.cid, ok: false, error: callError(slot.why) });
        if (slot.state === "pending") {
            if (slot.queue.length >= RPC_QUEUE_MAX) return reply({ cid: c.cid, ok: false, error: callError(`${c.fn}(): too many calls waiting for the handler to return`) });
            slot.queue.push([c, reply]);
            return;
        }
        const obj = slot.obj;
        const fn = obj && Object.prototype.hasOwnProperty.call(obj, c.fn) ? obj[c.fn] : undefined;
        if (typeof fn !== "function") return reply({ cid: c.cid, ok: false, error: callError(`${NO_SUCH_FUNCTION}: ${c.fn}`) });
        const ctl = new AbortController();
        let out: unknown;
        const outer = running;
        running = ctl.signal;
        try {
            out = fn.apply(obj, c.args);
        } catch (e: any) {
            return reply({ cid: c.cid, ok: false, error: callError(errorMessage(e)) });
        } finally {
            running = outer;
        }
        const f = { reply, ctl };
        this.inflight.set(c.cid, f);
        const done = (r: RpcResult) => {
            if (this.inflight.get(c.cid) !== f) return;
            this.inflight.delete(c.cid);
            reply(r);
        };
        Promise.resolve(out).then(
            (v) => done(okResult(c, v)),
            (e) => done({ cid: c.cid, ok: false, error: callError(errorMessage(e)) })
        );
    }

    /** the caller gave up on call `c.cid`: drop it (queued or running) and answer AbortError, which also clears relays */
    private cancel(c: RpcCall, reply: Reply): void {
        const drop = (q: [RpcCall, Reply][]) => {
            const i = q.findIndex(([x]) => x.cid === c.cid);
            if (i >= 0) q.splice(i, 1);
        };
        drop(this.early);
        for (const s of this.slots.values()) if (s.state === "pending") drop(s.queue);
        const f = this.inflight.get(c.cid);
        if (f) {
            this.inflight.delete(c.cid);
            f.ctl.abort("the caller gave up");
        }
        reply({ cid: c.cid, ok: false, error: { name: "AbortError", message: "the caller gave up" } });
    }

    private settle(h: string, next: Slot): void {
        const old = this.slots.get(h);
        this.slots.set(h, next);
        if (old?.state === "pending") for (const [c, reply] of old.queue) this.answer(c, reply);
    }
}

function errorMessage(e: any): string {
    return String(e && typeof e === "object" && "message" in e ? e.message : e);
}

function okResult(c: RpcCall, v: unknown): RpcResult {
    if (v === undefined) return { cid: c.cid, ok: true };
    const bad = badValue(v);
    if (bad) return { cid: c.cid, ok: false, error: callError(`${c.fn}(): the result must be JSON — ${bad}`) };
    const json = JSON.stringify(v);
    if (json.length > RPC_MAX_BYTES) return { cid: c.cid, ok: false, error: callError(`${c.fn}(): the result is larger than 1 MB`) };
    return { cid: c.cid, ok: true, value: JSON.parse(json) };
}
