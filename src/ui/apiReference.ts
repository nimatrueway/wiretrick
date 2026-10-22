/** API reference content for the in-app "?" help dialog. */

export interface ApiSection {
    title: string;
    body: string;
}

const MDN = "https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API";
const ADV_SHORT = `"hook" is the lightest strategy, but it only sees the page's own fetch/XHR (REST/API) calls. For documents, <script src>, images, workers, or anything that must not slip through, use "process", "webrequest" or "cdp".`;

export const API_REFERENCE: ApiSection[] = [
    {
        title: "Script structure — routes",
        body: `Every handler takes its own route first, then the function. A script is active when its top level registers at least one handler; a file that registers none is a utility (importable, never runs on its own).

wt.onRequest("*://example.com/*", (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
wt.modifyResponse(["*://api.example.com/v1/*", "*://cdn.example.com/*.json"], (ctx, body) => body);

A route is a URLPattern string, a list of them, or an object (next section). Patterns follow ${MDN}: * is a wildcard within a URL part, :name a named segment (→ ctx.groups.name), an omitted query/hash matches any, and "<all_urls>" matches everything. An empty list matches nothing.
    "*://example.com/*"                     any scheme, any path on example.com
    "https://*.example.com/api/*"           every subdomain (not example.com itself)
    "https://cdn.example.com/static/*.js"   only .js files under /static/
    "https://example.com/users/:id"         /users/42 (ctx.groups.id === "42"), not /users/42/posts
    "*://localhost:*/*"                     any port (no port in the pattern = 80/443 only)
An invalid pattern makes the registration throw (shown as the script's error). Register handlers synchronously at top level — a registration after an await or inside a callback is ignored with an error.

Tip: ${ADV_SHORT}`,
    },
    {
        title: "Route object — exclude, methods, types, strategy",
        body: `The full form narrows a route and picks its strategy:

wt.onRequest({
    url: "*://app.example.com/*",              // pattern(s), as above
    exclude: ["*://app.example.com/health"],  // skip these even when url matches
    methods: ["POST", "PUT"],                 // HTTP methods, case-insensitive; omit = any
    types: ["xmlhttprequest"],                // resource types (ctx.resourceType); omit = any
    strategy: "hook",                         // one of process | hook | webrequest | cdp
}, (ctx) => { … });

exclude and methods are cheap: an extra check on requests that already matched url, on every strategy (the local helper checks them itself too).

types — webRequest names: main_frame, sub_frame, stylesheet, script, image, font, object, xmlhttprequest (fetch/XHR), ping, csp_report, media, websocket, other. What it saves depends on the strategy:
- cdp — only these types are paused at all (cheapest way to keep a route off images, fonts…)
- webrequest — checked in the listener before any script runs
- process — checked after the helper pauses the request: correct, but saves no work
- hook — only sees page fetch/XHR ("xmlhttprequest"); a list without it means the handler never runs (the LOG warns)

strategy — a single value overriding the default from Settings → Interception. No fallback: when it isn't available here, the handler doesn't run and the LOG says why.`,
    },
    {
        title: "wt.describe / wt.params / wt.defineParam",
        body: `wt.describe("Force failures on the posts API");  // manager tooltip, popup, settings.yaml comment

Params are knobs adjustable from the popup's ⚙ dialog, the manager and settings.yaml without editing the script. They come back typed:

const cfg = wt.params({
    enabled: { type: "boolean", default: true, description: "Master switch" },
    status: { type: "enum", choices: ["500", "503"], default: "500" },
    retries: { type: "number", default: 3, min: 0, max: 10 },
    note: { type: "string", default: "forced" },
    body: { type: "string", multiline: true, default: "" }, // textarea; YAML block scalar in settings.yaml
    hosts: { type: "stringList", default: ["staging.example.com"] },
});
// cfg.enabled: boolean, cfg.status: "500" | "503", cfg.note: string, cfg.hosts: string[]

// one at a time (same store; UI order = call order):
const host = wt.defineParam("host", { type: "string", default: "api.example.com" });

Routes may be built from params — a change re-runs the script:
wt.onResponseHeaders(cfg.hosts.map((h) => \`*://\${h}/*\`), () => ({ headers: { set: { "access-control-allow-origin": "*" } } }));

Scripts sync to the folder as plain <name>.ts files.`,
    },
    {
        title: "Utilities — import other scripts",
        body: `A saved script that registers no handlers is a utility module. Import its exports from another script by name:

// utility script named "utils" (saved as utils.ts):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";
wt.onRequest("*://example.com/*", () => { wt.log(double(21)); }); // 42

Utilities can export recipes — functions that register handlers. The handler belongs to the script that calls it:

// utility "mocks":
export function mockJson(url: string, body: object) {
    wt.onRequest(url, () => ({ respond: { body } }));
}
// script:
import { mockJson } from "./mocks";
mockJson("*://api.example.com/me", { id: 1, role: "admin" });

Utilities may declare params (shared config, editable in the popup, the manager and settings.yaml); a utility that registers handlers only for some param value becomes a script when it's set. Exported param definitions can be passed to wt.params ({ env: envParam } or { ...defs }). Imports work everywhere (background and the page-side onDom hook). "./utils", "utils", "utils.ts" all resolve.`,
    },
    {
        title: "wt.onRequest — redirect, cancel, request headers",
        body: `Runs before the request leaves the browser.

wt.onRequest("https://api.example.com/users/:id", (ctx) => {
    // ctx: { url, method, tabUrl, resourceType, requestHeaders, groups }
    if (ctx.groups.id === "42") return { redirect: "https://other.com/x" };  // or…
    return { cancel: true };                                                 // or…
    return { headers: { set: { "x-a": "1" }, remove: ["x-b"] } };
});`,
    },
    {
        title: "wt.onResponseHeaders — modify response headers",
        body: `Runs when response headers arrive. Not available on the "hook" strategy.

wt.onResponseHeaders("*://api.example.com/*", (ctx) => {
    // ctx adds: statusLine, responseHeaders
    return { headers: { set: { "access-control-allow-origin": "*" } } };
});`,
    },
    {
        title: "wt.replaceResponse — replace the body",
        body: `Return a string, bytes, an object (sent as JSON) or { file }. The response is fully replaced.

wt.replaceResponse("*://api.example.com/flags", (ctx) => ({ beta: true }));

// or serve file content:
wt.replaceResponse("*://example.com/logo.svg", () => ({ file: "data:image/svg+xml;base64,…" }));`,
    },
    {
        title: "wt.modifyResponse — transform the body",
        body: `Transform the body. Return the new body (string or bytes); async is fine.

wt.modifyResponse({ url: "*://example.com/app/*.js", types: ["script"] }, (ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return text.replace("old", "new");
});

Needs a strategy that reads bodies: "process" or "cdp" (any resource), "hook" (page fetch/XHR only) or "webrequest" on Firefox. Chromium's webrequest can't read bodies — the handler doesn't run there and the LOG says so.`,
    },
    {
        title: "wt.onDom — DOM & title changes",
        body: `Runs in the page (MAIN world) in every frame whose own URL matches the route — by default once DOMContentLoaded fires (DOM parsed; hydration not finished). If the bundle arrives after that, it runs immediately. Works even when the HTML is service-worker served or hydration re-renders it. Strategies don't apply.

wt.onDom("*://example.com/*", () => {
    document.title = "🎯 " + document.title;
    const h = document.querySelector("h1");
    if (h) h.textContent = "Hello!";
});

The route object takes url, exclude and when:

wt.onDom({ url: "*://example.com/*", when: "document_idle" }, () => {
    const el = document.querySelector("h1");
    if (el) el.textContent = "Intercepted";
});

Timing: when: "DOMContentLoaded" (default) | "document_start" | "document_end" | "document_idle"
- document_start — while the HTML is still parsing: <html> exists, head/body usually null. For stubbing globals / observers ahead of page code. MV3: a cold service worker (~50-100ms) can lose the race to early inline scripts
- DOMContentLoaded — HTML parsed, defer scripts done; images may load and frameworks may not have hydrated yet
- document_end — alias of DOMContentLoaded
- document_idle — after window load (always waits for it; a slow image delays it)
Already past the moment? Runs immediately.

Runs once per document per matching frame. SPA navigations and re-renders don't re-run it (use a MutationObserver inside). Saving the script with the page open re-runs it immediately — keep it idempotent. A script may register several onDom handlers, each with its own route and when. Hover "when" in the editor for the full reference.`,
    },
    {
        title: "onRequest.respond — mock without the network",
        body: `A terminal result that synthesizes the response immediately — the request never leaves the browser. First handler to respond wins (stacking).

wt.onRequest("*://api.example.com/me", (ctx) => ({
    respond: {
        body: { id: 1, name: "Mocked User" },  // object → JSON
        status: 200,
        mime: "application/json",
        headers: { set: { "x-mock": "1" } },
    },
}));

Full status/headers support on the hook, cdp and process strategies. The webrequest strategy serves status 200 only (another status is skipped with a warning) — in place on Firefox, by redirect on Chromium (the URL changes).`,
    },
    {
        title: "Multiple handlers — stacking order",
        body: `Handlers run in list order when several match one request: scripts top to bottom in the manager, then registration order within a script.

onRequest — first TERMINAL result (respond/redirect/cancel) wins and stops the chain; headers-only/void results don't stop it.
onResponseHeaders — ALL matching handlers run; set applied in order (later overwrites), remove accumulates.
modifyResponse — transforms COMPOSE: each output feeds the next handler.
replaceResponse — first handler returning a body wins.

A handler's strategy decides which tier runs it, not the stacking order.`,
    },
    {
        title: "Async handlers",
        body: `Every handler may be async. replaceResponse/modifyResponse/onDom async works everywhere.

onRequest/onResponseHeaders async results are awaited on every strategy except Chromium's "webrequest" (blocking webRequest can't await — an error is logged and the result ignored). Use "process" or "cdp" there.

// async mock:
wt.replaceResponse("*://api.example.com/user", async () => {
    const data = await fetch("https://myserver/fixture").then(r => r.json());
    return data;
});

// async redirect, pinned to the debugger:
wt.onRequest({ url: "*://example.com/*", strategy: "cdp" }, async (ctx) => {
    const target = await decideUpstream(ctx.url);
    return { redirect: target };
});`,
    },
    {
        title: "wt.storage / wt.log",
        body: `Per-script key/value storage (async), and logging into the LOG panel.

wt.onRequest("*://example.com/*", async (ctx) => {
    const hits = ((await wt.storage.get("hits")) || 0) + 1;
    await wt.storage.set("hits", hits);
    wt.log("hit #" + hits, ctx.url);
});`,
    },
    {
        title: "Strategies — one per handler",
        body: `Each handler runs on exactly one strategy: its route's strategy, else the default from Settings → Interception ("process" on Chromium, "webrequest" on Firefox).

process — Chrome: a tiny local helper (wiretrick-helper) proxies ONLY matched hosts. Sees everything (documents, script tags, images, workers, async handlers, body rewrites) with no banner. Install the helper and trust its CA from Settings → Local helper.
hook — page-level fetch/XHR override. No banner, no setup, every browser. Misses <script src>, <img>, documents, and requests made before the hook loads; no onResponseHeaders.
webrequest — blocking webRequest: Firefox (reaches everything, bodies included), and Chromium browsers that still run MV2 extensions (ungoogled-chromium, Brave, Opera…) — redirect, cancel, headers and synchronous respond/replaceResponse there, served by redirect; no modifyResponse or async handlers. Not available in MV3.
cdp — chrome.debugger + Fetch domain. Sees everything, but Chrome shows a "debugging" banner while attached.

wt.onRequest({ url: "*://example.com/*", strategy: "cdp" }, fn);   // this handler only

No fallback: when the strategy isn't available (helper not running, wrong browser, a kind it can't do), the handler doesn't run and the LOG warns. Hover "strategy" in the editor or see Settings → Interception for pros/cons.

Tip: ${ADV_SHORT}`,
    },
];
