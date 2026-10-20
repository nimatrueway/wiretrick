/**
 * ISOLATED-world bridge content script. Runs in the extension's security
 * context (page CSP does not apply here in MV2) and is the only channel
 * between the MAIN-world hook and the background:
 *
 *   hook (MAIN, no eval) ← postMessage → bridge (isolated) ⇄ background
 *
 * Also owns wt.onDom: the background sends compiled handler SOURCES, the
 * bridge re-compiles them (isolated world allows eval in MV2) and runs
 * them at the requested DOM moment — the isolated world shares the page's
 * DOM, so title/text changes work without touching the page's JS world.
 */
import { formatScriptError } from "../shared/scriptError";
import { makeScriptConsole, formatLogArgs, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";

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
                const active = !!(resp && (resp.count > 0 || (resp.domHandlers || []).length));
                window.postMessage(
                    { source: MAIN_SOURCE, kind: "status", active, patterns: (resp && resp.patterns) || [], domHandlers: (resp && resp.domHandlers) || [], libs: (resp && resp.libs) || [] },
                    window.location.origin
                );
            });
            return;
        }
        if (data.kind === "claim") {
            safeSend({ type: "claimRequest", url: data.url });
            return;
        }
        if (data.kind === "call" && (data.op === "storageGet" || data.op === "storageSet")) {
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
            safeSend(
                { type: bgType, url: data.url, method: data.method, body: data.body, status: data.status, contentType: data.contentType },
                (resp: any) => {
                    window.postMessage(
                        { source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: resp || null },
                        window.location.origin
                    );
                }
            );
            return;
        }
        if (data.kind === "log") {
            safeSend(
                { type: "debugLog", entry: { at: Date.now(), src: data.src || "hook", msg: data.msg, level: data.level || "info" } }
            );
        }
        if (data.kind === "scriptLog") {
            safeSend({ type: "scriptLog", scriptId: data.scriptId ?? null, level: data.level, msg: data.msg });
        }
        });
    });

    // ---- wt.onDom fallback (isolated world): compiles the FULL script
    // source with a shim so top-level helpers/closures survive; the DOM is
    // shared with the page, window (page JS globals) is not ----
    interface DomHandler { scriptId: string; name: string; when: string; src: string; params?: Record<string, any> }

    async function runDomHandlers(hot: boolean): Promise<void> {        if (dead) return;
        // handlers come embedded in the hook bundle (getHookBundle)
        const bundle = await new Promise<any>((resolve) => {
            safeSend({ type: "getHookBundle", url: location.href }, (r: any) => resolve(r || { domHandlers: [] }));
            // dead bridge: safeSend never answers — resolve empty after a beat
            setTimeout(() => resolve({ domHandlers: [] }), 1000);
        });
        const handlers: DomHandler[] = bundle.domHandlers || [];
        const libSources: { name: string; src: string }[] = bundle.libs || [];
        dlog("debug", `onDom (isolated world): running ${handlers.length} script(s)${hot ? " (hot refire)" : ""}`);
        for (const h of handlers) {
            const store: any = { onDom: null, onDomOptions: {} };
            const shim = {
                onRequest: () => {},
                onResponseHeaders: () => {},
                replaceResponse: () => {},
                modifyResponse: () => {},
                onDom: (fn: any, opts?: any) => {
                    store.onDom = fn;
                    store.onDomOptions = opts || {};
                },
                // meta applied upstream; script gets its resolved params
                declareScript: () => h.params || {},
                log: (...args: any[]) => scriptLog(h.scriptId, "info", scriptLogLine(h.name, "wt.log", formatLogArgs(args))),
                storage: {
                    get: (key: string) =>
                        new Promise((r) => safeSend({ type: "scriptStorageGet", scriptId: h.scriptId, key }, (x: any) => r(x && x.value))),
                    set: (key: string, value: any) =>
                        new Promise((r) => safeSend({ type: "scriptStorageSet", scriptId: h.scriptId, key, value }, () => r(null))),
                },
            };
            try {
                // shadow console like the MAIN-world path: script console.*
                // calls go to the extension LOG, not the page console
                const consoleProxy = makeScriptConsole((level, source, text) => scriptLog(h.scriptId, level, scriptLogLine(h.name, source, text)));
                // page-side require over the shipped library sources
                const libModules = new Map<string, any>();
                const normSpec = (spec: string) =>
                    spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
                const requireLib = (spec: string): any => {
                    const key = normSpec(spec);
                    if (libModules.has(key)) return libModules.get(key);
                    const lib = libSources.find((l) => normSpec(l.name) === key);
                    if (!lib) throw new Error(`cannot import "${spec}" — is the library script saved?`);
                    const moduleObj = { exports: {} as any };
                    libModules.set(key, moduleObj.exports);
                    const libStore: any = { onDom: null, onDomOptions: {} };
                    scriptFunction(lib.src)(
                        { ...shim, onDom: (fn: any, opts: any) => { libStore.onDom = fn; libStore.onDomOptions = opts || {}; } },
                        consoleProxy,
                        requireLib,
                        moduleObj,
                        moduleObj.exports
                    );
                    libModules.set(key, moduleObj.exports);
                    return moduleObj.exports;
                };
                const moduleObj = { exports: {} as any };
                scriptFunction(h.src)(shim, consoleProxy, requireLib, moduleObj, moduleObj.exports);
            } catch (e: any) {
                scriptLog(h.scriptId, "error", formatScriptError(h.name, e, "onDom compile (isolated world)"));
                continue;
            }
            if (!store.onDom) continue;
            const run = () => {
                try {
                    store.onDom({ url: location.href, method: "GET", tabUrl: location.href });
                } catch (e: any) {
                    scriptLog(h.scriptId, "error", formatScriptError(h.name, e, "onDom"));
                }
            };
            if (hot || h.when === "document_start") {
                run();
            } else if (h.when === "document_idle") {
                if (document.readyState === "complete") run();
                else window.addEventListener("load", run, { once: true });
            } else {
                if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
                else run();
            }
        }
    }

    let hookBroken = false;

    chrome.runtime.onMessage.addListener((msg: any) => {
        guard(() => {
            if (msg && msg.type === "hookCspBlocked") {
                hookBroken = true;
            }
            if (msg && msg.type === "bundleUpdate") {
                // scripts changed: refresh hook status; onDom refires in the
                // MAIN world (hook) when healthy, else here (isolated)
                if (hookBroken) void runDomHandlers(true);
                safeSend({ type: "getHookBundle", url: location.href }, (resp: any) => {
                    const active = !!(resp && (resp.count > 0 || (resp.domHandlers || []).length));
                    window.postMessage(
                        { source: MAIN_SOURCE, kind: "status", active, patterns: (resp && resp.patterns) || [], domHandlers: (resp && resp.domHandlers) || [], libs: (resp && resp.libs) || [], hot: true },
                        window.location.origin
                    );
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
    }

    void init();
})();
