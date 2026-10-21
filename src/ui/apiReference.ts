/** API reference content for the in-app "?" help dialog. */

export interface ApiSection {
    title: string;
    body: string;
}

export const API_REFERENCE: ApiSection[] = [
    {
        title: "Script structure — wt.declareScript",
        body: `Every active script declares itself with wt.declareScript. A source file WITHOUT it is a library: inert on its own (never matches, hidden from the popup) but importable by other scripts.

const cfg = wt.declareScript({
    match: ["*://example.com/*", "*://api.example.com/v1/*"],
    include: [],                        // extra URL patterns
    strategy: ["auto"],                 // or hook | cdp | webrequest | process priority list
});

Patterns are star patterns: * matches anything, ** the same (groups are remembered for replace patterns).`,
    },
    {
        title: "Libraries — import other scripts",
        body: `Any saved script that doesn't call wt.declareScript is a library module. Import its exports from another script by name:

// library script named "utils" (saved as utils.ts):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";
wt.declareScript({ match: ["*://example.com/*"] });
wt.log(double(21)); // 42

Imports work in every tier (background compiles + the page-side onDom hook); libraries ship with the page bundle automatically. "./utils", "utils", "utils.ts" all resolve.`,
    },
    {
        title: "wt.declareScript — meta + parameters, type-safe",
        body: `Meta + parameters in one type-safe call. Params are adjustable from the popup's ⚙ dialog without editing the script, and come back typed:

const cfg = wt.declareScript({
    match: ["*://example.com/*"],
    strategy: ["hook", "cdp"],
    params: {
        enabled: { type: "boolean", default: true, description: "Master switch" },
        status: { type: "enum", choices: ["500", "503"], default: "500" },
        note: { type: "string", default: "forced" },
        body: { type: "string", multiline: true, default: "" }, // textarea; YAML block scalar in settings.yaml
        hosts: { type: "stringList", default: [] },
    },
});
// cfg.enabled: boolean, cfg.status: "500" | "503", cfg.note: string, cfg.hosts: string[]

Scripts sync to the folder as plain <name>.ts files.`,
    },
    {
        title: "wt.onRequest — redirect, cancel, request headers",
        body: `Runs before the request leaves the browser. Must be synchronous.

wt.onRequest((ctx) => {
    // ctx: { url, method, tabUrl, resourceType, requestHeaders }
    return { redirect: "https://other.com/x" };  // or…
    return { cancel: true };                     // or…
    return { headers: { set: { "x-a": "1" }, remove: ["x-b"] } };
});`,
    },
    {
        title: "wt.onResponseHeaders — modify response headers",
        body: `Runs when response headers arrive. Synchronous.

wt.onResponseHeaders((ctx) => {
    // ctx adds: statusLine, responseHeaders
    return { headers: { set: { "access-control-allow-origin": "*" } } };
});`,
    },
    {
        title: "wt.replaceResponse — replace the body",
        body: `Return a string, bytes, or { file }. The response is fully replaced.

wt.replaceResponse((ctx) => JSON.stringify({ mocked: true }));

// or serve file content:
wt.replaceResponse(() => ({ file: "data:text/html;base64,…" }));`,
    },
    {
        title: "wt.modifyResponse — transform the body",
        body: `Stream/transform the body. Return the new body (string or bytes); async is fine.

wt.modifyResponse((ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return text.replace("old", "new");
});

Tiers on Chrome: page fetch/XHR goes through a banner-free hook; documents, script tags and other "direct" resources go through the debugger (a yellow banner appears briefly while they load). On Firefox everything is network-level without a banner. Pin a tier with the strategy field in wt.declareScript.`,
    },
    {
        title: "wt.onDom — DOM & title changes",
        body: `Runs at DOM-ready in the page (MAIN world): the handler executes once when DOMContentLoaded fires (DOM parsed; hydration not finished). If the bundle arrives after that, it runs immediately. Works even when the HTML is service-worker served or hydration re-renders it.

wt.onDom(() => {
    document.title = "🎯 " + document.title;
    const h = document.querySelector("h1");
    if (h) h.textContent = "Hello!";
});

Options (2nd argument): { when: ... } — choose the moment:

wt.onDom(() => {
    const el = document.querySelector("h1");
    if (el) el.textContent = "Intercepted";
}, { when: "document_idle" });

Timing: { when: "DOMContentLoaded" (default) | "document_start" | "document_end" | "document_idle" } — each script keeps its own
- document_start — while the HTML is still parsing: <html> exists, head/body usually null. For stubbing globals / observers ahead of page code. MV3: a cold service worker (~50-100ms) can lose the race to early inline scripts
- DOMContentLoaded — HTML parsed, defer scripts done; images may load and frameworks may not have hydrated yet
- document_end — alias of DOMContentLoaded
- document_idle — after window load (always waits for it; a slow image delays it)
Already past the moment? Runs immediately.

Runs once per document in every frame whose own URL matches. SPA navigations and re-renders don't re-run it (use a MutationObserver inside). Saving the script with the page open re-runs it immediately — keep it idempotent. One onDom per script (a later call replaces the earlier). Hover "when" in the editor for the full reference.`,
    },
    {
        title: "onRequest.respond — mock without the network",
        body: `A terminal result that synthesizes the response immediately — the request never leaves the browser. First script to respond wins (stacking).

wt.onRequest((ctx) => ({
    respond: {
        body: { id: 1, name: "Mocked User" },  // object → JSON
        status: 200,
        mime: "application/json",
        headers: { set: { "x-mock": "1" } },
    },
}));

Full status/headers support on the hook and cdp tiers; the webRequest tier serves it as a data-URL redirect (status becomes 200 there).`,
    },
    {
        title: "Multiple scripts — stacking order",
        body: `Scripts run in list order (top of the manager first) when several match one request:

onRequest — first TERMINAL result (redirect/cancel) wins and stops the chain; headers-only/void results don't stop it.
onResponseHeaders — ALL matching scripts run; set applied in order (later overwrites), remove accumulates.
modifyResponse — transforms COMPOSE: each output feeds the next script.
replaceResponse — first script returning a body wins.

strategy lists (wt.declareScript) decide the tier per script, not the stacking order.`,
    },
    {
        title: "Async handlers",
        body: `Every hook accepts async handlers. replaceResponse/modifyResponse/onDom async works everywhere.

onRequest/onResponseHeaders async results: honored natively on Firefox; on Chromium they need "cdp" or "process" in the strategy list (the blocking webRequest can't await — a warning is logged and the result ignored otherwise).

// async mock:
wt.replaceResponse(async () => {
    const data = await fetch("https://myserver/fixture").then(r => r.json());
    return JSON.stringify(data);
});

// async redirect via cdp tier:
wt.declareScript({ match: ["*://example.com/*"], strategy: ["hook", "cdp"] });
wt.onRequest(async (ctx) => {
    const target = await decideUpstream(ctx.url);
    return { redirect: target };
});`,
    },
    {
        title: "wt.storage / wt.log",
        body: `Per-script key/value storage (async), and logging into the LOG panel.

wt.onRequest(async (ctx) => {
    const hits = ((await wt.storage.get("hits")) || 0) + 1;
    await wt.storage.set("hits", hits);
    wt.log("hit #" + hits, ctx.url);
});`,
    },
    {
        title: "Tiers & the debugger banner",
        body: `hook — page-level fetch/XHR override. Banner-free. Misses <script src>, <img>, documents.
cdp — chrome.debugger + Fetch domain. Sees everything, but Chrome shows a "debugging" banner while attached; the engine attaches only while needed and detaches when idle.
webrequest — blocking webRequest: Firefox, and Chromium browsers that still run MV2 extensions (ungoogled-chromium, Brave, Opera…). Redirect, cancel, headers and synchronous respond/replaceResponse everywhere; response-body streaming (modifyResponse) and awaiting async handlers are Firefox-only. Not available in MV3.
process — Chrome: a tiny local helper (wiretrick-helper) proxies ONLY matched hosts. Sees everything (documents, script tags, images, async handlers, body rewrites) with no banner and no flags. Opt-in: install the helper and trust its CA from the manager.
Scripts that only ever match fetch/XHR are learned to be hook-only and never trigger the banner.`,
    },
    {
        title: "strategy — priority list (wt.declareScript)",
        body: `Pick strategies per script; the first viable one per request wins.

strategy: ["hook", "cdp"]   // banner-free for XHR; debugger only as cold-start fallback
strategy: ["cdp"]           // debugger only (main-frame HTML + script tags always work)
strategy: ["cdp", "hook"]         // debugger first, even for XHR
strategy: ["hook"]                // strictly banner-free; unhookable requests pass through
strategy: ["webrequest", "hook"]  // network-level (blocking webRequest) first
strategy: ["process", "hook"]     // Chrome: local helper first, hook if it isn't running

Tier C (debugger) participates ONLY when the list contains "cdp" or is
the single default "auto" — explicit hook/webrequest lists never show
the banner. See the README's "Interception strategies" section for the
full matrix and the engine's automatic banner minimization.`,
    },
];
