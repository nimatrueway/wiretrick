/**
 * A script's run lifecycle in one frame (docs/scripting.md, "Hot reload";
 * GLOSSARY: Run, Claim, Trampoline).
 *
 * Each compile of the script is a generation; each handler invocation is a
 * Run with its own `ctx.signal`. What a run sets up through `ctx.once`,
 * `ctx.patch`, `ctx.style` and `ctx.mount` is a claim on a key. On reload
 * the new run starts first; when it returns, the old run's signal aborts,
 * and once the new run settles (its promise too) the old run's claims are
 * released: keys the new run claimed again stay (a mount re-renders, a
 * patch swaps its implementation), the rest are torn down. A new run that
 * throws ends alone: the old one keeps running.
 *
 * A generation's handles (`Remote`s) call with its signal: it aborts once
 * a newer compile replaced it and none of its runs is alive.
 */
import { AbortError } from "./rpc";

export interface ReactDomClient {
    createRoot(el: Element): { render(node: unknown): void; unmount(): void };
}

export interface LifeOptions {
    doc: Document;
    /** `react-dom/client` for `ctx.mount` (throws when React isn't loaded); absent: no `ctx.mount` (onSite) */
    react?: () => ReactDomClient;
    /** mount hosts get a closed shadow root (default true; the overlay frame is isolated already) */
    shadow?: boolean;
    /** a teardown failed */
    onError?: (e: unknown) => void;
}

/** what a run adds to its handler's ctx */
export interface RunCtx {
    signal: AbortSignal;
    once<T>(key: string, fn: () => T): T;
    patch(obj: object, prop: PropertyKey, wrap: (orig: any) => any): void;
    style(css: string): void;
    mount?: (a: unknown, b?: unknown) => void;
    each<A extends any[], T>(fn: (...args: A) => Promise<T>, ...args: A): AsyncIterableIterator<T>;
}

export interface Generation {
    readonly signal: AbortSignal;
}

interface Gen extends Generation {
    ctl: AbortController;
    runs: Set<Run>;
    /** handlers this generation tried to run (a throw included: the old run is kept on purpose) */
    tried: Set<string>;
    ended: boolean;
    readonly signal: AbortSignal;
}

interface Run {
    h: string;
    gen: Gen;
    ctl: AbortController;
    claims: Set<string>;
    mounts: number;
    released: boolean;
}

interface Owner {
    claimers: Set<Run>;
    teardown(): void;
}

interface Trampoline {
    fn: (...args: any[]) => any;
    orig: (...args: any[]) => any;
    impl: (...args: any[]) => any;
    n: number;
}

interface Mount {
    host: Element;
    container: Element;
    root: { render(node: unknown): void; unmount(): void };
}

const isAbort = (e: any) => e?.name === "AbortError";

/** FNV-1a, for style keys */
function hash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ":" + s.length;
}

export class ScriptLife {
    private readonly owners = new Map<string, Owner>();
    private readonly current = new Map<string, Run>();
    private readonly gens = new Set<Gen>();
    private latest: Gen | null = null;
    private readonly tramps = new WeakMap<object, Map<string, Trampoline>>();
    private trampN = 0;
    /** ctx.style elements, mirrored into each mount's shadow root */
    private readonly styles = new Map<string, { css: string; els: Element[] }>();
    private readonly mounts = new Map<string, Mount>();
    private stopped = false;

    constructor(private readonly o: LifeOptions) {}

    /** a new compile; the previous one ends once none of its runs is alive */
    begin(): Generation {
        const ctl = new AbortController();
        const g: Gen = { ctl, runs: new Set(), tried: new Set(), ended: false, signal: ctl.signal };
        if (this.stopped) {
            g.ended = true;
            ctl.abort(new AbortError("the script stopped"));
        }
        this.gens.add(g);
        this.latest = g;
        return g;
    }

    /** the compile failed: the previous generation stays the live one */
    discard(gen: Generation): void {
        const g = gen as Gen;
        this.endGen(g, "the script didn't compile");
        if (this.latest === g) this.latest = [...this.gens].pop() ?? null;
    }

    /**
     * Run handler `h` of `gen`: `body` gets the ctx members and a reporter
     * for its async errors (aborts after the run ended are quiet). A sync
     * throw ends the new run alone and is rethrown.
     */
    fire(gen: Generation, h: string, report: (e: unknown) => void, body: (ctx: RunCtx, report: (e: unknown) => void) => unknown): void {
        const g = gen as Gen;
        // a handler scheduled by a generation that was replaced since
        if (g.ended || g !== this.latest) return;
        g.tried.add(h);
        const run: Run = { h, gen: g, ctl: new AbortController(), claims: new Set(), mounts: 0, released: false };
        g.runs.add(run);
        const quiet = (e: unknown) => {
            if (!(run.ctl.signal.aborted && isAbort(e))) report(e);
        };
        let out: unknown;
        try {
            out = body(this.ctxFor(run), quiet);
        } catch (e) {
            this.end(run, "the handler threw");
            this.release(run);
            throw e;
        }
        const old = this.current.get(h);
        this.current.set(h, run);
        if (!old) return;
        this.end(old, "the script reloaded");
        const release = () => this.release(old);
        if (out && typeof (out as any).then === "function") (out as Promise<unknown>).then(release, release);
        else release();
    }

