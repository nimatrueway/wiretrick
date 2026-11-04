/** API reference content for the in-app "?" help dialog. */

export interface ApiSection {
    title: string;
    body: string;
    /** a table rendered under the body: "strategies" = every strategy's pros/cons and whether this browser can run it */
    table?: "strategies";
}

const MDN = "https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API";
const ADV_SHORT = `"page" is the lightest strategy, but it only sees the page's own fetch/XHR (REST/API) calls. For documents, <script src>, images, workers, or anything that must not slip through, use "helper", "extension" or "debugger".`;

export const API_REFERENCE: ApiSection[] = [
    {
        title: "Script structure — routes",
        body: `Every handler takes its own route first, then the function. A network handler's route is an object with url and strategy — there is no default strategy. A script is active when its top level registers at least one handler; a file that registers none is a library (importable, never runs on its own).

wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
wt.onResponseBody({ url: ["*://api.example.com/v1/*", "*://cdn.example.com/*.json"], strategy: "helper" }, (ctx, body) => body);

url is a URLPattern string or a list of them (more route options in the next section; wt.onPage and wt.onOverlay also take a bare pattern). URL patterns follow ${MDN}: * is a wildcard within a URL part, :name a named segment (→ ctx.groups.name), an omitted query/hash matches any, and "<all_urls>" matches everything. An empty list matches nothing.
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
        body: `Every network route names its strategy; the other options narrow it:

wt.onRequest({
    url: "*://app.example.com/*",              // URL pattern(s), as above
    exclude: ["*://app.example.com/health"],  // skip these even when url matches
    methods: ["POST", "PUT"],                 // HTTP methods, case-insensitive; omit = any
    resourceTypes: ["xmlhttprequest"],        // resource types (ctx.resourceType); omit = any
    strategy: "page",                         // required: helper | page | extension | debugger | rules
}, (ctx) => { … });

exclude and methods are cheap: an extra check on requests that already matched url, on every strategy (the local helper checks them itself too). The rules strategy doesn't support exclude.

resourceTypes — webRequest names: main_frame, sub_frame, stylesheet, script, image, font, object, xmlhttprequest (fetch/XHR), ping, csp_report, media, websocket, other. What it saves depends on the strategy:
- debugger — only these types are paused at all (cheapest way to keep a route off images, fonts…)
- extension — checked in the listener before any script runs
- helper — checked after the helper pauses the request: correct, but saves no work
- page — only sees page fetch/XHR ("xmlhttprequest"); a list without it means the handler never runs (the Log view warns)
- rules — part of the rule: the browser checks it

strategy — required, a single value; there is no default. No fallback: when it isn't available here, the handler doesn't run and the Log view says why.`,
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
wt.onResponseHeaders({ url: cfg.hosts.map((h) => \`*://\${h}/*\`), strategy: "helper" }, () => ({ headers: { set: { "access-control-allow-origin": "*" } } }));

Scripts sync to the synced folder as plain <name>.ts files.`,
    },
    {
        title: "Libraries — import other scripts",
        body: `A saved script that registers no handlers is a library. Import its exports from another script by name:

// library named "utils" (saved as utils.ts):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";
wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, () => { wt.log(double(21)); }); // 42

Libraries can export recipes — functions that register handlers. The handler belongs to the script that calls it:

// library "mocks":
export function mockJson(url: string, body: object) {
    wt.onRequest({ url, strategy: "helper" }, () => ({ replaceResponse: { body } }));
}
// script:
import { mockJson } from "./mocks";
mockJson("*://api.example.com/me", { id: 1, role: "admin" });

Libraries may declare params (shared config, editable in the popup, the Editor and settings.yaml); a library that registers handlers only for some param value becomes a script when it's set. Exported param definitions can be passed to wt.params ({ env: envParam } or { ...defs }). Imports work everywhere (background, onPage and onOverlay code). "./utils", "utils", "utils.ts" all resolve. Data files import by path: a .json as its parsed value, an .svg as its markup (a string): import logo from "./icons/logo.svg".`,
    },
    {
        title: "wt.onRequest — redirect, block, request headers",
        body: `Runs before the request leaves the browser.

wt.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => {
    // ctx: { url, method, tabUrl, resourceType, requestHeaders, groups }
    if (ctx.groups.id === "42") return { redirect: "https://other.com/x" };  // or…
    return { block: true };                                                 // or…
    return { headers: { set: { "x-a": "1" }, remove: ["x-b"] } };
});`,
    },
    {
        title: "wt.onResponseHeaders — modify response headers",
        body: `Runs when response headers arrive. Not available on the "page" strategy.

wt.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => {
    // ctx adds: statusLine, responseHeaders
    return { headers: { set: { "access-control-allow-origin": "*" } } };
});`,
    },
    {
        title: "wt.replaceResponse — replace the body",
        body: `Return a string, bytes, an object (sent as JSON) or { file }. The response is fully replaced.

wt.replaceResponse({ url: "*://api.example.com/flags", strategy: "helper" }, (ctx) => ({ beta: true }));

// or serve file content:
wt.replaceResponse({ url: "*://example.com/logo.svg", strategy: "helper" }, () => ({ file: "data:image/svg+xml;base64,…" }));`,
    },
    {
        title: "wt.onResponseBody — transform the body",
        body: `Transform the body. Return the new body (string or bytes); async is fine.

wt.onResponseBody({ url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "helper" }, (ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return text.replace("old", "new");
});

Needs a strategy that reads bodies: "helper" or "debugger" (any resource), "page" (page fetch/XHR only) or "extension" on Firefox. Chromium's webRequest can't read bodies — the handler doesn't run there and the Log view says so.`,
    },
    {
        title: "wt.onPage — DOM & title changes",
        body: `Runs in the page in every frame whose own URL matches the route — by default at document_end, once DOMContentLoaded fires (DOM parsed; hydration not finished). If the bundle arrives after that, it runs immediately. Works even when the HTML is service-worker served or hydration re-renders it. Strategies don't apply.

wt.onPage("*://example.com/*", () => {
    document.title = "🎯 " + document.title;
    const h = document.querySelector("h1");
    if (h) h.textContent = "Hello!";
});

The route object takes url, exclude, when and world:

wt.onPage({ url: "*://example.com/*", when: "document_idle" }, () => {
    const el = document.querySelector("h1");
    if (el) el.textContent = "Intercepted";
});

Timing: when: "document_end" (default) | "document_start" | "document_idle"
- document_start — while the HTML is still parsing: <html> exists, head/body usually null. For stubbing globals / observers ahead of page code. MV3: a cold service worker (~50-100ms) can lose the race to early inline scripts
- document_end — DOMContentLoaded (DOM parsed), defer scripts done; images may load and frameworks may not have hydrated yet
- document_idle — after the page's load event (always waits for it, unlike Chrome's run_at document_idle; a slow image delays it)
Already past the moment? Runs immediately.

World: world: "main" (default) | "isolated"
- main — the site's own JavaScript world: it sees the site's globals (window.myApp), and the site can see and tamper with it. It can answer the overlay's calls but not call it
- isolated — a private world with the same DOM and none of the site's JavaScript; it may call the script's overlay. Chrome (MV3) needs user scripts turned on — the Editor shows how

Runs once per document per matching frame. SPA navigations and re-renders don't re-run it (use a MutationObserver inside). Saving the script with the page open re-runs it immediately — keep it idempotent. A script may register several onPage handlers, each with its own route, when and world. The built-in react and valtio aren't available here. Hover "when" or "world" in the Code view for the full reference.`,
    },
    {
        title: "wt.onOverlay — the script's own GUI on the page",
        body: `Runs in the script's overlay: a transparent frame over the tab (top frame only) with its own document. What it draws is visible and clickable; clicks on empty areas go through to the page. The page can't see or restyle it, and strict page CSPs don't stop it. Route and when work as for onPage.

wt.onOverlay("*://example.com/*", (ctx) => {
    const b = document.body.appendChild(document.createElement("button"));
    b.textContent = "Hi";
    b.style.cssText = "position: fixed; right: 16px; bottom: 16px";
    b.onclick = () => wt.log("clicked on", ctx.url);
});

React and valtio are built in: JSX goes in .tsx scripts (name ending in .tsx) and compiles with React's automatic runtime (another runtime: a /** @jsxImportSource <url> */ comment).

import { createRoot } from "react-dom/client";
import { useSnapshot } from "valtio";
const mock = wt.globalStore("mock", { enabled: false });
wt.onOverlay("*://example.com/*", () => {
    function Panel() {
        const snap = useSnapshot(mock);
        return <label><input type="checkbox" checked={snap.enabled} onChange={() => (mock.enabled = !mock.enabled)} /> Mock</label>;
    }
    createRoot(document.body.appendChild(document.createElement("div"))).render(<Panel />);
});

ctx.onNavigate(fn) — runs fn(url) when the page navigates in place (pushState, back/forward, #hash); the overlay stays. Returns a function that stops listening.
ctx.shortcut(keys, fn, { priority }) — runs fn on "Alt+Shift+H", "Mod+K" (Mod = ⌘ on macOS, Ctrl elsewhere), "Shift+F2", "Esc"… Ignored while typing in a field. By default it beats the page (which never sees the key); priority: "after-page" fires only if the page didn't handle it. Returns a function that removes it.

wt.onOverlay("*://app.example.com/*", (ctx) => {
    ctx.shortcut("Alt+Shift+H", () => (box.hidden = !box.hidden));
    ctx.onNavigate((url) => (badge.hidden = !url.includes("/cart")));
});

One overlay per script per tab: every matching onOverlay handler runs in it, sharing the script's top-level variables. Saving the script reloads it (store values stay); disabling removes it. The overlay's own fetch() is the page's (its origin, cookies and CORS; your handlers see it on every strategy but page). The Editor's Preview tab (⌥⇧V) runs it without the page.`,
    },
    {
        title: "Calls between the overlay and the page",
        body: `wt.onPage and wt.onOverlay return a handle to the functions their handler returns. Call them from the other side with await — argument and result types are inferred:

const page = wt.onPage("*://example.com/*", () => ({
    count: (selector: string) => document.querySelectorAll(selector).length,
}));

wt.onOverlay("*://example.com/*", async () => {
    const n = await page.count("a");   // number
});

- A handler that returns a plain object of functions exposes them; any other return value exposes nothing.
- Arguments and results are JSON (≤ 1 MB). A call made before the other side's handler returned waits for it. Errors: WtTimeoutError (10 s), WtCallError (the function threw or doesn't exist, not JSON, the handler isn't running here), DisconnectedError (the overlay closed, the script reloaded, the page navigated).
- The overlay may call any onPage code (top frame). Main-world onPage code can only answer — the site could fake its calls — so calling the overlay needs world: "isolated" (Problems offers that quick fix).
- Register both at the top level of the script (not in a function, if or loop); Problems flags a call elsewhere.
- Main-world results are page data: the site could have changed them. Check them before they decide what your network handlers do.`,
    },
    {
        title: "wt.globalStore / wt.pageStore / wt.fetch — shared state and fetching",
        body: `wt.globalStore(name, initial) — a live object shared by everywhere the script runs: its handlers on every strategy and its overlay. It's a valtio proxy: read and assign like a plain object; import { subscribe } from "valtio" to watch it. Call it at top level, once per name.

const state = wt.globalStore("state", { mocking: true, hits: 0 });
wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => {
    state.hits++;
    if (state.mocking) return { replaceResponse: { body: { mocked: true } } };
});

- initial is used the first time; later the saved values win and initial only adds missing fields
- persist: true (default) survives browser restarts; false only while the browser runs; ["mocking"] only those fields
- values are JSON, ≤ 1 MB per store; a change that breaks that is undone and logged
- a rules handler that reads a store is rebuilt when the store changes

wt.pageStore(name, initial) — the same, but one copy per page: each tab's page starts from initial, and a navigation or reload starts over (a single-page app's route change doesn't). A handler sees the copy of its request's page, an overlay its own page's — so a switch in the overlay can change what the handlers do for that page only.

const page = wt.pageStore("page", { staging: false });
wt.onRequest({ url: "https://api.example.com/*", strategy: "helper" }, (ctx) => {
    if (page.staging) return { redirect: ctx.url.replace("api.", "staging-api.") };
});

- read it before the handler's first await (after it, the handler no longer knows its page and it throws)
- a navigation's own requests belong to the page being left; requests from no page get a throwaway copy of initial
- not kept across browser restarts; not in rules handlers
- both stores: live in isolated-world onPage code (world: "isolated"), like the overlay; main-world onPage code can't use them (the page could read and forge them) — the Problems view warns, with a quick fix
- wt.store was renamed wt.globalStore; calling it throws

wt.fetch(url, init) — fetch for scripts. In handlers it runs in the background with the extension's host permissions (no CORS) and the browser's cookies; in an overlay it fetches as the page by default (from: "background" to switch). bypass: true keeps every script's handlers — this one's too — off the request, e.g. to get the real response a mock replaces:

wt.replaceResponse({ url: "*://api.example.com/user", strategy: "helper" }, async () => {
    const real = await (await wt.fetch("https://api.example.com/user", { bypass: true })).json();
    return { ...real, role: "admin" };
});`,
    },
    {
        title: "onRequest → replaceResponse — mock without the network",
        body: `A final result that synthesizes the response immediately — the request never leaves the browser. First handler to return one wins (stacking).

wt.onRequest({ url: "*://api.example.com/me", strategy: "helper" }, (ctx) => ({
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
        body: `Same rules on every strategy. List order = scripts top to bottom in the Editor, then registration order within a script. Stages run in this order, each over every script before the next:

onRequest → replaceResponse → (network) → onResponseHeaders → onResponseBody

FINAL results (onRequest block/redirect/replaceResponse, a wt.replaceResponse body) — the first one wins and ends the request: no later handler, no later stage. A replaced response never hits the network, onResponseHeaders or onResponseBody.
Header edits (onRequest headers, onResponseHeaders) — all run; per header the LATER handler wins (set or remove).
onResponseBody — transforms COMPOSE: each output feeds the next handler.

Across strategies the layers are page → rules → extension → debugger → helper: a final result hides the request from the layers behind it.

A handler that matched but was skipped logs a warning naming who took priority and why (Network: is:missed). So does a header edit overridden by a later handler.`,
    },
    {
        title: "Async handlers",
        body: `Every handler may be async. replaceResponse/onResponseBody/onPage/onOverlay async works everywhere (onPage and onOverlay handlers aren't awaited).

onRequest/onResponseHeaders async results are awaited on every strategy except "extension" on Chromium (blocking webRequest can't await — an error is logged and the result ignored). Use "helper" or "debugger" there.

// async mock:
wt.replaceResponse({ url: "*://api.example.com/user", strategy: "helper" }, async () => {
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

wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, async (ctx) => {
    const hits = ((await wt.storage.get("hits")) || 0) + 1;
    await wt.storage.set("hits", hits);
    wt.log("hit #" + hits, ctx.url);
});`,
    },
    {
        title: "Strategies — one per handler",
        body: `Each network handler runs on exactly one strategy: the one its route names (required — there is no default; a route without one makes the script fail to load).

helper — Chrome: a tiny local helper (wiretrick-helper) proxies ONLY matched hosts. Sees everything (documents, script tags, images, workers, async handlers, body rewrites) with no banner. Install the helper and trust its helper certificate from Settings → Local helper.
page — page-level fetch/XHR override. No banner, no setup, every browser. Misses <script src>, <img>, documents, and requests made before the page patch loads; no onResponseHeaders.
extension — the extension handles each request (blocking webRequest): Firefox (reaches everything, bodies included), and Chromium browsers that still run MV2 extensions (ungoogled-chromium, Brave, Opera…) — redirect, block, headers and synchronous replaceResponse there, served by redirect; no onResponseBody or async handlers. Not available in MV3.
debugger — chrome.debugger + Fetch domain. Sees everything, but Chrome shows a "debugging" banner while attached.
rules — browser-native rules (declarativeNetRequest): the browser blocks, redirects or sets/removes headers itself, on every request, with no banner or helper. The handler runs once when scripts load and must return a fixed result — ctx.groups.* / ctx.url only as-is in a redirect URL; no replaceResponse, onResponseBody or exclude. A handler that can't be a rule doesn't run and its script shows an error.

wt.onRequest({ url: "*://example.com/*", strategy: "debugger" }, fn);

Pick per browser/build with wt.isChrome / wt.isFirefox / wt.isMV2 / wt.isMV3:

wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "extension" : "helper" }, fn);
wt.onRequest({ url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }, () => ({ block: true }));

No fallback: when the strategy isn't available (helper not running, wrong browser, a kind it can't do), the handler doesn't run and the Log view warns. Hover "strategy" in the Code view, or see the table below for each one's pros and cons (greyed out: not available in this browser).

Tip: ${ADV_SHORT}`,
        table: "strategies",
    },
];
