/**
 * `ctx.evaluate(fn, ...args)` for isolated onPage code: run `fn` in the
 * page's own JavaScript world and get back what it returns. The MAIN-world
 * hook (hook.ts, `servePageEvaluate`) compiles `fn`'s source and runs it.
 * Request and answer are window messages the page can see and forge, so
 * `fn` gets only the page's own powers (its CSP still applies) and the
 * answer is untrusted data. Arguments and results are structured clones,
 * except functions (also inside plain objects and arrays): `fn` gets
 * stand-ins that call them back here (for as long as the document lives),
 * with copied, untrusted arguments. The other way round, functions in what
 * `fn` returns (also inside plain objects and arrays) come back as async
 * stand-ins that call them in the page (`invoke`), for as long as the
 * document lives.
 *
 * What `fn` uses from the script's top level (its imports, helpers,
 * constants: shared/evalCapture) comes along: the run message carries
 * those declarations (`prelude`) and, once per module version, the
 * libraries they import, and the page re-creates them around `fn`. There
 * `wt` and `console` are the script's (logs go to its Log).
 */
import type { EvalCapture } from "./evalCapture";
import type { ShippedLib } from "./scriptImports";

export const PAGE_EVAL = "wt-page-eval";
/** marks a function argument in the run message: its index among the call's callbacks */
const PAGE_EVAL_FN = "wt-page-eval-fn";
/** marks a function in a result: its index among the call's returned functions */
const PAGE_EVAL_RET = "wt-page-eval-ret";
/** the hook acknowledges at once; no ack: it isn't in this frame */
export const PAGE_EVAL_ACK_MS = 3000;

const CSP_BLOCKED = /a string as JavaScript|unsafe-eval/i;

const isPlain = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== "object") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
};

/** a function to mark, and the object it was found on (its `this` when called) */
interface Marked {
    fn: Function;
    self: unknown;
}

/** `v` with its functions (also in plain objects and arrays) swapped for `key` markers into `fns` */
function markFunctions(v: unknown, fns: Marked[], key: string, self?: unknown, seen = new Map<object, unknown>()): unknown {
    if (typeof v === "function") return { [key]: fns.push({ fn: v, self }) - 1 };
    if (!Array.isArray(v) && !isPlain(v)) return v;
    if (seen.has(v)) return seen.get(v);
    const out: any = Array.isArray(v) ? [] : {};
    seen.set(v, out);
    for (const k of Object.keys(v)) out[k] = markFunctions((v as any)[k], fns, key, v, seen);
    return out;
}

/** `v` with its `key` markers (also in plain objects and arrays, in place) → `stub(index)` */
function unmarkFunctions(v: unknown, key: string, stub: (fn: number) => Function, seen = new Set<object>()): unknown {
    if (!Array.isArray(v) && !isPlain(v)) return v;
    if (typeof (v as any)[key] === "number" && Object.keys(v).length === 1) return stub((v as any)[key]);
    if (seen.has(v)) return v;
    seen.add(v);
    for (const k of Object.keys(v)) (v as any)[k] = unmarkFunctions((v as any)[k], key, stub, seen);
    return v;
}

export type PageEvaluate = (fn: unknown, ...args: unknown[]) => Promise<unknown>;

/** whose `wt` and `console` page-world code gets: a script's, or (scriptId null) one of its libraries' */
export interface EvalWho {
    scriptId: string | null;
    name: string;
    params: Record<string, any>;
}

/** a running script's module, for its `ctx.evaluate` calls: what their functions take along to the page */
export interface EvalModule {
    /** new for each version of the script's code (a hot update) */
    key: string;
    scriptId: string;
    name: string;
    params: Record<string, any>;
    libs: ShippedLib[];
    /** a function's source → its capture, and whose module it's in */
    evals: Map<string, { prelude: string; libs?: true; importer: string; who: EvalWho }>;
}

let moduleSeq = 0;
/** `scriptId`'s module, from its code's captures (`evals`) and its libraries' */
export function evalModule(scriptId: string, name: string, params: Record<string, any> | undefined, evals: EvalCapture[] | undefined, libs: ShippedLib[]): EvalModule {
    const m: EvalModule = { key: `${Math.random().toString(36).slice(2)}:${++moduleSeq}`, scriptId, name, params: params || {}, libs, evals: new Map() };
    const add = (caps: EvalCapture[] | undefined, importer: string, who: EvalWho) => {
        for (const c of caps || []) if (!m.evals.has(c.fn)) m.evals.set(c.fn, { prelude: c.prelude, ...(c.libs ? { libs: true as const } : {}), importer, who });
    };
    add(evals, name, { scriptId, name, params: m.params });
    for (const l of libs) if (l.evals?.length) add(l.evals, l.name, { scriptId: null, name: l.name, params: l.params || {} });
    return m;
}