    /** `gen` fired its due handlers: old runs of handlers it no longer has (or that don't match) end */
    commit(gen: Generation): void {
        const g = gen as Gen;
        if (g !== this.latest) return;
        for (const [h, run] of [...this.current])
            if (run.gen !== g && !g.tried.has(h)) {
                this.current.delete(h);
                this.end(run, "the script reloaded");
                this.release(run);
            }
        this.sweep();
    }

    /** the script stopped here (disabled, deleted, no longer matches): every run ends, every claim is torn down */
    stop(why = "the script stopped"): void {
        this.stopped = true;
        for (const run of [...this.current.values()]) {
            this.end(run, why);
            this.release(run);
        }
        this.current.clear();
        for (const g of [...this.gens]) this.endGen(g, why);
        for (const [k, o] of [...this.owners]) {
            this.owners.delete(k);
            this.teardown(o);
        }
    }

    /** the live run of handler `h` (tests) */
    runOf(h: string): { signal: AbortSignal } | undefined {
        const r = this.current.get(h);
        return r && { signal: r.ctl.signal };
    }

    private end(run: Run, why: string): void {
        if (!run.ctl.signal.aborted) run.ctl.abort(new AbortError(why));
        this.sweep();
    }

    /** a replaced generation with no live run ends: its handles' pending calls abort */
    private sweep(): void {
        for (const g of [...this.gens]) {
            if (g === this.latest) continue;
            if ([...g.runs].every((r) => r.ctl.signal.aborted)) this.endGen(g, "the script reloaded");
        }
    }

    private endGen(g: Gen, why: string): void {
        this.gens.delete(g);
        if (g.ended) return;
        g.ended = true;
        g.ctl.abort(new AbortError(why));
    }

    private release(run: Run): void {
        if (run.released) return;
        run.released = true;
        run.gen.runs.delete(run);
        for (const k of run.claims) {
            const o = this.owners.get(k);
            if (!o) continue;
            o.claimers.delete(run);
            if (o.claimers.size) continue;
            this.owners.delete(k);
            this.teardown(o);
        }
        run.claims.clear();
    }

    private teardown(o: Owner): void {
        try {
            o.teardown();
        } catch (e) {
            this.o.onError?.(e);
        }
    }

    /** `run` claims `key` (made by `create` the first time) */
    private claim<O extends Owner>(run: Run, key: string, create: () => O): O {
        const sig = run.ctl.signal;
        if (sig.aborted) throw sig.reason;
        let o = this.owners.get(key) as O | undefined;
        if (!o) {
            o = create();
            this.owners.set(key, o);
        }
        o.claimers.add(run);
        run.claims.add(key);
        return o;
    }

    private ctxFor(run: Run): RunCtx {
        const ctx: RunCtx = {
            signal: run.ctl.signal,
            once: (key, fn) => {
                if (typeof key !== "string") throw new TypeError("ctx.once: the key must be a string");
                if (typeof fn !== "function") throw new TypeError("ctx.once: the second argument must be a function");
                return this.claim(run, "once:" + key, () => ({ claimers: new Set<Run>(), value: fn(), teardown() {} })).value;
            },
            patch: (obj, prop, wrap) => this.patch(run, obj, prop, wrap),
            style: (css) => this.style(run, css),
            each: (fn, ...args) => each(run.ctl.signal, fn, args),
        };
        if (this.o.react) ctx.mount = (...args: unknown[]) => (args.length < 2 ? this.mount(run, undefined, args[0]) : this.mount(run, args[0] as any, args[1]));
        return ctx;
    }

