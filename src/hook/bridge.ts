/**
 * ISOLATED-world bridge content script. MAIN-world scripts have no
 * chrome.runtime access — and MV2 Chrome does not honor the manifest
 * "world": "MAIN" key — so this bridge:
 *   1. injects hook.js into the page's MAIN world via a script tag
 *      (hook.js is web-accessible; classic userscript technique)
 *   2. fetches the hook bundle from the background and relays it to the
 *      hook via window.postMessage
 *   3. relays request claims (hook → background)
 */
(() => {
    const MAIN_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";
    const SRC = "bridge";
    const logBuf: any[] = [];
    function dlog(...args: any[]): void {
        const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        console.log(`[res:${SRC}]`, msg);
        logBuf.push({ at: Date.now(), src: SRC, msg });
        try {
            chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: SRC, msg } }, () => void chrome.runtime.lastError);
        } catch {}
    }

    function injectHook(): void {
        dlog("injecting hook.js into MAIN world");
        if (document.querySelector("script[data-res-override-hook]")) return;
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("hook.js");
        script.setAttribute("data-res-override-hook", "1");
        // document_start: documentElement always exists, head may not yet
        (document.head || document.documentElement).appendChild(script);
        script.addEventListener("load", () => script.remove());
    }

    function fetchBundle(): Promise<any> {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href }, (resp) => {
                    if (chrome.runtime.lastError) {
                        dlog("sendMessage lastError:", chrome.runtime.lastError.message);
                        resolve(null);
                        return;
                    }
                    resolve(resp || null);
                });
            } catch (e: any) {
                dlog("sendMessage threw:", e.message || e);
                resolve(null);
            }
        });
    }

    let lastBundle: any = null;

    async function init(): Promise<void> {
        dlog("init", { href: location.href, readyState: document.readyState });
        injectHook();
        const bundle = await fetchBundle();
        dlog("bundle fetch →", bundle ? `${bundle.scripts ? bundle.scripts.length : 0} script(s)` : "null");
        if (bundle) {
            lastBundle = bundle;
            window.postMessage({ source: MAIN_SOURCE, kind: "bundle", bundle }, window.location.origin);
        }
    }

    // background pushes bundle updates (script edited/disabled) → forward
    // into the MAIN world as a hot update
    chrome.runtime.onMessage.addListener((msg: any) => {
        if (msg && msg.type === "bundleUpdate") {
            void (async () => {
                const bundle = await fetchBundle();
                if (bundle) {
                    window.postMessage({ source: MAIN_SOURCE, kind: "bundle", bundle, hot: true }, window.location.origin);
                }
            })();
        }
        return false;
    });

    window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;
        if (data.kind === "claim") {
            dlog("claim", data.url);
            chrome.runtime.sendMessage({ type: "claimRequest", url: data.url }, () => void chrome.runtime.lastError);
        }
        // the script-tag hook loads asynchronously and may have missed the
        // original bundle — re-send it when the hook announces readiness
        if (data.kind === "ready" && lastBundle) {
            dlog("hook ready → re-sending bundle");
            window.postMessage({ source: MAIN_SOURCE, kind: "bundle", bundle: lastBundle }, window.location.origin);
        }
        if (data.kind === "cspBlocked") {
            dlog("page CSP blocked hook compilation → CDP fallback");
            try {
                chrome.runtime.sendMessage({ type: "hookCspBlocked" }, () => void chrome.runtime.lastError);
            } catch {}
        }
        if (data.kind === "log" && data.msg) {
            try {
                chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "hook", msg: data.msg } }).catch(() => {});
            } catch {}
        }
    });

    // run_at document_start: documentElement exists, inject immediately so
    // the hook patches fetch/XHR before page scripts run
    void init();
})();
