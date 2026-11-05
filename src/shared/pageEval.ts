/**
 * `ctx.evaluate(fn, ...args)` for isolated onPage code: run `fn` in the
 * page's own JavaScript world and get back what it returns. The MAIN-world
 * hook (hook.ts, `servePageEvaluate`) compiles `fn`'s source and runs it.
 * Request and answer are window messages the page can see and forge, so
 * `fn` gets only the page's own powers (its CSP still applies) and the
 * answer is untrusted data. Arguments and results are structured clones.
 */
export const PAGE_EVAL = "wt-page-eval";
/** the hook acknowledges at once; no ack: it isn't in this frame */
export const PAGE_EVAL_ACK_MS = 3000;

const CSP_BLOCKED = /a string as JavaScript|unsafe-eval/i;

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
        return new Promise((resolve, reject) => {
            let acked = false;
            const end = () => {
                clearTimeout(timer);
                win.removeEventListener("message", onMessage);
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
                if (d.kind !== "done") return;
                end();
                if (d.ok) resolve(d.value);
                else reject(Object.assign(new Error(String(d.error?.message ?? "ctx.evaluate failed")), { name: String(d.error?.name || "Error") }));
            };
            win.addEventListener("message", onMessage);
            try {
                win.postMessage({ source: PAGE_EVAL, kind: "run", id, src: String(fn), args }, "*");
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
            out = { kind: "done", ok: true, value: await run(Array.isArray(d.args) ? d.args : []) };
        } catch (err: any) {
            const message = CSP_BLOCKED.test(String(err?.message)) ? "ctx.evaluate: this page's Content-Security-Policy forbids running code in the page world" : String(err?.message ?? err);
            out = { kind: "done", ok: false, error: { name: String(err?.name || "Error"), message } };
        }
        try {
            reply(out);
        } catch (err: any) {
            reply({ kind: "done", ok: false, error: { name: "DataCloneError", message: `ctx.evaluate: the result must be plain data (${err?.message || err})` } });
        }
    });
}
