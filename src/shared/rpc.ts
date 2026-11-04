/**
 * Calls between a script's overlay and its onPage code (`await
 * page.highlight("a")`, `overlay.picked(tag)`), shared by the overlay
 * runtime, the bridge's isolated-world runtime and the main-world hook.
 *
 * The caller side is an `RpcClient`: each handle (`"page:0"`, the script's
 * first onPage registration; `"overlay:1"`, its second onOverlay one) is a
 * Proxy whose properties are async functions. A call sends `{ cid, h, fn,
 * args }` and waits up to 10 s for the `{ cid, ok, value | error }` with
 * the same `cid`.
 *
 * The callee side is an `Exposer`: a handler's return value is what it
 * exposes (a plain object's own functions; anything else exposes
 * nothing). Until the handler has returned, calls queue (at most 100 per
 * handle); a handler that won't run here (its route didn't match, it
 * threw, it's for the other world) answers `not running on this page`.
 *
 * Arguments and results are JSON, ≤ 1 MB, checked on both sides; a callee
 * error crosses as its message only.
 */
import type { Json } from "./wire";
import { badValue, isPlainObject, jsonBytes } from "./storeOps";

export const RPC_TIMEOUT_MS = 10_000;
export const RPC_QUEUE_MAX = 100;
export const RPC_MAX_BYTES = 1024 * 1024;

export const NOT_RUNNING = "not running on this page";
export const NO_SUCH_FUNCTION = "no such function";
export const TOP_FRAME_ONLY = "only the top frame can call the overlay";

/** the callee didn't answer in time */
export class WtTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WtTimeoutError";
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
    if (jsonBytes(out) > RPC_MAX_BYTES) throw new TypeError(`${fn}(): arguments are larger than 1 MB`);
    return out;
}

const callError = (message: string): RpcResult["error"] => ({ name: "WtCallError", message });

/** an error from a result, as the caller sees it */
export function resultError(e: RpcResult["error"]): Error {
    const msg = String(e?.message ?? "error");
    if (e?.name === "WtTimeoutError") return new WtTimeoutError(msg);
    if (e?.name === "DisconnectedError") return new DisconnectedError(msg);
    return new WtCallError(msg);
}

/** the caller side: handles and pending calls */
export class RpcClient {
    private readonly pending = new Map<string, { h: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    constructor(
        private readonly send: (call: RpcCall) => void,
        private readonly opts: { timeoutMs?: number } = {}
    ) {}

    /** the handle for `h`: every string property is an async function */
    remote(h: string): any {
        return new Proxy(Object.create(null), {
            get: (_t, prop) => {
                // not a thenable (`await handle` must not hang), no symbol methods
                if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
                return (...args: unknown[]) => this.call(h, prop, args);
            },
            set: () => false,
        });
    }

    /** call `fn` on handle `h`; non-JSON arguments throw right here */
    call(h: string, fn: string, args: unknown[]): Promise<any> {
        const json = toJsonArgs(fn, args);
        const cid = newCid();
        return new Promise((resolve, reject) => {
            const ms = this.opts.timeoutMs ?? RPC_TIMEOUT_MS;
            const timer = setTimeout(() => {
                this.pending.delete(cid);
                reject(new WtTimeoutError(`${fn}(): no answer within ${Math.round(ms / 1000)} s`));
            }, ms);
            this.pending.set(cid, { h, resolve, reject, timer });
            try {
                this.send({ cid, h, fn, args: json });
            } catch (e: any) {
                clearTimeout(timer);
                this.pending.delete(cid);
                reject(new DisconnectedError(`${fn}(): ${e?.message || e}`));
            }
        });
    }

    /** a result arrived; unknown or settled `cid`s are dropped. Returns whether it was ours. */
    receive(r: unknown): boolean {
        if (!isRpcResult(r)) return false;
        const p = this.pending.get(r.cid);
        if (!p) return false;
        this.pending.delete(r.cid);
        clearTimeout(p.timer);
        if (r.ok) p.resolve(r.value);
        else p.reject(resultError(r.error));
        return true;
    }

    /** reject pending calls (all, or those whose handle `which` accepts) with DisconnectedError */
    disconnect(reason: string, which?: (h: string) => boolean): void {
        for (const [cid, p] of this.pending) {
            if (which && !which(p.h)) continue;
            this.pending.delete(cid);
            clearTimeout(p.timer);
            p.reject(new DisconnectedError(reason));
        }
    }
}

type Reply = (r: RpcResult) => void;
type Slot = { state: "pending"; queue: [RpcCall, Reply][] } | { state: "ready"; obj: Record<string, any> | null } | { state: "not-running"; why: string; elsewhere?: boolean };

/** the callee side: one script's handles in one runtime */
export class Exposer {
    private readonly slots = new Map<string, Slot>();
    /** calls for handles not registered yet (the script hasn't compiled) */
    private early: [RpcCall, Reply][] = [];
    private settled = false;

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

    /** the handler belongs to the other world: a router may try there */
    elsewhere(h: string, why = NOT_RUNNING): void {
        this.settle(h, { state: "not-running", why, elsewhere: true });
    }

    /** is `h` registered for the other world? */
    isElsewhere(h: string): boolean {
        const s = this.slots.get(h);
        return s?.state === "not-running" && !!s.elsewhere;
    }

    /** every handle is registered: calls for unknown ones answer `not running` */
    done(): void {
        this.settled = true;
        const early = this.early;
        this.early = [];
        for (const [c, reply] of early) this.answer(c, reply);
    }

    /** the script is recompiling (hot reload): handles register again */
    reset(): void {
        for (const s of this.slots.values()) if (s.state === "pending") for (const [c, reply] of s.queue) reply({ cid: c.cid, ok: false, error: { name: "DisconnectedError", message: "the script reloaded" } });
        this.slots.clear();
        this.settled = false;
    }

    /** is `h` a handle this runtime has (in any state)? */
    has(h: string): boolean {
        return this.slots.has(h);
    }

    /** answer a call (now, or once its handler has returned) */
    answer(c: RpcCall, reply: Reply): void {
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
        let out: unknown;
        try {
            out = fn.apply(obj, c.args);
        } catch (e: any) {
            return reply({ cid: c.cid, ok: false, error: callError(errorMessage(e)) });
        }
        Promise.resolve(out).then(
            (v) => reply(okResult(c, v)),
            (e) => reply({ cid: c.cid, ok: false, error: callError(errorMessage(e)) })
        );
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
    if (jsonBytes(v) > RPC_MAX_BYTES) return { cid: c.cid, ok: false, error: callError(`${c.fn}(): the result is larger than 1 MB`) };
    return { cid: c.cid, ok: true, value: v as Json };
}
