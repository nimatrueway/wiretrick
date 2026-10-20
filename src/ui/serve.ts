/**
 * Serves static replaceResponse content for main-frame navigations on
 * Chrome, where data:-URL navigations are blocked. The background stores
 * the content keyed by rid and this page writes it into the document.
 */

const rid = new URLSearchParams(location.search).get("rid") || location.hash.replace(/^#r=/, "");

chrome.runtime.sendMessage({ type: "getServe", rid }, (resp: any) => {
    if (!resp || typeof resp.content !== "string") {
        document.body.textContent = "[Wiretrick] response content expired — retry the request.";
        return;
    }
    document.open();
    document.write(resp.content);
    document.close();
});