/** page-world code: `fn` is already where it should run */
export const directEvaluate: PageEvaluate = async (fn, ...args) => {
    if (typeof fn !== "function") throw new TypeError("ctx.evaluate: pass a function, e.g. ctx.evaluate(() => document.title)");
    return fn(...args);
};

/**
 * isolated code: ask the page world (the hook) to run `fn`. `report` gets
 * the script's errors nothing else would show: a callback that throws, a
 * callback the page side couldn't call (its arguments aren't plain data)
 * and a rejection the script left unhandled.
 */
export function makePageEvaluate(win: Window = window, ackMs = PAGE_EVAL_ACK_MS, report?: (e: Error) => void, module?: () => EvalModule | undefined): PageEvaluate {
    let seq = 0;
    /** module versions whose libraries the page has */
    const libsSent = new Set<string>();
    /** what `fn` takes along to the page (with its libraries, the first time they're needed) */
    const modOf = (src: string) => {
        const m = module?.();
        if (!m) return undefined;
        const cap = m.evals.get(src);
        const withLibs = !!cap?.libs && !libsSent.has(m.key);
        return {
            key: m.key,
            owner: m.scriptId,
            who: cap?.who || { scriptId: m.scriptId, name: m.name, params: m.params },
            importer: cap?.importer ?? m.name,
            prelude: cap?.prelude ?? "",
            ...(withLibs ? { libs: m.libs.map(({ evals, ...l }) => l) } : {}),
        };
    };
    const tag = Math.random().toString(36).slice(2);
    /** this script's rejections: reported when it doesn't handle them */
    const ours = new WeakSet<object>();
    if (report)
        win.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
            if (!e.reason || typeof e.reason !== "object" || !ours.has(e.reason)) return;
            e.preventDefault();
            report(e.reason);
        });
    const callBack = (cb: Function, args: unknown[]): void => {
        try {
            const out = cb(...args);
            if (report && out && typeof (out as any).then === "function") (out as Promise<unknown>).then(undefined, (e: any) => report(e instanceof Error ? e : new Error(String(e))));
        } catch (e: any) {
            if (!report) throw e;
            report(e instanceof Error ? e : new Error(String(e)));
        }
    };
    /** an error whose stack points at the script's call (`site`), not at Wiretrick's code */
    const errorAt = (site: string, message: string, name = "Error"): Error => {
        const err = name === "TypeError" ? new TypeError(message) : new Error(message);
        err.name = name;
        const nl = site.indexOf("\n");
        if (nl >= 0) err.stack = `${name}: ${message}${site.slice(nl)}`;
        return err;
    };
    /** a rejection the script may leave unhandled: reported */
    const own = <T>(p: Promise<T>): Promise<T> =>
        report
            ? p.catch((e) => {
                  const err = e instanceof Error ? e : new Error(String(e));
                  ours.add(err);
                  throw err;
              })
            : p;
    const evaluate: PageEvaluate = (fn, ...args) => {
        // the script's call: errors made here point at it, not at Wiretrick's code
        const site = String(new Error().stack || "");
        const fail = (message: string, name = "Error"): Error => errorAt(site, message, name);
        if (typeof fn !== "function") return Promise.reject(fail("ctx.evaluate: pass a function, e.g. ctx.evaluate(() => document.title)", "TypeError"));
        const id = `${tag}:${++seq}`;
        const marked: Marked[] = [];
        const sent = markFunctions(args, marked, PAGE_EVAL_FN);
        // (the call's callbacks: also those passed to its returned functions later)
        const callbacks = marked;
        /** the returned functions' calls waiting for their answers */
        const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; site: string }>();
        let invokes = 0;
        let returnsFns = false;
        /** a function `fn` returned (`index` among them): calling it calls it in the page */
        const stand = (index: number) => {
            returnsFns = true;
            return (...xs: unknown[]): Promise<unknown> => {
                const site = String(new Error().stack || "");
                return own(
                    new Promise((resolve, reject) => {
                        const cid = ++invokes;
                        try {
                            win.postMessage({ source: PAGE_EVAL, kind: "invoke", id, fn: index, cid, args: markFunctions(xs, callbacks, PAGE_EVAL_FN) }, "*");
                            pending.set(cid, { resolve, reject, site });
                        } catch (e: any) {
                            reject(errorAt(site, `ctx.evaluate: a returned function's arguments must be plain data (${e?.message || e})`, "TypeError"));
                        }
                    })
                );
            };
        };
        const unmarkResult = (v: unknown) => unmarkFunctions(v, PAGE_EVAL_RET, stand);
        let settled = false;
        return new Promise((resolve, reject) => {
            let acked = false;
            const end = (keep = false) => {
                clearTimeout(timer);
                // callbacks and returned functions stay callable after fn returns (e.g. from a page event listener)
                if (!keep) win.removeEventListener("message", onMessage);
            };
            // a page busy past ackMs (a long script) delays the ack, and the browser may run
            // this timer first: a probe sent through the same message queue, twice, comes back
            // after any ack the hook already sent, so only a hook that isn't there fails
            const probe = (hop: number) => win.postMessage({ source: PAGE_EVAL, kind: "probe", id, hop }, "*");
            const timer = setTimeout(() => {
                if (!acked) probe(1);
            }, ackMs);
            const onMessage = (e: MessageEvent) => {
                const d = e.data;
                if (e.source !== win || !d || d.source !== PAGE_EVAL || d.id !== id) return;
                if (d.kind === "probe") {
                    if (acked) return;
                    if (d.hop === 1) return probe(2);
                    end();
                    reject(fail("ctx.evaluate: nothing in the page world answered, so the function didn't run: Wiretrick's page hook isn't in this frame (the page may block it)"));
                    return;
                }
                if (d.kind === "ack") acked = true;
                if (d.kind === "call") {
                    const cb = callbacks[d.fn]?.fn;
                    if (typeof cb === "function" && Array.isArray(d.args)) callBack(cb, d.args);
                    return;
                }
                if (d.kind === "callError") {
                    if (report && typeof callbacks[d.fn]?.fn === "function") report(new TypeError(String(d.message)));
                    return;
                }
                if (d.kind === "invoked") {
                    const p = pending.get(d.cid);
                    if (!p) return;
                    pending.delete(d.cid);
                    if (d.ok) p.resolve(unmarkResult(d.value));
                    else p.reject(errorAt(p.site, String(d.error?.message ?? "ctx.evaluate: the returned function failed"), String(d.error?.name || "Error")));
                    return;
                }
                if (d.kind !== "done" || settled) return;
                settled = true;
                const value = d.ok ? unmarkResult(d.value) : undefined;
                end(d.ok && (callbacks.length > 0 || returnsFns));
                if (d.ok) resolve(value);
                else reject(fail(String(d.error?.message ?? "ctx.evaluate failed"), String(d.error?.name || "Error")));
            };
            win.addEventListener("message", onMessage);
            try {
                const src = String(fn);
                const mod = modOf(src);
                win.postMessage({ source: PAGE_EVAL, kind: "run", id, src, args: sent, ...(mod ? { mod } : {}) }, "*");
                if (mod?.libs) libsSent.add(mod.key);
            } catch (e: any) {
                end();
                reject(fail(`ctx.evaluate: arguments must be plain data (${e?.message || e})`, "TypeError"));
            }
        });
    };
    return (fn, ...args) => own(evaluate(fn, ...args));
}