    private patch(run: Run, obj: any, prop: PropertyKey, wrap: (orig: any) => any): void {
        if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) throw new TypeError("ctx.patch: the first argument must be an object");
        if (typeof wrap !== "function") throw new TypeError("ctx.patch: the third argument must be a function");
        const name = String(prop);
        let byProp = this.tramps.get(obj);
        if (!byProp) this.tramps.set(obj, (byProp = new Map()));
        // one trampoline per (object, property, handler): two handlers patching the same function each get a layer
        const tk = run.h + "\u0000" + (typeof prop === "symbol" ? prop.toString() : name);
        let t = byProp.get(tk);
        if (!t) {
            const orig = obj[prop];
            if (typeof orig !== "function") throw new TypeError(`ctx.patch: ${name} isn't a function`);
            const tr: Trampoline = {
                orig,
                impl: orig,
                n: ++this.trampN,
                fn: function (this: unknown, ...args: any[]) {
                    return new.target ? Reflect.construct(tr.impl, args, new.target === tr.fn ? tr.impl : new.target) : tr.impl.apply(this, args);
                },
            };
            // `x instanceof obj[prop]` keeps working
            if (orig.prototype) tr.fn.prototype = orig.prototype;
            try {
                Object.defineProperty(tr.fn, "name", { value: orig.name, configurable: true });
                Object.defineProperty(tr.fn, "length", { value: orig.length, configurable: true });
            } catch {}
            obj[prop] = tr.fn;
            if (obj[prop] !== tr.fn) throw new TypeError(`ctx.patch: ${name} can't be replaced (read-only)`);
            byProp.set(tk, (t = tr));
        }
        const tr = t;
        const impl = wrap(tr.orig);
        if (typeof impl !== "function") throw new TypeError("ctx.patch: the wrapper must return a function");
        // the trampoline stays installed (the site may hold it); unclaimed, it passes through
        this.claim(run, "patch:" + tr.n, () => ({ claimers: new Set<Run>(), teardown: () => void (tr.impl = tr.orig) }));
        tr.impl = impl;
    }

    private style(run: Run, css: string): void {
        if (typeof css !== "string") throw new TypeError("ctx.style: the argument must be a CSS string");
        const key = "style:" + hash(css);
        this.claim(run, key, () => {
            const doc = this.o.doc;
            const els = [this.styleEl(css)];
            (doc.head || doc.documentElement).appendChild(els[0]);
            const entry = { css, els };
            this.styles.set(key, entry);
            for (const m of this.mounts.values()) this.mirror(m, entry);
            return {
                claimers: new Set<Run>(),
                teardown: () => {
                    this.styles.delete(key);
                    for (const el of entry.els) el.remove();
                },
            };
        });
    }

    private styleEl(css: string): Element {
        const el = this.o.doc.createElement("style");
        el.textContent = css;
        return el;
    }

    private mirror(m: Mount, entry: { css: string; els: Element[] }): void {
        if (m.host === m.container) return;
        const el = this.styleEl(entry.css);
        entry.els.push(el);
        m.container.parentNode!.insertBefore(el, m.container);
    }

    private mount(run: Run, target: string | Element | undefined, jsx: unknown): void {
        if (target !== undefined && typeof target !== "string" && !isTarget(target)) throw new TypeError("ctx.mount: the target must be a selector or an element");
        const doc = this.o.doc;
        const shadow = this.o.shadow !== false;
        const at = typeof target === "string" ? doc.querySelector(target) : (target ?? (shadow ? doc.documentElement : doc.body || doc.documentElement));
        if (!at) throw new Error(`ctx.mount: nothing on the page matches "${target}"`);
        const key = "mount:" + run.h + (typeof target === "string" ? ":" + target : "#" + run.mounts++);
        let client: ReactDomClient;
        try {
            client = this.o.react!();
        } catch {
            throw new Error("ctx.mount needs React: write the UI with JSX (it loads the built-in React)");
        }
        this.claim(run, key, () => {
            let host: Element;
            let container: Element;
            if (shadow) {
                host = doc.createElement("wiretrick-mount");
                const root = host.attachShadow({ mode: "closed" });
                container = doc.createElement("div");
                root.appendChild(container);
                if (target === undefined) (host as HTMLElement).style.cssText = "all:initial;position:fixed;top:0;left:0;z-index:2147483646";
            } else host = container = doc.createElement("div");
            const m: Mount = { host, container, root: client.createRoot(container) };
            this.mounts.set(key, m);
            for (const entry of this.styles.values()) this.mirror(m, entry);
            return {
                claimers: new Set<Run>(),
                teardown: () => {
                    this.mounts.delete(key);
                    try {
                        m.root.unmount();
                    } finally {
                        host.remove();
                    }
                },
            };
        });
        const m = this.mounts.get(key)!;
        // the page re-rendered the target (or dropped the host): put it back
        if (m.host.parentNode !== at) at.appendChild(m.host);
        m.root.render(jsx);
    }
}

function isTarget(v: unknown): v is Element {
    return !!v && typeof v === "object" && (v as any).nodeType === 1;
}

/**
 * `for await (const x of ctx.each(site.next))`: call `fn` again after
 * each answer; a call cut by the callee's reload (ReloadedError) is made
 * again, and the loop ends quietly when the run ends.
 */
async function* each<T>(signal: AbortSignal, fn: (...args: any[]) => Promise<T>, args: any[]): AsyncGenerator<T> {
    if (typeof fn !== "function") throw new TypeError("ctx.each: the first argument must be a function (a handle's)");
    while (!signal.aborted) {
        let v: T;
        try {
            v = await untilAborted(fn(...args), signal);
        } catch (e: any) {
            if (signal.aborted) return;
            if (e?.name === "ReloadedError") continue;
            throw e;
        }
        yield v;
    }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(p).then(
            (v) => {
                signal.removeEventListener("abort", onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener("abort", onAbort);
                reject(e);
            }
        );
    });
}
