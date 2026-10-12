/** API reference content for the in-app "?" help dialog. */

export interface ApiSection {
    title: string;
    body: string;
}

export const API_REFERENCE: ApiSection[] = [
    {
        title: "Script structure",
        body: `Every script starts with a metadata block. @match (repeatable) decides when it activates; @phase narrows which events run.

// ==ResScript==
// @name       My script
// @match      *://example.com/*
// @match      *://api.example.com/v1/*
// @phase      request,response
// @strategy   auto | hook | proxy | cdp
// ==/ResScript==

Patterns are star patterns: * matches anything, ** the same (groups are remembered for replace patterns).`,
    },
    {
        title: "res.onRequest — redirect, cancel, request headers",
        body: `Runs before the request leaves the browser. Must be synchronous.

res.onRequest((ctx) => {
    // ctx: { url, method, tabUrl, resourceType, requestHeaders }
    return { redirect: "https://other.com/x" };  // or…
    return { cancel: true };                     // or…
    return { headers: { set: { "x-a": "1" }, remove: ["x-b"] } };
});`,
    },
    {
        title: "res.onResponseHeaders — modify response headers",
        body: `Runs when response headers arrive. Synchronous.

res.onResponseHeaders((ctx) => {
    // ctx adds: statusLine, responseHeaders
    return { headers: { set: { "access-control-allow-origin": "*" } } };
});`,
    },
    {
        title: "res.replaceResponse — replace the body",
        body: `Return a string, bytes, or { file }. The response is fully replaced.

res.replaceResponse((ctx) => JSON.stringify({ mocked: true }));

// or serve file content:
res.replaceResponse(() => ({ file: "data:text/html;base64,…" }));`,
    },
    {
        title: "res.modifyResponse — transform the body",
        body: `Stream/transform the body. Return the new body (string or bytes); async is fine.

res.modifyResponse((ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return text.replace("old", "new");
});

Tiers on Chrome: page fetch/XHR goes through a banner-free hook; documents, script tags and other "direct" resources go through the debugger (a yellow banner appears briefly while they load). On Firefox everything is network-level without a banner. Pin a tier with @strategy.`,
    },
    {
        title: "res.onDom — DOM & title changes",
        body: `Runs at DOM-ready in the page. Best way to change titles, text and DOM — it works even when the HTML is service-worker served or hydration re-renders it.

res.onDom(() => {
    document.title = "🎯 " + document.title;
    const h = document.querySelector("h1");
    if (h) h.textContent = "Hello!";
});`,
    },
    {
        title: "res.storage / res.log",
        body: `Per-script key/value storage (async), and logging into the LOG panel.

res.onRequest(async (ctx) => {
    const hits = ((await res.storage.get("hits")) || 0) + 1;
    await res.storage.set("hits", hits);
    res.log("hit #" + hits, ctx.url);
});`,
    },
    {
        title: "Tiers & the debugger banner",
        body: `hook — page-level fetch/XHR override. Banner-free. Misses <script src>, <img>, documents.
proxy — extension service worker (reserved for the MV3 path).
cdp — chrome.debugger + Fetch domain. Sees everything, but Chrome shows a "debugging" banner while attached; the engine attaches only while needed and detaches when idle.
Scripts that only ever match fetch/XHR are learned to be hook-only and never trigger the banner.`,
    },
];
