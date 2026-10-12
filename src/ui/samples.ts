/** Bundled sample scripts, offered as one-click inserts. */

export interface SampleScript {
    name: string;
    blurb: string;
    code: string;
}

export const SAMPLES: SampleScript[] = [
    {
        name: "Redirect a URL",
        blurb: "Send any request to a different URL (main frames navigate, subresources re-fetch).",
        code: `// ==ResScript==
// @name       Redirect example
// @match      *://example.com/old-endpoint*
// @phase      request
// ==/ResScript==

res.onRequest((ctx) => {
    return { redirect: "https://example.com/new-endpoint" };
});`,
    },
    {
        name: "Block requests",
        blurb: "Cancel matching requests — analytics, trackers, anything.",
        code: `// ==ResScript==
// @name       Block example
// @match      *://example.com/analytics.js
// ==/ResScript==

res.onRequest(() => ({ cancel: true }));`,
    },
    {
        name: "Modify request headers",
        blurb: "Set or remove request headers before they leave the browser.",
        code: `// ==ResScript==
// @name       Request headers example
// @match      *://api.example.com/*
// ==/ResScript==

res.onRequest(() => ({
    headers: {
        set: { "x-debug": "1", authorization: "Bearer my-token" },
        remove: ["x-unwanted"],
    },
}));`,
    },
    {
        name: "CORS unlock",
        blurb: "Add permissive response headers so other pages can consume the API.",
        code: `// ==ResScript==
// @name       CORS unlock example
// @match      *://api.example.com/*
// @phase      response
// ==/ResScript==

res.onResponseHeaders(() => ({
    headers: {
        set: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
        },
        remove: ["x-frame-options"],
    },
}));`,
    },
    {
        name: "Mock a fetch/XHR API",
        blurb: "Replace a JSON API response. Banner-free (page hook tier).",
        code: `// ==ResScript==
// @name       Mock API example
// @match      *://api.example.com/v1/user*
// ==/ResScript==

res.replaceResponse(() => JSON.stringify({
    id: 1,
    name: "Mocked User",
    role: "admin",
}));`,
    },
    {
        name: "Transform an API response",
        blurb: "Stream-modify a JSON body — flip fields, inject values.",
        code: `// ==ResScript==
// @name       Transform JSON example
// @match      *://api.example.com/v1/config*
// ==/ResScript==

res.modifyResponse((ctx, body) => {
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    json.debugMode = true;
    json.featureFlags = { ...(json.featureFlags || {}), newCheckout: true };
    return JSON.stringify(json);
});`,
    },
    {
        name: "Rewrite page HTML",
        blurb: "Transform the document itself on Chrome (uses the debugger briefly).",
        code: `// ==ResScript==
// @name       Rewrite HTML example
// @match      *://example.com/*
// ==/ResScript==

res.modifyResponse((ctx, body) => {
    const html = typeof body === "string" ? body : new TextDecoder().decode(body);
    return html.replace("old-branding", "new-branding");
});`,
    },
    {
        name: "DOM / title changes",
        blurb: "Runs at DOM-ready in the page. Best for titles and DOM text — works even when the HTML is service-worker served or hydration re-renders it.",
        code: `// ==ResScript==
// @name       DOM changes example
// @match      *://example.com/*
// ==/ResScript==

res.onDom(() => {
    document.title = "🎯 " + document.title;
    const el = document.querySelector("h1");
    if (el) el.textContent = "Hello from ResScript";
});`,
    },
    {
        name: "Serve a local file",
        blurb: "Replace a response with file content (path or data: URL).",
        code: `// ==ResScript==
// @name       Serve file example
// @match      *://cdn.example.com/lib.js
// ==/ResScript==

res.replaceResponse(() => ({
    file: "data:application/javascript;base64," + btoa("console.log('served by ResScript');"),
}));`,
    },
    {
        name: "Per-script storage",
        blurb: "Keep state between requests with res.storage.",
        code: `// ==ResScript==
// @name       Storage example
// @match      *://api.example.com/*
// ==/ResScript==

res.onRequest(async (ctx) => {
    const hits = ((await res.storage.get("hits")) || 0) + 1;
    await res.storage.set("hits", hits);
    res.log("request #" + hits, ctx.url);
});`,
    },
];