/** what the page world gives isolated code's functions: the script's `wt` and `console`, and `require` over its libraries */
export interface PageEvalEnv {
    wt: (who: EvalWho) => any;
    console: (who: EvalWho) => any;
    /** `requireFrom(importer)` over `libs` (run once each) */
    libRequire: (libs: ShippedLib[]) => (importer: string) => (spec: string) => any;
}

interface ModuleEntry {
    owner: string;
    libs?: ShippedLib[];
    requireFrom?: (importer: string) => (spec: string) => any;
    /** per who: its wt and console */
    apis: Map<string, { wt: any; console: any }>;
}

const noRequire = (spec: string) => {
    throw new Error(`ctx.evaluate: cannot import "${spec}" in the page world: its libraries didn't come along`);
};

/** the page-world side (the hook): run what isolated code asks for */
export function servePageEvaluate(win: Window = window, env?: PageEvalEnv): void {
    const modules = new Map<string, ModuleEntry>();
    /** `d.mod`'s entry; a module's new version drops its old ones */
    const entryOf = (mod: any): ModuleEntry | undefined => {
        if (!mod || typeof mod.key !== "string") return undefined;
        let m = modules.get(mod.key);
        if (!m) {
            for (const [k, o] of modules) if (o.owner === mod.owner) modules.delete(k);
            modules.set(mod.key, (m = { owner: String(mod.owner), apis: new Map() }));
        }
        if (Array.isArray(mod.libs) && !m.libs) m.libs = mod.libs;
        return m;
    };
    /** per call: the functions its results returned (callable for as long as the document lives) */
    const returned = new Map<string, Marked[]>();
    /** what a failure says to the script */
    const errorOf = (err: any) => {
        const undef = err?.name === "ReferenceError" && /^([\w$]+) is not defined$/.exec(String(err?.message));
        const message = CSP_BLOCKED.test(String(err?.message))
            ? "ctx.evaluate: this page's Content-Security-Policy forbids running code in the page world"
            : undef
              ? `ctx.evaluate: \`${undef[1]}\` isn't defined in the page world — the function runs there; your script's top-level declarations and imports come along, its handler's variables don't: pass it as an argument: ctx.evaluate((${undef[1]}) => …, ${undef[1]})`
              : String(err?.message ?? err);
        return { name: String(err?.name || "Error"), message };
    };
    /** `d.id`'s callbacks: the isolated side runs them */
    const callbacksOf = (d: any, reply: (m: object) => void) => (fn: number) => (...xs: unknown[]): void => {
        try {
            win.postMessage({ source: PAGE_EVAL, kind: "call", id: d.id, fn, args: xs }, "*");
        } catch (err: any) {
            reply({ kind: "callError", fn, message: `ctx.evaluate: a callback's arguments must be plain data (${err?.message || err})` });
        }
    };
    /** a result, its functions swapped for markers the isolated side turns into stand-ins */
    const markResult = (id: string, v: unknown) => {
        const fns = returned.get(id) || [];
        const out = markFunctions(v, fns, PAGE_EVAL_RET);
        if (fns.length) returned.set(id, fns);
        return out;
    };
    const sendResult = (reply: (m: object) => void, out: object, kind: string, extra: object = {}) => {
        try {
            reply(out);
        } catch (err: any) {
            reply({ kind, ok: false, ...extra, error: { name: "DataCloneError", message: `ctx.evaluate: the result must be plain data (${err?.message || err})` } });
        }
    };
    win.addEventListener("message", async (e: MessageEvent) => {
        const d = e.data;
        if (e.source !== win || !d || d.source !== PAGE_EVAL || typeof d.id !== "string") return;
        const reply = (m: object) => win.postMessage({ source: PAGE_EVAL, id: d.id, ...m }, "*");
        if (d.kind === "invoke") {
            const f = returned.get(d.id)?.[d.fn];
            if (!f || typeof d.cid !== "number") return;
            let out: object;
            try {
                const args = unmarkFunctions(Array.isArray(d.args) ? d.args : [], PAGE_EVAL_FN, callbacksOf(d, reply)) as unknown[];
                out = { kind: "invoked", cid: d.cid, ok: true, value: markResult(d.id, await f.fn.apply(f.self, args)) };
            } catch (err: any) {
                out = { kind: "invoked", cid: d.cid, ok: false, error: errorOf(err) };
            }
            return sendResult(reply, out, "invoked", { cid: d.cid });
        }
        if (d.kind !== "run" || typeof d.src !== "string") return;
        reply({ kind: "ack" });
        let out: object;
        try {
            const mod = env ? d.mod : undefined;
            const entry = entryOf(mod);
            let run: (args: unknown) => unknown;
            if (entry && env && mod.who && typeof mod.who.name === "string") {
                const who: EvalWho = { scriptId: mod.who.scriptId ?? null, name: mod.who.name, params: mod.who.params || {} };
                const whoKey = `${who.scriptId}|${who.name}`;
                let api = entry.apis.get(whoKey);
                if (!api) entry.apis.set(whoKey, (api = { wt: env.wt(who), console: env.console(who) }));
                const prelude = typeof mod.prelude === "string" ? mod.prelude : "";
                const require = entry.libs ? (entry.requireFrom ??= env.libRequire(entry.libs))(String(mod.importer)) : noRequire;
                const moduleObj = { exports: {} };
                // fresh copies of the script's declarations per call; its libraries run once
                const f = new Function("wt", "console", "require", "module", "exports", "__wtArgs", `"use strict";\n${prelude}\nreturn (${d.src}\n).apply(undefined, __wtArgs);`);
                run = (args) => f(api!.wt, api!.console, require, moduleObj, moduleObj.exports, args);
            } else {
                const f = new Function("args", `"use strict";\nreturn (${d.src}\n).apply(undefined, args);`);
                run = (args) => f(args);
            }
            // a failed call is the script's problem: told to its isolated side, not thrown into the site's code
            const args = unmarkFunctions(Array.isArray(d.args) ? d.args : [], PAGE_EVAL_FN, callbacksOf(d, reply));
            out = { kind: "done", ok: true, value: markResult(d.id, await run(args)) };
        } catch (err: any) {
            out = { kind: "done", ok: false, error: errorOf(err) };
        }
        sendResult(reply, out, "done");
    });
}
