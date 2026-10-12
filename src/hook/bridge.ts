/**
 * ISOLATED-world bridge content script. MAIN-world scripts have no
 * chrome.runtime access, so this relays:
 *   - the hook bundle (background → MAIN) via window.postMessage
 *   - request claims (MAIN → background)
 */
(() => {
    const MAIN_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    async function fetchBundle(): Promise<any> {
        try {
            return await chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href });
        } catch {
            return null;
        }
    }

    async function init(): Promise<void> {
        const bundle = await fetchBundle();
        if (bundle) {
            window.postMessage({ source: MAIN_SOURCE, kind: "bundle", bundle }, window.location.origin);
        }
    }

    window.addEventListener("message", (event: MessageEvent) => {
        if (event.origin !== window.location.origin && event.origin !== "null") return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;
        if (data.kind === "claim") {
            chrome.runtime.sendMessage({ type: "claimRequest", url: data.url }).catch(() => {});
        }
    });

    init();
})();
