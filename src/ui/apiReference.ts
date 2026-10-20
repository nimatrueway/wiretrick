/** API reference content for the in-app "?" help dialog. */

export interface ApiSection {
    title: string;
    body: string;
}

export const API_REFERENCE: ApiSection[] = [
    {
        title: "Script structure — res.declareScript",
        body: `Every active script declares itself with res.declareScript. A source file WITHOUT it is a library: inert on its own (never matches, hidden from the popup) but importable by other scripts.

const cfg = res.declareScript({
    match: ["*://example.com/*", "*://api.example.com/v1/*"],
    include: [],                        // extra URL patterns
    phase: ["request", "response"],     // which events run (default: both)
    strategy: ["auto"],                 // or hook | proxy | cdp | webrequest priority list
    runAt: "document_idle",             // default onDom timing
});

Patterns are star patterns: * matches anything, ** the same (groups are remembered for replace patterns).`,
    },
    {
        title: "Libraries — import other scripts",
        body: `Any saved script that doesn't call res.declareScript is a library module. Import its exports from another script by name:

// library script named "utils" (saved as utils.ts):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";
res.declareScript({ match: ["*://example.com/*"] });
res.log(double(21)); // 42

Imports work in every tier (background compiles + the page-side onDom hook); libraries ship with the page bundle automatically. "./utils", "utils", "utils.ts" all resolve.`,
    },
    {
        title: "res.declareScript — meta + parameters, type-safe",
        body: `Meta + parameters in one type-safe call. Params are adjustable from the popup's ⚙ dialog without editing the script, and come back typed:

const cfg = res.declareScript({
    match: ["*://example.com/*"],
    strategy: ["hook", "cdp"],
    runAt: "document_idle",
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

Tiers on Chrome: page fetch/XHR goes through a banner-free hook; documents, script tags and other "direct" resources go through the debugger (a yellow banner appears briefly while they load). On Firefox everything is network-level without a banner. Pin a tier with the strategy field in res.declareScript.`,
    },
    {
        title: "res.onDom — DOM & title changes",
        body: `Runs at DOM-ready in the page (MAIN world): the handler executes once when DOMContentLoaded fires (DOM parsed; hydration not finished). If the bundle arrives after that, it runs immediately. Works even when the HTML is service-worker served or hydration re-renders it.

res.onDom(() => {
    document.title = "🎯 " + document.title;
    const h = document.querySelector("h1");
    if (h) h.textContent = "Hello!";
});

Options (2nd argument): { when: ... } — choose the moment:

res.onDom(() => {
    const el = document.querySelector("h1");
    if (el) el.textContent = "Intercepted";
}, { when: "document_idle" });

Timing: { when: "DOMContentLoaded" (default) | "document_start" | "document_end" | "document_idle" }
- DOMContentLoaded — DOM parsed, hydration not guaranteed
- document_start — at hook install, before page scripts; no document.body yet
- document_end — same moment as DOMContentLoaded
- document_idle — after window load (page fully settled); runs immediately if already loaded`,
    },
    {
        title: "onRequest.respond — mock without the network",
        body: `A terminal result that synthesizes the response immediately — the request never leaves the browser. First script to respond wins (stacking).

res.onRequest((ctx) => ({
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

strategy lists (res.declareScript) decide the tier per script, not the stacking order.`,
    },
    {
        title: "Async handlers",
        body: `Every hook accepts async handlers. replaceResponse/modifyResponse/onDom async works everywhere.

onRequest/onResponseHeaders async results: honored natively on Firefox; on Chrome they need "cdp" in the strategy list (the blocking webRequest can't await — a warning is logged and the result ignored otherwise).

// async mock:
res.replaceResponse(async () => {
    const data = await fetch("https://myserver/fixture").then(r => r.json());
    return JSON.stringify(data);
});

// async redirect via cdp tier:
res.declareScript({ match: ["*://example.com/*"], strategy: ["hook", "cdp"] });
res.onRequest(async (ctx) => {
    const target = await decideUpstream(ctx.url);
    return { redirect: target };
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
proxy — MV3: routes to the debugger tier (script tags, images, CSS…); unused on MV2.
cdp — chrome.debugger + Fetch domain. Sees everything, but Chrome shows a "debugging" banner while attached; the engine attaches only while needed and detaches when idle.
process — Chrome: a tiny local helper (rescript-helper) proxies ONLY matched hosts. Sees everything (documents, script tags, images, async handlers, body rewrites) with no banner and no flags. Opt-in: install the helper and trust its CA from the manager.
Scripts that only ever match fetch/XHR are learned to be hook-only and never trigger the banner.`,
    },
    {
        title: "strategy — priority list (res.declareScript)",
        body: `Pick strategies per script; the first viable one per request wins.

strategy: ["hook", "cdp"]   // banner-free for XHR; debugger only as cold-start fallback
strategy: ["cdp"]           // debugger only (main-frame HTML + script tags always work)
strategy: ["cdp", "hook"]         // debugger first, even for XHR
strategy: ["hook"]                // strictly banner-free; unhookable requests pass through
strategy: ["webrequest", "hook"]  // Firefox network-level first
strategy: ["process", "hook"]     // Chrome: local helper first, hook if it isn't running

Tier C (debugger) participates ONLY when the list contains "cdp" or is
the single default "auto" — explicit hook/webrequest lists never show
the banner. See the README's "Interception strategies" section for the
full matrix and the engine's automatic banner minimization.`,
    },
];
