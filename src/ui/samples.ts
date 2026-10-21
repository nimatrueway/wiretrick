/** Bundled sample scripts, offered as one-click inserts. */

export interface SampleScript {
    name: string;
    blurb: string;
    code: string;
}

// Every sample targets a long-lived public site and names a URL to open so
// the effect is visible right away.
export const SAMPLES: SampleScript[] = [
    {
        name: "Redirect a URL",
        blurb: "Send any request to a different URL. Try it: open en.wikipedia.org/wiki/Cat — you land on Dog.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.declareScript({
    match: ["*://en.wikipedia.org/wiki/Cat"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.onRequest(() => {
    return { redirect: "https://en.wikipedia.org/wiki/Dog" };
});`,
    },
    {
        name: "Block requests",
        blurb: "Cancel matching requests. Try it: open any Wikipedia article — every image is gone.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.declareScript({
    match: ["*://upload.wikimedia.org/*"],
});
wt.onRequest(() => ({ cancel: true }));`,
    },
    {
        name: "Modify request headers",
        blurb: "Set or remove request headers before they leave the browser. Try it: httpbin.org/headers echoes them back.",
        code: `// Try it: open https://httpbin.org/headers
wt.declareScript({
    match: ["*://httpbin.org/*"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.onRequest(() => ({
    headers: {
        set: { "x-debug": "1", "x-greeting": "hello from Wiretrick" },
        remove: ["accept-language"],
    },
}));`,
    },
    {
        name: "CORS unlock",
        blurb: "Add permissive response headers so other pages can consume a resource. Try it: run the fetch from the comment in jsonplaceholder.typicode.com's console.",
        code: `// Try it: open https://jsonplaceholder.typicode.com/, then in DevTools → Console run
//   fetch("https://example.com/").then(r => r.text()).then(console.log)
// Without this script it fails with a CORS error; with it the HTML prints.
wt.declareScript({
    match: ["*://example.com/*"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.onResponseHeaders(() => ({
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
        blurb: "Replace a JSON API response. Page fetch/XHR use the banner-free hook. Try it: open jsonplaceholder.typicode.com/users/1.",
        code: `// Try it: open https://jsonplaceholder.typicode.com/users/1
wt.declareScript({
    match: ["*://jsonplaceholder.typicode.com/users/1"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.replaceResponse(() => JSON.stringify({
    id: 1,
    name: "Mocked User",
    role: "admin",
}));`,
    },
    {
        name: "Transform an API response",
        blurb: "Modify a JSON body — flip fields, inject values. Try it: open jsonplaceholder.typicode.com/todos/1.",
        code: `// Try it: open https://jsonplaceholder.typicode.com/todos/1
wt.declareScript({
    match: ["*://jsonplaceholder.typicode.com/todos/*"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.modifyResponse((ctx, body) => {
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    json.completed = true;
    json.title = "Transformed by Wiretrick";
    return JSON.stringify(json, null, 2);
});`,
    },
    {
        name: "Rewrite page HTML",
        blurb: "Transform the document itself on Chrome (uses the debugger briefly). Try it: open example.com — a red banner appears.",
        code: `// Try it: open https://example.com/
wt.declareScript({
    match: ["*://example.com/*"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.modifyResponse((ctx, body) => {
    const html = typeof body === "string" ? body : new TextDecoder().decode(body);
    return html
        .replace("<title>Example Domain", "<title>Rewritten Domain")
        .replace(/<body[^>]*>/i, (tag) => tag + '<h1 style="color:#c00">Rewritten by Wiretrick</h1>');
});`,
    },
    {
        name: "DOM / title changes",
        blurb: "Runs at DOM-ready in the page. Best for titles and DOM text — works even when the HTML is service-worker served or hydration re-renders it. Try it: open any Wikipedia article.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.declareScript({
    match: ["*://en.wikipedia.org/wiki/*"],
});
wt.onDom(() => {
    document.title = "🎯 " + document.title;
    const el = document.querySelector("h1");
    if (el) el.textContent = "Hello from Wiretrick";
});`,
    },
    {
        name: "Serve a local file",
        blurb: "Replace a response with file content (path or data: URL). Try it: open en.wikipedia.org/robots.txt.",
        code: `// Try it: open https://en.wikipedia.org/robots.txt
wt.declareScript({
    match: ["*://en.wikipedia.org/robots.txt"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.replaceResponse(() => ({
    file: "data:text/plain;base64," + btoa("Served by Wiretrick instead of the real robots.txt"),
}));`,
    },
    {
        name: "Per-script storage",
        blurb: "Keep state between requests with wt.storage. Try it: open httpbin.org/headers and reload — X-Hits counts up.",
        code: `// Try it: open https://httpbin.org/headers and reload a few times
wt.declareScript({
    match: ["*://httpbin.org/headers"],
    strategy: ["hook", "webrequest", "cdp"],
});
wt.onRequest(async (ctx) => {
    const hits = ((await wt.storage.get("hits")) || 0) + 1;
    await wt.storage.set("hits", hits);
    wt.log("request #" + hits, ctx.url);
    return { headers: { set: { "x-hits": String(hits) } } };
});`,
    },
    {
        name: "Parameters (declareScript)",
        blurb: "Adjustable knobs the user changes from the popup's ⚙ dialog — no code edits. Try it: open jsonplaceholder.typicode.com/posts/1.",
        code: `// Try it: open https://jsonplaceholder.typicode.com/posts/1, then change
// the knobs from the popup's ⚙ dialog and reload
const cfg = wt.declareScript({
    match: ["*://jsonplaceholder.typicode.com/*"],
    strategy: ["hook", "webrequest", "cdp"],
    params: {
        enabled: { type: "boolean", default: true, description: "Master switch" },
        status: { type: "enum", choices: ["500", "502", "503"], default: "500", description: "Status to return" },
        message: { type: "string", default: "forced failure" },
        retries: { type: "number", default: 3, min: 0, max: 10, description: "Retries the page should see" },
        extraHeaders: { type: "stringList", default: [], description: "Extra x-tag values" },
    },
});

wt.onRequest((ctx) => {
    if (!cfg.enabled || !ctx.url.includes("/posts/")) return;
    return {
        respond: {
            status: Number(cfg.status),
            body: { error: cfg.message, retries: cfg.retries, tags: cfg.extraHeaders },
            mime: "application/json",
        },
    };
});`,
    },
];
