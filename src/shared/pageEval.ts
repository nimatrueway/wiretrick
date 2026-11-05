/**
 * `ctx.evaluate(fn, ...args)` for isolated onPage code: run `fn` in the
 * page's own JavaScript world and get back what it returns. The MAIN-world
 * hook (hook.ts, `servePageEvaluate`) compiles `fn`'s source and runs it.
 * Request and answer are window messages the page can see and forge, so
 * `fn` gets only the page's own powers (its CSP still applies) and the
 * answer is untrusted data. Arguments and results are structured clones,
 * except functions (also inside plain objects and arrays): `fn` gets
 * stand-ins that call them back here (for as long as the document lives),
 * with copied, untrusted arguments.
 */
export const PAGE_EVAL = "wt-page-eval";
/** marks a function argument in the run message: its index among the call's callbacks */
const PAGE_EVAL_FN = "wt-page-eval-fn";
/** the hook acknowledges at once; no ack: it isn't in this frame */
export const PAGE_EVAL_ACK_MS = 3000;

const CSP_BLOCKED = /a string as JavaScript|unsafe-eval/i;

const isPlain = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== "object") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
};

/** `v` with its functions (also in plain objects and arrays) swapped for markers into `callbacks` */
function markCallbacks(v: unknown, callbacks: Function[], seen = new Map<object, unknown>()): unknown {
    if (typeof v === "function") return { [PAGE_EVAL_FN]: callbacks.push(v) - 1 };
    if (!Array.isArray(v) && !isPlain(v)) return v;
    if (seen.has(v)) return seen.get(v);
    const out: any = Array.isArray(v) ? [] : {};
    seen.set(v, out);
    for (const k of Object.keys(v)) out[k] = markCallbacks((v as any)[k], callbacks, seen);
    return out;
}

/** the page side: markers (also in plain objects and arrays, in place) → `stub(index)` */
function unmarkCallbacks(v: unknown, stub: (fn: number) => Function, seen = new Set<object>()): unknown {
    if (!Array.isArray(v) && !isPlain(v)) return v;
    if (typeof (v as any)[PAGE_EVAL_FN] === "number" && Object.keys(v).length === 1) return stub((v as any)[PAGE_EVAL_FN]);
    if (seen.has(v)) return v;
    seen.add(v);
    for (const k of Object.keys(v)) (v as any)[k] = unmarkCallbacks((v as any)[k], stub, seen);
    return v;
}

export type PageEvaluate = (fn: unknown, ...args: unknown[]) => Promise<unknown>;

/** page-world code: `fn` is already where it should run */
export const directEvaluate: PageEvaluate = async (fn, ...args) => {
    if (typeof fn !== "function") throw new TypeError("ctx.evaluate: pass a function, e.g. ctx.evaluate(() => document.title)");
    return fn(...args);
};

/** isolated code: ask the page world (the hook) to run `fn` */
export function makePageEvaluate(win: Window = window, ackMs = PAGE_EVAL_ACK_MS): PageEvaluate {
    let seq = 0;
    const tag = Math.random().toString(36).slice(2);
    return (fn, ...args) => {
        if (typeof fn !== "function") return Promise.reject(new TypeError("ctx.evaluate: pass a function, e.g. ctx.evaluate(() => document.title)"));
        const id = `${tag}:${++seq}`;
        const callbacks: Function[] = [];
        const sent = markCallbacks(args, callbacks);
        return new Promise((resolve, reject) => {
            let acked = false;
            const end = (keepCallbacks = false) => {
                clearTimeout(timer);
                // callbacks stay callable after fn returns (e.g. from a page event listener)
                if (!keepCallbacks || !callbacks.length) win.removeEventListener("message", onMessage);
            };
            const timer = setTimeout(() => {
                if (acked) return;
                end();
                reject(new Error("ctx.evaluate: the page world didn't answer (Wiretrick's page hook isn't running in this frame)"));
            }, ackMs);
            const onMessage = (e: MessageEvent) => {
                const d = e.data;
                if (e.source !== win || !d || d.source !== PAGE_EVAL || d.id !== id) return;
                if (d.kind === "ack") acked = true;
                if (d.kind === "call") {
                    const cb = callbacks[d.fn];
                    if (typeof cb === "function" && Array.isArray(d.args)) cb(...d.args);
                    return;
                }
                if (d.kind !== "done") return;
                end(d.ok);
                if (d.ok) resolve(d.value);
                else reject(Object.assign(new Error(String(d.error?.message ?? "ctx.evaluate failed")), { name: String(d.error?.name || "Error") }));
            };
            win.addEventListener("message", onMessage);
            try {
                win.postMessage({ source: PAGE_EVAL, kind: "run", id, src: String(fn), args: sent }, "*");
            } catch (e: any) {
                end();
                reject(new TypeError(`ctx.evaluate: arguments must be plain data (${e?.message || e})`));
            }
        });
    };
}

/** the page-world side (the hook): run what isolated code asks for */
export function servePageEvaluate(win: Window = window): void {
    win.addEventListener("message", async (e: MessageEvent) => {
        const d = e.data;
        if (e.source !== win || !d || d.source !== PAGE_EVAL || d.kind !== "run" || typeof d.id !== "string" || typeof d.src !== "string") return;
        const reply = (m: object) => win.postMessage({ source: PAGE_EVAL, id: d.id, ...m }, "*");
        reply({ kind: "ack" });
        let out: object;
        try {
            const run = new Function("args", `"use strict";\nreturn (${d.src}\n).apply(undefined, args);`);
            const args = unmarkCallbacks(Array.isArray(d.args) ? d.args : [], (fn) => (...xs: unknown[]): void => {
                try {
                    win.postMessage({ source: PAGE_EVAL, kind: "call", id: d.id, fn, args: xs }, "*");
                } catch (err: any) {
                    throw new TypeError(`ctx.evaluate: a callback's arguments must be plain data (${err?.message || err})`);
                }
            });
            out = { kind: "done", ok: true, value: await run(args) };
        } catch (err: any) {
            const undef = err?.name === "ReferenceError" && /^([\w$]+) is not defined$/.exec(String(err?.message));
            const message = CSP_BLOCKED.test(String(err?.message))
                ? "ctx.evaluate: this page's Content-Security-Policy forbids running code in the page world"
                : undef
                  ? `ctx.evaluate: \`${undef[1]}\` isn't defined in the page world — the function runs there as page code and can't use your script's variables; pass it as an argument: ctx.evaluate((${undef[1]}) => …, ${undef[1]})`
                  : String(err?.message ?? err);
            out = { kind: "done", ok: false, error: { name: String(err?.name || "Error"), message } };
        }
        try {
            reply(out);
        } catch (err: any) {
            reply({ kind: "done", ok: false, error: { name: "DataCloneError", message: `ctx.evaluate: the result must be plain data (${err?.message || err})` } });
        }
    });
}
