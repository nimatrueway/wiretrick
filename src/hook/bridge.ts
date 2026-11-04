/**
 * ISOLATED-world bridge content script. Runs in the extension's security
 * context (page CSP does not apply here in MV2) and is the only channel
 * between the MAIN-world hook and the background:
 *
 *   hook (MAIN, no eval) ← postMessage → bridge (isolated) ⇄ background
 *
 * Also runs wt.onPage code in the isolated world: `world: "isolated"`
 * handlers (MV2; MV3 has no eval in content scripts), and main-world ones
 * when the page CSP blocks eval there. The background sends the scripts'
 * SOURCES, the bridge compiles them and runs them at the requested DOM
 * moment — the isolated world shares the page's DOM, not its JS world.
 */
import { formatScriptError } from "../shared/scriptError";
import { makeScriptConsole, formatLogArgs, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";
import { makeLibRequire, type ShippedLib } from "../shared/scriptImports";
import { makePageShim, domHandlersFor, scheduleDocument, type PageDocumentHandler } from "../shared/pageShim";
import { packBytes, unpackBytes } from "../shared/bytesPack";

(() => {
    const MAIN_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    /** bridge diagnostics → extension debug log (never the page console) */
    function dlog(level: ScriptLogLevel, ...args: any[]): void {
        safeSend({ type: "debugLog", entry: { at: Date.now(), src: "bridge", msg: formatLogArgs(args), level } });
    }

    /** a user script's own output → extension LOG, attributed to the script */
    function scriptLog(scriptId: string | null, level: ScriptLogLevel, msg: string): void {
        safeSend({ type: "scriptLog", scriptId, level, msg });
    }

    // ---- MAIN-world hook relaying ----

    /**
     * Extension reloads invalidate this content script's context:
     * chrome.runtime.sendMessage then THROWS synchronously. Every relay
     * must survive that — the first detection marks the bridge dead and
     * tells the hook to go dormant (restoring the page's own fetch/XHR)
     * instead of stalling every request on the 15s watchdog.
     */
    let dead = false;
    const CONTEXT_DEAD = /context invalidated/i;
    function markDead(): void {
        if (dead) return;
        dead = true;
        try {
            window.postMessage({ source: MAIN_SOURCE, kind: "extensionDead" }, window.location.origin);
        } catch {}
    }
    function safeSend(msg: any, onResp?: (resp: any) => void): void {
        if (dead) return;
        try {
            chrome.runtime.sendMessage(msg, (resp: any) => {
                // the context can die between send and callback — nothing in
                // here may throw uncaught
                try {
                    const err = (chrome.runtime as any).lastError;
                    if (err && CONTEXT_DEAD.test(err.message || "")) return markDead();
                    onResp?.(resp);
                } catch (e: any) {
                    if (CONTEXT_DEAD.test(e?.message || "")) markDead();
                }
            });
        } catch (e: any) {
            if (CONTEXT_DEAD.test(e?.message || "")) markDead();
            else onResp?.(undefined);
        }
    }

    /** final net: a content-script event handler may never throw uncaught */
    function guard(fn: () => void): void {
        try {
            fn();
        } catch (e: any) {
            if (CONTEXT_DEAD.test(e?.message || "")) markDead();
            else dlog("error", "bridge message handler failed:", String(e?.message || e));
        }
    }

    window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;
        void guard(() => {

        if (data.kind === "status?") {
            safeSend({ type: "getHookBundle", url: location.href }, (resp: any) => {
                noteBundle(resp, false);
                postStatus(resp, false);
            });
            return;
        }
        if (data.kind === "claim") {
            safeSend({ type: "claimRequest", url: data.url });
            return;
        }
        if (data.kind === "call" && (data.op === "storageGet" || data.op === "storageSet")) {
            // the page can forge this message: only scripts whose main-world
            // onPage code was shipped to this frame may use its storage
            if (typeof data.scriptId !== "string" || !pageScriptIds.has(data.scriptId)) {
                dlog("warn", `refused a page storage ${data.op} for a script not running in this frame's page world`);
                window.postMessage({ source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: null }, window.location.origin);
                return;
            }
            const storageType = data.op === "storageGet" ? "scriptStorageGet" : "scriptStorageSet";
            safeSend(
                { type: storageType, scriptId: data.scriptId, key: data.key, value: data.value },
                (resp: any) => {
                    window.postMessage(
                        { source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: resp || null },
                        window.location.origin
                    );
                }
            );
            return;
        }
        if (data.kind === "call") {
            const bgType = data.op === "replace" ? "runReplace" : data.op === "respond" ? "runRequestDecision" : "runTransform";
            // runtime messaging is JSON: binary bodies travel as base64 both ways
            safeSend(
                packBytes({ type: bgType, url: data.url, method: data.method, body: data.body, status: data.status, contentType: data.contentType, requestBody: data.requestBody }),
                (resp: any) => {
                    window.postMessage(
                        { source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: unpackBytes(resp) || null },
                        window.location.origin
                    );
                }
            );
            return;
        }
        if (data.kind === "bodySkip") {
            safeSend({ type: "bodySkip", url: data.url, method: typeof data.method === "string" ? data.method : "GET", why: data.why, contentType: data.contentType || "" });
            return;
        }
        if (data.kind === "log") {
            safeSend(
                { type: "debugLog", entry: { at: Date.now(), src: data.src || "page", msg: data.msg, level: data.level || "info" } }
            );
        }
        if (data.kind === "scriptLog") {
            safeSend({ type: "scriptLog", scriptId: data.scriptId ?? null, level: data.level, msg: data.msg });
        }
        });
    });

    // ---- onPage code in the isolated world: compiles the FULL script source
    // with a shim so top-level helpers/closures survive; the DOM is shared
    // with the page, window (page JS globals) is not ----
    interface DocumentHandler { scriptId: string; name: string; src: string; params?: Record<string, any> }

    /** script ids whose main-world onPage code this frame got (storage relay allow-list) */
    let pageScriptIds = new Set<string>();
    let isoFired = false;

    function postStatus(resp: any, hot: boolean): void {
        const active = !!(resp && (resp.count > 0 || (resp.domHandlers || []).length));
        // main-world handlers and libraries only: isolated code never reaches the page
        window.postMessage(
            { source: MAIN_SOURCE, kind: "status", active, routes: (resp && resp.routes) || [], textTypes: resp?.textTypes, domHandlers: (resp && resp.domHandlers) || [], libs: (resp && resp.libs) || [], ...(hot ? { hot: true } : {}) },
            window.location.origin
        );
    }

    /** a fresh bundle: refresh the storage allow-list, run isolated handlers (once per load; again on a hot update) */
    function noteBundle(resp: any, hot: boolean): void {
        if (!resp) return;
        pageScriptIds = new Set(((resp.domHandlers || []) as DocumentHandler[]).map((h) => h.scriptId));
        const iso: DocumentHandler[] = resp.isoHandlers || [];
        if (isoFired && !hot) return;
        isoFired = true;
        if (!iso.length) return;
        if (__MV3__) {
            // MV3 content scripts can't eval: isolated code needs chrome.userScripts
            for (const h of iso) scriptLog(h.scriptId, "warn", scriptLogLine(h.name, "onPage", 'world: "isolated" handlers don\'t run on this build yet'));
            return;
        }
        runPageScripts(iso, resp.isoLibs || [], "isolated", hot);
    }

    function runPageScripts(handlers: DocumentHandler[], libSources: ShippedLib[], world: "main" | "isolated", hot: boolean): void {
        if (dead) return;
        const what = world === "isolated" ? "onPage (isolated world)" : "onPage (isolated-world fallback)";
        dlog("debug", `${what}: running ${handlers.length} script(s)${hot ? " (hot refire)" : ""}`);
        const shimFor = (scriptId: string | null, name: string, params: Record<string, any>) =>
            makePageShim({
                params,
                world,
                log: (...args: any[]) => scriptLog(scriptId, "info", scriptLogLine(name, "wt.log", formatLogArgs(args))),
                storage: {
                    get: (key: string) => new Promise((r) => safeSend({ type: "scriptStorageGet", scriptId, key }, (x: any) => r(x && x.value))),
                    set: (key: string, value: any) => new Promise((r) => safeSend({ type: "scriptStorageSet", scriptId, key, value }, () => r(null))),
                },
            });
        for (const h of handlers) {
            // shadow console like the MAIN-world path: script console.*
            // calls go to the extension LOG, not the page console
            const consoleProxy = makeScriptConsole((level, source, text) => scriptLog(h.scriptId, level, scriptLogLine(h.name, source, text)));
            let dom: PageDocumentHandler[];
            try {
                // page-side require over the shipped library sources and data files
                const requireFrom = makeLibRequire(libSources, (lib, require, moduleObj) =>
                    scriptFunction(lib.src!)(shimFor(null, lib.name, lib.params || {}).wt, consoleProxy, require, moduleObj, moduleObj.exports)
                );
                const moduleObj = { exports: {} as any };
                const shim = shimFor(h.scriptId, h.name, h.params || {});
                scriptFunction(h.src)(shim.wt, consoleProxy, requireFrom(h.name), moduleObj, moduleObj.exports);
                dom = shim.dom;
            } catch (e: any) {
                scriptLog(h.scriptId, "error", formatScriptError(h.name, e, `${what} compile`));
                continue;
            }
            for (const d of domHandlersFor(dom, location.href)) {
                const run = () => {
                    try {
                        d.fn({ url: location.href, method: "GET", tabUrl: location.href });
                    } catch (e: any) {
                        scriptLog(h.scriptId, "error", formatScriptError(h.name, e, d.route.api || "onDocument"));
                    }
                };
                scheduleDocument(d.when, run, hot);
            }
        }
    }

    /** main-world handlers, here because the page CSP blocks eval in the page */
    async function runDocumentHandlers(hot: boolean): Promise<void> {
        if (dead) return;
        // handlers come embedded in the hook bundle (getHookBundle)
        const bundle = await new Promise<any>((resolve) => {
            safeSend({ type: "getHookBundle", url: location.href }, (r: any) => resolve(r || { domHandlers: [] }));
            // dead bridge: safeSend never answers — resolve empty after a beat
            setTimeout(() => resolve({ domHandlers: [] }), 1000);
        });
        runPageScripts(bundle.domHandlers || [], bundle.libs || [], "main", hot);
    }

    let hookBroken = false;

    chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
        // the background asks whether this frame has a live hook (see pipeline.ts checkMissed)
        if (msg && msg.type === "hookPing") {
            sendResponse({ ok: true });
            return false;
        }
        guard(() => {
            if (msg && msg.type === "hookCspBlocked") {
                hookBroken = true;
            }
            if (msg && msg.type === "bundleUpdate") {
                // scripts changed: refresh hook status; onDocument refires in the
                // MAIN world (hook) when healthy, else here (isolated)
                if (hookBroken) void runDocumentHandlers(true);
                safeSend({ type: "getHookBundle", url: location.href }, (resp: any) => {
                    noteBundle(resp, true);
                    postStatus(resp, true);
                });
            }
        });
        return false;
    });

    // initial: inject the hook + register dom handlers
    function injectHook(): void {
        if (document.querySelector("script[data-res-override-hook]")) return;
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("hook.js");
        script.setAttribute("data-res-override-hook", "1");
        (document.head || document.documentElement).appendChild(script);
        script.addEventListener("load", () => script.remove());
    }

    async function init(): Promise<void> {
        dlog("debug", "bridge ready", { href: location.href, readyState: document.readyState });
        injectHook();
        // isolated handlers must not depend on the page hook asking for its status
        setTimeout(() => {
            if (!isoFired && !dead) safeSend({ type: "getHookBundle", url: location.href }, (resp: any) => noteBundle(resp, false));
        }, 1500);
    }

    void init();
})();
