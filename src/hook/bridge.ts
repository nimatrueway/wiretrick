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

    function injectHook(): void {
        if (document.querySelector("script[data-res-override-hook]")) return;
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("hook.js");
        script.setAttribute("data-res-override-hook", "1");
        // document_start: documentElement always exists, head may not yet
        (document.head || document.documentElement).appendChild(script);
        script.addEventListener("load", () => script.remove());
    }

    async function fetchBundle(): Promise<any> {
        try {
            return await chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href });
        } catch {
            return null;
        }
    }

    async function init(): Promise<void> {
        injectHook();
        const bundle = await fetchBundle();
        if (bundle) {
            window.postMessage({ source: MAIN_SOURCE, kind: "bundle", bundle }, window.location.origin);
        }
    }

    window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;
        if (data.kind === "claim") {
            chrome.runtime.sendMessage({ type: "claimRequest", url: data.url }).catch(() => {});
        }
    });

    // run_at document_start: documentElement exists, inject immediately so
    // the hook patches fetch/XHR before page scripts run
    void init();
})();
