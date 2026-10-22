/** Bundled sample scripts, offered as one-click inserts. */

export interface SampleScript {
    name: string;
    blurb: string;
    code: string;
}

// Every sample targets a long-lived public site and names a URL to open so
// the effect is visible right away. None pins a strategy: they run on the
// default from Settings → Interception.
export const SAMPLES: SampleScript[] = [
    {
        name: "Redirect a URL",
        blurb: "Send any request to a different URL. Try it: open en.wikipedia.org/wiki/Cat — you land on Dog.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.describe("Cat → Dog on Wikipedia");

wt.onRequest("*://en.wikipedia.org/wiki/Cat", () => ({
    redirect: "https://en.wikipedia.org/wiki/Dog",
}));`,
    },
    {
        name: "Block requests",
        blurb: "Cancel matching requests — here only images, via the route's types filter. Try it: open any Wikipedia article — every image is gone.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.describe("Block Wikipedia images");

wt.onRequest({ url: "*://upload.wikimedia.org/*", types: ["image"] }, () => ({ cancel: true }));`,
    },
    {
        name: "Modify request headers",
        blurb: "Set or remove request headers before they leave the browser. Try it: postman-echo.com/headers echoes them back.",
        code: `// Try it: open https://postman-echo.com/headers
wt.describe("Add debug headers, drop Accept-Language");

wt.onRequest("*://postman-echo.com/*", () => ({
    headers: {
        set: { "x-debug": "1", "x-greeting": "hello from Wiretrick" },
        remove: ["accept-language"],
    },
}));`,
    },
    {
        name: "CORS unlock",
        blurb: "Add permissive response headers so other pages can consume a resource. Try it: run the fetch from the comment in example.org's console.",
        code: `// Try it: open https://example.org/, then in DevTools → Console run
//   fetch("https://example.com/").then(r => r.text()).then(console.log)
// Without this script it fails with a CORS error; with it the HTML prints.
wt.describe("Let any origin read example.com");

wt.onResponseHeaders("*://example.com/*", () => ({
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
        blurb: "Replace a JSON API response; :id in the route is read back as ctx.groups.id. Try it: open dummyjson.com/users/1.",
        code: `// Try it: open https://dummyjson.com/users/1
wt.describe("Mock the users API");

wt.replaceResponse("*://dummyjson.com/users/:id", (ctx) => ({
    id: Number(ctx.groups.id),
    name: "Mocked User",
    role: "admin",
}));`,
    },
    {
        name: "Transform an API response",
        blurb: "Modify a JSON body — flip fields, inject values. Try it: open dummyjson.com/todos/1.",
        code: `// Try it: open https://dummyjson.com/todos/1
wt.describe("Mark every todo completed");

wt.modifyResponse("*://dummyjson.com/todos/*", (ctx, body) => {
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    json.completed = true;
    json.todo = "Transformed by Wiretrick";
    return JSON.stringify(json, null, 2);
});`,
    },
    {
        name: "Rewrite page HTML",
        blurb: "Transform the document itself. Needs a strategy that reads page bodies: process or cdp on Chrome, webrequest on Firefox (not hook). Try it: open example.com — a red banner appears.",
        code: `// Try it: open https://example.com/
wt.describe("Rewrite example.com's HTML");

wt.modifyResponse({ url: "*://example.com/*", types: ["main_frame"] }, (ctx, body) => {
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
wt.describe("Retitle Wikipedia articles");

wt.onDom("*://en.wikipedia.org/wiki/*", () => {
    document.title = "🎯 " + document.title;
    const el = document.querySelector("h1");
    if (el) el.textContent = "Hello from Wiretrick";
});`,
    },
    {
        name: "Serve a local file",
        blurb: "Replace a response with file content (path or data: URL). Try it: open en.wikipedia.org/robots.txt.",
        code: `// Try it: open https://en.wikipedia.org/robots.txt
wt.describe("Serve our own robots.txt");

wt.replaceResponse("*://en.wikipedia.org/robots.txt", () => ({
    file: "data:text/plain;base64," + btoa("Served by Wiretrick instead of the real robots.txt"),
}));`,
    },
    {
        name: "Per-script storage",
        blurb: "Keep state between requests with wt.storage. Try it: open postman-echo.com/headers and reload — X-Hits counts up.",
        code: `// Try it: open https://postman-echo.com/headers and reload a few times
wt.describe("Count requests in X-Hits");

wt.onRequest("*://postman-echo.com/headers", async (ctx) => {
    const hits = ((await wt.storage.get("hits")) || 0) + 1;
    await wt.storage.set("hits", hits);
    wt.log("request #" + hits, ctx.url);
    return { headers: { set: { "x-hits": String(hits) } } };
});`,
    },
    {
        name: "Parameters (wt.params)",
        blurb: "Adjustable knobs (wt.params) the user changes from the popup's ⚙ dialog — no code edits. Try it: open dummyjson.com/posts/1.",
        code: `// Try it: open https://dummyjson.com/posts/1, then change
// the knobs from the popup's ⚙ dialog and reload
wt.describe("Force failures on the posts API");

const cfg = wt.params({
    enabled: { type: "boolean", default: true, description: "Master switch" },
    status: { type: "enum", choices: ["500", "502", "503"], default: "500", description: "Status to return" },
    message: { type: "string", default: "forced failure" },
    retries: { type: "number", default: 3, min: 0, max: 10, description: "Retries the page should see" },
    extraHeaders: { type: "stringList", default: [], description: "Extra x-tag values" },
});

wt.onRequest("*://dummyjson.com/posts/*", () => {
    if (!cfg.enabled) return;
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
