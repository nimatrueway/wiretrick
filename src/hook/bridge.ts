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
        if (data.kind === "call") {
            const bgType = data.op === "replace" ? "runReplace" : "runTransform";
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
                    { type: "debugLog", entry: { at: Date.now(), src: "hook", msg: data.msg, level: data.level || "info" } },
                    () => void chrome.runtime.lastError
                );
            } catch {}
        }
    });

    // ---- res.onDom: compiled in this isolated world, DOM shared with page ----
    interface DomHandler { name: string; when: string; src: string }

    function compileHandler(src: string): ((ctx: any) => any) | null {
        try {
            return new Function(`return (${src});`)();
        } catch (e: any) {
            dlog("onDom compile failed:", e.message || e);
            return null;
        }
    }

    function makeShim() {
        return {
            log: (...args: any[]) => {
                const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
                try {
                    chrome.runtime.sendMessage(
                        { type: "debugLog", entry: { at: Date.now(), src: "hook", msg: `res.log: ${msg}` } },
                        () => void chrome.runtime.lastError
                    );
                } catch {}
            },
            storage: {
                get: (key: string) => new Promise((r) => chrome.runtime.sendMessage({ type: "scriptStorageGet", key }, (x: any) => r(x && x.value))),
                set: (key: string, value: any) => new Promise((r) => chrome.runtime.sendMessage({ type: "scriptStorageSet", key, value }, () => r(null))),
            },
        };
    }

    function fetchDomHandlers(): Promise<DomHandler[]> {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "getDomHandlers", url: location.href }, (resp: any) => {
                resolve((resp && resp.handlers) || []);
            });
        });
    }

    async function runDomHandlers(hot: boolean): Promise<void> {
        const handlers = await fetchDomHandlers();
        dlog(`onDom: ${handlers.length} handler(s)${hot ? " (hot update refire)" : ""}`);
        for (const h of handlers) {
            const fn = compileHandler(h.src);
            if (!fn) continue;
            const run = () => {
                try {
                    fn({ url: location.href, method: "GET", tabUrl: location.href, ...makeShim() });
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
                // DOMContentLoaded / document_end
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
