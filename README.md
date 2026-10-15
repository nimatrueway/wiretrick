# ResScript Override (v2 — TypeScript rewrite)

A ground-up TypeScript rewrite of [Resource Override](https://github.com/kylepaulsen/ResourceOverride).
Instead of rule lists, the entire interface is a **script editor**: you write small
scripts (Violentmonkey/Tampermonkey style) that declare which URLs they activate on
and what they do — redirect requests, modify request/response headers, transform
response bodies, or replace them entirely. Each script has an enable/disable toggle.

**The manager** (script list, Monaco editor with IntelliSense, live LOG panel):

![ResScript manager — script list, Monaco editor, LOG panel](docs/shots/manager.png)

**The popup** (toolbar quick-toggle for the active tab's scripts):

![ResScript popup — scripts active on the current tab](docs/shots/popup.png)

**Sample scripts** (? → Samples — ten one-click starters):

![ResScript samples dialog](docs/shots/samples.png)

## Install

**From a release (recommended):**

1. Grab `rescript-override-vX.Y.Z.zip` from [Releases](https://github.com/nimatrueway/rescript-override/releases) and unzip it.
2. Open `chrome://extensions` (or `about:debugging#/runtime/this-firefox` on Firefox).
3. Enable **Developer mode** (top-right), click **Load unpacked**, and select the unzipped `dist` folder.
4. Pin the 🧩 icon — the badge shows how many scripts are active on the current tab.

**From source:**

```bash
git clone https://github.com/nimatrueway/rescript-override.git
cd rescript-override
npm install && npm run build
# then: chrome://extensions → Developer mode → Load unpacked → dist/
```

> Requires an MV2-capable Chromium (ungoogled-chromium or any Chromium ≤ ~126) or
> Firefox. Modern stable Chrome (155+) removed MV2 and will refuse to load it.

**Releases are automated** — pushing a `vX.Y.Z` tag runs the GitHub Action
(typecheck → tests → build → zip → GitHub release), so the zip always matches
the tagged `manifest.json` version.

## Writing scripts

```ts
res.declareScript({
    match: ["*://app.example.com/api/user*"],
});

// Redirect / cancel / request headers (synchronous):
res.onRequest((ctx) => {
    // return { redirect: "https://myserver/user.json" };
    // return { cancel: true };
    return { headers: { set: { "x-debug": "1" } } };
});

// Response headers:
res.onResponseHeaders((ctx) => {
    return { headers: { set: { "access-control-allow-origin": "*" } } };
});

// Replace the whole body:
// res.replaceResponse(() => JSON.stringify({ mocked: true }));

// Stream-modify the body:
res.modifyResponse((ctx, body) => body.replace('"role":"user"', '"role":"admin"'));
```

`res.declareScript` is the only way to activate a script — there is no
comment-block metadata. A source file without it is a **library**: inert on
its own (never matches, hidden from the popup) but importable by other
scripts:

```ts
// saved script named "utils" (utils.ts in the synced folder):
export function forceFail(url: string) { /* ... */ }

// in your script:
import { forceFail } from "./utils";   // "./utils", "utils", "utils.ts" all resolve
```

### Parameters — adjustable knobs

`params` are typed knobs the user changes from the popup's ⚙ dialog without
touching the script:

```ts
const cfg = res.declareScript({
    match: ["*://app.example.com/*"],
    strategy: ["hook", "cdp"],
    params: {
        enabled: { type: "boolean", default: true, description: "Master switch" },
        status:  { type: "enum", choices: ["500", "503"], default: "500" },
        note:    { type: "string", default: "forced failure" },
        tags:    { type: "stringList", default: [] },
    },
});
// cfg.enabled: boolean · cfg.status: "500" | "503" · cfg.note: string · cfg.tags: string[]

res.onRequest((ctx) => {
    if (!cfg.enabled) return;
    return { respond: { status: Number(cfg.status), body: { error: cfg.note, tags: cfg.tags } } };
});
```

Param values persist per script and apply on save — the change hot-reloads
like a code edit. Parameter types: `boolean` (switch), `string` (text),
`enum` (dropdown of `choices`), `stringList` (add/remove list).

## Editor

The manager page embeds **Monaco** (the VS Code editor) with full TypeScript
IntelliSense for the `res` API — completions, hover docs, and diagnostics work
out of the box. Cmd/Ctrl+S saves and hot-applies the script.

### Dedicated scripts folder

Click **Folder…** and pick a folder (e.g. `~/ResScripts`) — that becomes your
scripts home: every script is written there as a `.ts` file along with
`res-api.d.ts` and `jsconfig.json`. Edit in VS Code (or any editor) with full
TypeScript completions; saves hot-reload into the engine instantly.

Sync is two-way and watches the folder for **creates, renames/moves and
deletes** too: a new `.ts` file becomes a script, deleting a file removes its
script, renaming a file renames the script. The folder choice is remembered —
the manager reconnects automatically on open (one click to re-grant after a
browser restart, per Chrome's File System Access rules).

## Interception strategies — how bodies get modified

Chrome and Firefox have fundamentally different extension APIs, and Chrome
itself can only reach some resources through some paths. ResScript therefore
has **interception strategies** — pickable per script, individually or as a
**comma-separated priority list**:

```ts
res.declareScript({
    match: ["*://api.example.com/*"],
    strategy: ["hook", "cdp"],   // ← try these in order
});
```

| strategy | how it works | can see | banner? | notes |
|---|---|---|---|---|
| `hook` | MAIN-world content script overrides `fetch`, `XMLHttpRequest`, `Response` consumers | any request the page's own JS makes (fetch/XHR — the majority of API traffic) | **never** | misses `<script src>`, `<img>`, documents; requires the page context |
| `cdp` | `chrome.debugger` + CDP Fetch domain: pause response → read body → transform → fulfill | **everything**: documents, script tags, images, fonts, XHR — even requests the page didn't initiate | **yes** — Chrome shows a yellow "being debugged" bar while attached | the only network-level path for main-frame HTML and non-JS resources on Chrome; attach/detach is lazy and automatic |
| `proxy` | extension service worker fetches the original and serves it transformed | resources that follow redirects | never | reserved for the MV3 path (DNR-redirect); on MV2 extension SWs can't intercept page loads, so it's only used where wired up |
| `webrequest` | blocking `webRequest` + `filterResponseData` | everything | never | **Firefox-only** (Firefox keeps MV2 network APIs); on Chrome this tier is a no-op |
| `auto` (default) | engine picks per request | — | minimized | resolves to `hook` when the page hook is ready, else `cdp` |

### Priority lists

Strategies are tried **in listed order** — the first viable one for a given
request wins:

- `strategy: ["hook", "cdp"]` — banner-free for page fetch/XHR; the debugger only as
  a cold-start fallback (e.g. the very first navigation before the hook loads).
- `strategy: ["cdp"]` — debugger only. Main-frame HTML and script-tag rewrites
  always work, at the cost of the banner while requests are in flight.
- `strategy: ["cdp", "hook"]` — debugger first even for XHR (rare; useful when the
  page's fetch wrapper is hostile to monkey-patching).
- `strategy: ["hook"]` — strictly banner-free; requests the hook can't see pass
  through untouched.
- `strategy: ["webrequest", "hook"]` — Firefox-first: network-level streaming when
  available, page hook otherwise.

Invalid names are dropped; a list that ends up empty falls back to `auto`.

**Tier C participation is strict**: the debugger is only ever used when the
script's list explicitly contains `cdp` (or is the single default `auto`).
A script with `strategy: ["hook"]` / `["hook", "proxy"]` / `["webrequest"]` will never
attach the debugger for any request.

### Banner minimization (what the engine does on its own)

- **Learning**: the engine records which resource types each script actually
  matches. A script observed ≥3 times matching only fetch/XHR is treated as
  permanently hook-covered — it will never trigger the debugger again.
- **Lazy attach**: the debugger attaches only when a CDP-relevant script
  matches an in-flight request, and detaches ~8s after the page settles —
  the banner clears while you keep browsing.
- **Strict tier gating**: a script whose list has no `cdp` (e.g.
  `strategy: ["hook"]`) never attaches the debugger for anything — main frames
  included; use `res.onDom` for page changes instead.
- **Claim dedup**: when the hook transforms a request, the CDP tier skips it
  (no double transforms).
- **Strict page CSP fallback**: if a page's own CSP forbids `eval` (so the
  hook cannot compile scripts in that page at all), the hook reports it and
  the tab automatically falls back to the CDP tier for body transforms —
  features keep working, the banner shows while it does.

### `res.onDom` — exact execution semantics

`res.onDom` is not a network strategy — it registers a **DOM-ready callback
that runs inside the page's MAIN world** (the same world as the page's own
JS). Exact timing:

1. **Injection**: our bridge content script (`document_start`, isolated
   world) injects `hook.js` into the page via a script tag before any page
   script runs. The hook loads, fetches the scripts matching this page from
   the background, compiles them, and patches `fetch`/`XMLHttpRequest`.
2. **Registration**: while compiling, any `res.onDom(handler)` calls are
   captured (the handler is stored, not yet run).
3. **Execution**: the captured handlers run exactly once, when the
   `DOMContentLoaded` event fires — i.e. the full DOM is parsed and queryable,
   but stylesheets/images may still be loading, and framework hydration
   (React/Vue) has *not* necessarily finished yet.
   - If the hook's bundle arrives **after** `DOMContentLoaded` already fired
     (late bundle, bfcache restore), handlers run immediately at
     registration time.
4. **Context**: handlers run as page JS — full DOM access, `document.title`
   writes, observers, etc. They can be `async` (the engine doesn't await
   them). `ctx` is the same request-context shape (`url`, `method`, …) with
   the page URL.
5. **Timing options**: pass `{ when }` as the second argument to choose the
   moment (mirrors content-script `run_at`):

   ```ts
   res.onDom(() => { ... });                             // default: DOMContentLoaded
   res.onDom(() => { ... }, { when: "document_start" }); // at hook install, pre-DOM
   res.onDom(() => { ... }, { when: "document_end" });   // DOM parsed
   res.onDom(() => { ... }, { when: "document_idle" });  // after window load
   ```

   - `DOMContentLoaded` (default) — DOM parsed; hydration not guaranteed.
   - `document_start` — runs immediately at hook install, before page
     scripts and before `document.body` exists (register observers/stubs).
   - `document_end` — same moment as DOMContentLoaded.
   - `document_idle` — after `load`; the whole page settled. Runs
     immediately if load already happened.

   On hard navigations the hook re-runs everything (new page, new bundle).
   On SPA soft navigations (pushState) no hook re-fires — register your own
   MutationObserver inside the handler.

Because it runs as page JS, `res.onDom` works regardless of how the response
arrived — service-worker-served HTML, cached pages, or hydration overwriting
a CDP transform — which is exactly why it's the resilient choice for
title/DOM changes on SPAs.

### Which strategy for which job?

- Mock/transform **JSON APIs** → default `auto` (hook covers it; no banner).
- Rewrite **page HTML / titles in the raw response** → `cdp` (or default
  auto; the main frame always goes through CDP on Chrome).
- Change **title/DOM after render** → `res.onDom` — no network interception
  at all, works even when the HTML is service-worker served or hydration
  re-renders it (the resilient choice for SPA title/DOM tweaks).
- **Never see the banner at all** → `strategy: ["hook"]` and combine with
  `res.onDom` for anything the hook can't reach.
- **Firefox users** → everything is network-level via `webrequest`, no
  banners, ever.

## MV3 readiness

All browser-specific behavior lives behind one `InterceptionStrategy` interface
(`src/background/engine/strategies/`). Migrating to MV3 later means: Tier A is
unchanged, Tier B swaps the webRequest redirect for `declarativeNetRequest`, Tier C
is unchanged — the pipeline, runtime, and editor don't move.

## Multiple scripts — how handlers stack

When several enabled scripts match the same request, they run in **list
order** (top to bottom in the manager) with per-hook rules:

**`res.onRequest`** — the first script that returns a *terminal* result
(`respond`, `redirect`, or `cancel`) wins and stops the chain; later scripts
don't run for that request. Scripts that return nothing (or only `headers`)
don't stop the chain — their header changes merge (later `set` wins per key,
`remove` accumulates) and apply even when a later script terminates.

**`respond`** — a terminal result that synthesizes the response immediately,
**without the network request ever happening**:

```ts
res.onRequest((ctx) => ({
    respond: {
        body: { id: 1, name: "Mocked User" },  // object → JSON; strings/bytes pass through
        status: 200,                            // default 200
        mime: "application/json",               // default: guessed from the URL
        headers: { set: { "x-mock": "1" } },
    },
}));
```

It stacks like every terminal result: first script to `respond` wins. On the
hook tier (fetch/XHR) the response is fully synthesized (status/headers
included); on the webRequest tier it materializes as a data-URL redirect
(status becomes 200 there); with `"cdp"` in `strategy` the request-stage
fulfill honors status and headers.

**`res.onResponseHeaders`** — all matching scripts run and their changes
**merge**: `set` keys are applied in order (a later script's `set` of the
same header overwrites earlier ones), `remove` lists accumulate.

**`res.modifyResponse`** — transforms **compose** like a pipeline: script A's
output becomes script B's input, in list order.

```text
body → [script 1 transform] → [script 2 transform] → … → page
```

**`res.replaceResponse`** — the first script that returns a body wins;
later ones are skipped.

**Across strategies**: a script's `strategy` list only decides *which tier*
runs its handler — stacking order between scripts is unchanged regardless of
which tier each one uses.

## Async handlers

All `res.*` hooks accept `async` handlers (returning a Promise). What happens
with the result depends on the tier:

| hook | hook tier (page fetch/XHR) | webRequest tier (Chrome) | webRequest tier (Firefox) | cdp tier (Chrome, `strategy: ["cdp"]`) |
|---|---|---|---|---|
| `onRequest` redirect/cancel | n/a (hook doesn't redirect) | ⚠ result ignored, warning logged — blocking webRequest can't await; use `strategy: ["cdp"]` | ✅ awaited natively | ✅ awaited at the Request stage (redirect/cancel honored) |
| `onRequest` headers | n/a | ⚠ ignored + warning | ✅ awaited | ✅ awaited, applied at the Response stage |
| `onResponseHeaders` | n/a | ⚠ ignored + warning | ✅ awaited | ✅ awaited, merged into the fulfilled headers |
| `replaceResponse` | ✅ awaited — the page's `fetch`/XHR promise simply takes as long as the handler needs | ⚠ result ignored (a sync data-URL can't be built late) → the request is re-routed to the cdp tier | ✅ awaited, then redirect | ✅ awaited, fulfills the body |
| `modifyResponse` | ✅ awaited (chained between scripts) | — (re-routed to cdp) | ✅ awaited per chunk | ✅ awaited |
| `onDom` | ✅ awaited (fire-and-forget) | — | — | — |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `res.modifyResponse(async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/cancel decided asynchronously** (e.g. after an API lookup)?
  Add `"cdp"` to `strategy` (`strategy: ["hook", "cdp"]`) so the CDP tier can await
  your handler; note the debugger banner appears while such requests are
  intercepted. Without `cdp`, an async `onRequest` on Chrome logs a warning
  and the request proceeds unmodified.
- **Async header changes** on Chrome likewise need `strategy: ["cdp"]`.
- **Static replacement from an async source** (file read, fetch): async
  `replaceResponse` + default strategy is all you need.

## Debugging

The manager page has a **⬇ Logs** button that downloads the full debug log —
every engine decision (webRequest dispatches, hook bundles, CDP pauses,
transforms) with timestamps. Attach it when reporting issues.

## Development

```bash
npm install
npm run build        # bundle to dist/
npm run watch        # rebuild on change
npm test             # vitest — matcher (ported), metaParser, engine pipeline
npm run typecheck
npm run test:e2e     # full browser e2e (needs E2E_CHROMIUM, see below)
```

The e2e suite (`test/e2e.ts`) launches a fresh MV2-capable Chromium, loads the
extension, seeds sample scripts through the real manager page, and verifies
every tier against a local HTTP server: matcher, redirect, cancel, request +
response headers, replaceResponse (main frame + fetch), modifyResponse (fetch /
XHR / script-tag CDP), per-tab badge, and enable/disable toggling.

```bash
# any Chromium that still supports MV2 (Chrome for Testing ≤ ~126 works):
E2E_CHROMIUM="/path/to/Google Chrome for Testing" npm run test:e2e
```

Load the extension from `dist/` ("Load unpacked", MV2), or any recent Firefox
(callback-based APIs work everywhere).
