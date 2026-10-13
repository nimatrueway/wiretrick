/**
 * ISOLATED-world bridge content script. Runs in the extension's security
 * context (page CSP does not apply here in MV2) and is the only channel
 * between the MAIN-world hook and the background:
 *
 *   hook (MAIN, no eval) ← postMessage → bridge (isolated) ⇄ background
 *
 * Also owns res.onDom: the background sends compiled handler SOURCES, the
 * bridge re-compiles them (isolated world allows eval in MV2) and runs
 * them at the requested DOM moment — the isolated world shares the page's
 * DOM, so title/text changes work without touching the page's JS world.
 */
(() => {
    const MAIN_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    function dlog(...args: any[]): void {
        const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        console.log(`[res:bridge] ${msg}`);
        try {
            chrome.runtime.sendMessage(
                { type: "debugLog", entry: { at: Date.now(), src: "bridge", msg } },
                () => void chrome.runtime.lastError
            );
        } catch {}
    }

    // ---- MAIN-world hook relaying ----
    window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;

        if (data.kind === "status?") {
            chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href }, (resp: any) => {
                const active = !!(resp && (resp.count > 0 || (resp.domHandlers || []).length));
                window.postMessage(
                    { source: MAIN_SOURCE, kind: "status", active, domHandlers: (resp && resp.domHandlers) || [] },
                    window.location.origin
                );
            });
            return;
        }
        if (data.kind === "claim") {
            chrome.runtime.sendMessage({ type: "claimRequest", url: data.url }, () => void chrome.runtime.lastError);
            return;
        }
        if (data.kind === "call" && (data.op === "storageGet" || data.op === "storageSet")) {
            const storageType = data.op === "storageGet" ? "scriptStorageGet" : "scriptStorageSet";
            chrome.runtime.sendMessage(
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
            chrome.runtime.sendMessage(
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
            try {
                chrome.runtime.sendMessage(
                    { type: "debugLog", entry: { at: Date.now(), src: data.src || "hook", msg: data.msg, level: data.level || "info" } },
                    () => void chrome.runtime.lastError
                );
            } catch {}
        }
    });

    // ---- res.onDom fallback (isolated world): compiles the FULL script
    // source with a shim so top-level helpers/closures survive; the DOM is
    // shared with the page, window (page JS globals) is not ----
    interface DomHandler { scriptId: string; name: string; when: string; src: string }

    async function runDomHandlers(hot: boolean): Promise<void> {
        // handlers come embedded in the hook bundle (getHookBundle)
        const bundle = await new Promise<any>((resolve) => {
            chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href }, (r: any) => resolve(r || { domHandlers: [] }));
        });
        const handlers: DomHandler[] = bundle.domHandlers || [];
        dlog(`onDom (isolated fallback): ${handlers.length} script(s)${hot ? " (hot refire)" : ""}`);
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
                log: (...args: any[]) => {
                    const msg = `res.log: ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
                    try {
                        chrome.runtime.sendMessage(
                            { type: "debugLog", entry: { at: Date.now(), src: h.name, msg } },
                            () => void chrome.runtime.lastError
                        );
                    } catch {}
                },
                storage: {
                    get: (key: string) =>
                        new Promise((r) => chrome.runtime.sendMessage({ type: "scriptStorageGet", scriptId: h.scriptId, key }, (x: any) => r(x && x.value))),
                    set: (key: string, value: any) =>
                        new Promise((r) => chrome.runtime.sendMessage({ type: "scriptStorageSet", scriptId: h.scriptId, key, value }, () => r(null))),
                },
            };
            try {
                // shadow console like the MAIN-world path: script console.*
                // calls are attributed to the script and still hit the page
                const sc: any = {};
                for (const method of ["log", "info", "warn", "error", "debug"]) {
                    const level = method === "error" ? "error" : method === "warn" ? "warn" : "info";
                    sc[method] = (...args: any[]) => {
                        try {
                            (console as any)[method](...args);
                        } catch {}
                        const m = `console.log: ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
                        try {
                            chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: h.name, msg: m, level } }, () => void chrome.runtime.lastError);
                        } catch {}
                    };
                }
                new Function("res", "console", `"use strict";\n${h.src}`)(shim, new Proxy(sc, { get: (t, k) => (k in t ? t[k as any] : (console as any)[k]) }));
            } catch (e: any) {
                dlog(`onDom ${h.name} compile failed (isolated):`, e.message || e);
                continue;
            }
            if (!store.onDom) continue;
            const run = () => {
                try {
                    store.onDom({ url: location.href, method: "GET", tabUrl: location.href });
                } catch (e: any) {
                    dlog(`onDom ${h.name} threw: ${e.message || e}`);
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
        if (msg && msg.type === "hookCspBlocked") {
            hookBroken = true;
        }
        if (msg && msg.type === "bundleUpdate") {
            // scripts changed: refresh hook status; onDom refires in the
            // MAIN world (hook) when healthy, else here (isolated)
            if (hookBroken) void runDomHandlers(true);
            chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href }, (resp: any) => {
                const active = !!(resp && (resp.count > 0 || (resp.domHandlers || []).length));
                window.postMessage(
                    { source: MAIN_SOURCE, kind: "status", active, domHandlers: (resp && resp.domHandlers) || [], hot: true },
                    window.location.origin
                );
            });
        }
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
        dlog("init", { href: location.href, readyState: document.readyState });
        injectHook();
    }

    void init();
})();
