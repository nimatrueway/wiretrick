/** API reference content for the in-app "?" help dialog. */

export interface ApiSection {
    title: string;
    body: string;
}

const MDN = "https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API";
const ADV_SHORT = `"page" is the lightest strategy, but it only sees the page's own fetch/XHR (REST/API) calls. For documents, <script src>, images, workers, or anything that must not slip through, use "helper", "extension" or "debugger".`;

export const API_REFERENCE: ApiSection[] = [
    {
        title: "Script structure — routes",
        body: `Every handler takes its own route first, then the function. A script is active when its top level registers at least one handler; a file that registers none is a library (importable, never runs on its own).

wt.onRequest("*://example.com/*", (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
wt.onResponseBody(["*://api.example.com/v1/*", "*://cdn.example.com/*.json"], (ctx, body) => body);

A route is a URLPattern string, a list of them, or an object (next section). URL patterns follow ${MDN}: * is a wildcard within a URL part, :name a named segment (→ ctx.groups.name), an omitted query/hash matches any, and "<all_urls>" matches everything. An empty list matches nothing.
    "*://example.com/*"                     any scheme, any path on example.com
    "https://*.example.com/api/*"           every subdomain (not example.com itself)
    "https://cdn.example.com/static/*.js"   only .js files under /static/
    "https://example.com/users/:id"         /users/42 (ctx.groups.id === "42"), not /users/42/posts
    "*://localhost:*/*"                     any port (no port in the pattern = 80/443 only)
An invalid URL pattern makes the registration throw (shown as the script's error). Register handlers synchronously at top level — a registration after an await or inside a callback is ignored with an error.

Tip: ${ADV_SHORT}`,
    },
    {
        title: "Route object — exclude, methods, resourceTypes, strategy",
        body: `The full form narrows a route and picks its strategy:

wt.onRequest({
    url: "*://app.example.com/*",              // URL pattern(s), as above
    exclude: ["*://app.example.com/health"],  // skip these even when url matches
    methods: ["POST", "PUT"],                 // HTTP methods, case-insensitive; omit = any
    resourceTypes: ["xmlhttprequest"],        // resource types (ctx.resourceType); omit = any
    strategy: "page",                         // one of helper | page | extension | debugger | rules
}, (ctx) => { … });

exclude and methods are cheap: an extra check on requests that already matched url, on every strategy (the local helper checks them itself too). The rules strategy doesn't support exclude.

resourceTypes — webRequest names: main_frame, sub_frame, stylesheet, script, image, font, object, xmlhttprequest (fetch/XHR), ping, csp_report, media, websocket, other. What it saves depends on the strategy:
- debugger — only these types are paused at all (cheapest way to keep a route off images, fonts…)
- extension — checked in the listener before any script runs
- helper — checked after the helper pauses the request: correct, but saves no work
- page — only sees page fetch/XHR ("xmlhttprequest"); a list without it means the handler never runs (the Log view warns)
- rules — part of the rule: the browser checks it

strategy — a single value overriding the default from Settings → Strategy. No fallback: when it isn't available here, the handler doesn't run and the Log view says why.`,
    },
    {
        title: "wt.about / wt.params / wt.defineParam",
        body: `wt.about("Force failures on the posts API");  // Editor tooltip, popup, settings.yaml comment

Params are knobs adjustable from the popup's ⚙ dialog, the Editor and settings.yaml without editing the script. They come back typed:

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

parse (any type) turns the raw value into something handier; the param takes the parser's return type, while the ⚙ dialog / settings.yaml keep editing the raw value. A throw is a script error naming the param:
const p = wt.params({ origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) } }); // p.origin: URL
const ids = wt.defineParam("ids", { type: "stringList", parse: (l) => new Set(l) }); // Set<string>

Routes may be built from params — a change re-runs the script:
wt.onResponseHeaders(cfg.hosts.map((h) => \`*://\${h}/*\`), () => ({ headers: { set: { "access-control-allow-origin": "*" } } }));

Scripts sync to the synced folder as plain <name>.ts files.`,
    },
    {
        title: "Libraries — import other scripts",
        body: `A saved script that registers no handlers is a library. Import its exports from another script by name:

// library named "utils" (saved as utils.ts):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";
wt.onRequest("*://example.com/*", () => { wt.log(double(21)); }); // 42

Libraries can export recipes — functions that register handlers. The handler belongs to the script that calls it:

// library "mocks":
export function mockJson(url: string, body: object) {
    wt.onRequest(url, () => ({ replaceResponse: { body } }));
}
// script:
import { mockJson } from "./mocks";
mockJson("*://api.example.com/me", { id: 1, role: "admin" });

Libraries may declare params (shared config, editable in the popup, the Editor and settings.yaml); a library that registers handlers only for some param value becomes a script when it's set. Exported param definitions can be passed to wt.params ({ env: envParam } or { ...defs }). Imports work everywhere (background and the page-side onDocument hook). "./utils", "utils", "utils.ts" all resolve.`,
    },
    {
        title: "wt.onRequest — redirect, block, request headers",
        body: `Runs before the request leaves the browser.

wt.onRequest("https://api.example.com/users/:id", (ctx) => {
    // ctx: { url, method, tabUrl, resourceType, requestHeaders, groups }
    if (ctx.groups.id === "42") return { redirect: "https://other.com/x" };  // or…
    return { block: true };                                                 // or…
    return { headers: { set: { "x-a": "1" }, remove: ["x-b"] } };
});`,
    },
    {
        title: "wt.onResponseHeaders — modify response headers",
        body: `Runs when response headers arrive. Not available on the "page" strategy.

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
        title: "wt.onResponseBody — transform the body",
        body: `Transform the body. Return the new body (string or bytes); async is fine.

wt.onResponseBody({ url: "*://example.com/app/*.js", resourceTypes: ["script"] }, (ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return text.replace("old", "new");
});

Needs a strategy that reads bodies: "helper" or "debugger" (any resource), "page" (page fetch/XHR only) or "extension" on Firefox. Chromium's webRequest can't read bodies — the handler doesn't run there and the Log view says so.`,
    },
    {
        title: "wt.onDocument — DOM & title changes",
        body: `Runs in the page (MAIN world) in every frame whose own URL matches the route — by default once DOMContentLoaded fires (DOM parsed; hydration not finished). If the bundle arrives after that, it runs immediately. Works even when the HTML is service-worker served or hydration re-renders it. Strategies don't apply.

wt.onDocument("*://example.com/*", () => {
    document.title = "🎯 " + document.title;
    const h = document.querySelector("h1");
    if (h) h.textContent = "Hello!";
});

The route object takes url, exclude and when:

wt.onDocument({ url: "*://example.com/*", when: "document_idle" }, () => {
    const el = document.querySelector("h1");
    if (el) el.textContent = "Intercepted";
});

Timing: when: "DOMContentLoaded" (default) | "document_start" | "document_end" | "document_idle"
- document_start — while the HTML is still parsing: <html> exists, head/body usually null. For stubbing globals / observers ahead of page code. MV3: a cold service worker (~50-100ms) can lose the race to early inline scripts
- DOMContentLoaded — HTML parsed, defer scripts done; images may load and frameworks may not have hydrated yet
- document_end — alias of DOMContentLoaded
- document_idle — after window load (always waits for it; a slow image delays it)
Already past the moment? Runs immediately.

Runs once per document per matching frame. SPA navigations and re-renders don't re-run it (use a MutationObserver inside). Saving the script with the page open re-runs it immediately — keep it idempotent. A script may register several onDocument handlers, each with its own route and when. Hover "when" in the Code view for the full reference.`,
    },
    {
        title: "onRequest → replaceResponse — mock without the network",
        body: `A final result that synthesizes the response immediately — the request never leaves the browser. First handler to return one wins (stacking).

wt.onRequest("*://api.example.com/me", (ctx) => ({
    replaceResponse: {
        body: { id: 1, name: "Mocked User" },  // object → JSON
        status: 200,
        mime: "application/json",
        headers: { set: { "x-mock": "1" } },
    },
}));

Full status/headers support on the page, debugger and helper strategies. The extension strategy serves status 200 only (another status is skipped with a warning) — in place on Firefox, by redirect on Chromium (the URL changes).`,
    },
    {
        title: "Multiple handlers — stacking order",
        body: `Handlers run in list order when several match one request: scripts top to bottom in the Editor, then registration order within a script.

onRequest — first FINAL result (replaceResponse/redirect/block) wins and stops the chain; headers-only/void results don't stop it.
onResponseHeaders — ALL matching handlers run; set applied in order (later overwrites), remove accumulates.
onResponseBody — transforms COMPOSE: each output feeds the next handler.
replaceResponse — first handler returning a body wins.

A handler's strategy decides how it is intercepted, not the stacking order.`,
    },
    {
        title: "Async handlers",
        body: `Every handler may be async. replaceResponse/onResponseBody/onDocument async works everywhere.

onRequest/onResponseHeaders async results are awaited on every strategy except "extension" on Chromium (blocking webRequest can't await — an error is logged and the result ignored). Use "helper" or "debugger" there.

// async mock:
wt.replaceResponse("*://api.example.com/user", async () => {
    const data = await fetch("https://myserver/fixture").then(r => r.json());
    return data;
});

// async redirect, pinned to the debugger:
wt.onRequest({ url: "*://example.com/*", strategy: "debugger" }, async (ctx) => {
    const target = await decideUpstream(ctx.url);
    return { redirect: target };
});`,
    },
    {
        title: "wt.storage / wt.log",
        body: `Per-script key/value storage (async), and logging into the Log view.

wt.onRequest("*://example.com/*", async (ctx) => {
    const hits = ((await wt.storage.get("hits")) || 0) + 1;
    await wt.storage.set("hits", hits);
    wt.log("hit #" + hits, ctx.url);
});`,
    },
    {
        title: "Strategies — one per handler",
        body: `Each handler runs on exactly one strategy: its route's strategy, else the default from Settings → Strategy ("helper" on Chromium, "extension" on Firefox).

helper — Chrome: a tiny local helper (wiretrick-helper) proxies ONLY matched hosts. Sees everything (documents, script tags, images, workers, async handlers, body rewrites) with no banner. Install the helper and trust its helper certificate from Settings → Local helper.
page — page-level fetch/XHR override. No banner, no setup, every browser. Misses <script src>, <img>, documents, and requests made before the page patch loads; no onResponseHeaders.
extension — the extension handles each request (blocking webRequest): Firefox (reaches everything, bodies included), and Chromium browsers that still run MV2 extensions (ungoogled-chromium, Brave, Opera…) — redirect, block, headers and synchronous replaceResponse there, served by redirect; no onResponseBody or async handlers. Not available in MV3.
debugger — chrome.debugger + Fetch domain. Sees everything, but Chrome shows a "debugging" banner while attached.
rules — browser-native rules (declarativeNetRequest): the browser blocks, redirects or sets/removes headers itself, on every request, with no banner or helper. The handler runs once when scripts load and must return a fixed result — ctx.groups.* / ctx.url only as-is in a redirect URL; no replaceResponse, onResponseBody or exclude. A handler that can't be a rule doesn't run and its script shows an error.

wt.onRequest({ url: "*://example.com/*", strategy: "debugger" }, fn);   // this handler only

Pick per browser/build with wt.isChrome / wt.isFirefox / wt.isMV2 / wt.isMV3:

wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "extension" : "helper" }, fn);
wt.onRequest({ url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }, () => ({ block: true }));

No fallback: when the strategy isn't available (helper not running, wrong browser, a kind it can't do), the handler doesn't run and the Log view warns. Hover "strategy" in the Code view or see Settings → Strategy for pros/cons.

Tip: ${ADV_SHORT}`,
    },
];
