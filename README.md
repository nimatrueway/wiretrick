# ResScript Override (v2 — TypeScript rewrite)

A ground-up TypeScript rewrite of [Resource Override](https://github.com/kylepaulsen/ResourceOverride).
Instead of rule lists, the entire interface is a **script editor**: you write small
scripts (Violentmonkey/Tampermonkey style) that declare which URLs they activate on
and what they do — redirect requests, modify request/response headers, transform
response bodies, or replace them entirely. Each script has an enable/disable toggle.

## Writing scripts

```ts
// ==ResScript==
// @name       Mock /api/user
// @match      *://app.example.com/api/user*
// @phase      request,response
// ==/ResScript==

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

Supported metadata: `@name`, `@match` (repeatable), `@include`, `@phase`
(`request`, `response`), `@strategy` (`auto` | `hook` | `proxy` | `cdp` | `webrequest`).

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
// ==ResScript==
// @name       My script
// @match      *://api.example.com/*
// @strategy   hook,cdp        ← try these in order
// ==/ResScript==
```

| strategy | how it works | can see | banner? | notes |
|---|---|---|---|---|
| `hook` | MAIN-world content script overrides `fetch`, `XMLHttpRequest`, `Response` consumers | any request the page's own JS makes (fetch/XHR — the majority of API traffic) | **never** | misses `<script src>`, `<img>`, documents; requires the page context |
| `cdp` | `chrome.debugger` + CDP Fetch domain: pause response → read body → transform → fulfill | **everything**: documents, script tags, images, fonts, XHR — even requests the page didn't initiate | **yes** — Chrome shows a yellow "being debugged" bar while attached | the only network-level path for main-frame HTML and non-JS resources on Chrome; attach/detach is lazy and automatic |
| `proxy` | extension service worker fetches the original and serves it transformed | resources that follow redirects | never | reserved for the MV3 path (DNR-redirect); on MV2 extension SWs can't intercept page loads, so it's only used where wired up |
| `webrequest` | blocking `webRequest` + `filterResponseData` | everything | never | **Firefox-only** (Firefox keeps MV2 network APIs); on Chrome this tier is a no-op |
| `auto` (default) | engine picks per request | — | minimized | resolves to `hook` when the page hook is ready, else `cdp`; skips CDP for main frames when `@mainframes off` |

### Priority lists

Strategies are tried **in listed order** — the first viable one for a given
request wins:

- `@strategy hook,cdp` — banner-free for page fetch/XHR; the debugger only as
  a cold-start fallback (e.g. the very first navigation before the hook loads).
- `@strategy cdp` — debugger only. Main-frame HTML and script-tag rewrites
  always work, at the cost of the banner while requests are in flight.
- `@strategy cdp,hook` — debugger first even for XHR (rare; useful when the
  page's fetch wrapper is hostile to monkey-patching).
- `@strategy hook` — strictly banner-free; requests the hook can't see pass
  through untouched.
- `@strategy webrequest,hook` — Firefox-first: network-level streaming when
  available, page hook otherwise.

Invalid names are dropped; a list that ends up empty falls back to `auto`.

### Banner minimization (what the engine does on its own)

- **Learning**: the engine records which resource types each script actually
  matches. A script observed ≥3 times matching only fetch/XHR is treated as
  permanently hook-covered — it will never trigger the debugger again.
- **Lazy attach**: the debugger attaches only when a CDP-relevant script
  matches an in-flight request, and detaches ~8s after the page settles —
  the banner clears while you keep browsing.
- **`@mainframes off`**: declare that a script only targets API/subresource
  responses. Main-frame HTML is then never intercepted by CDP for it
  (combine with `res.onDom` for page changes — see below).
- **Claim dedup**: when the hook transforms a request, the CDP tier skips it
  (no double transforms).

### Which strategy for which job?

- Mock/transform **JSON APIs** → default `auto` (hook covers it; no banner).
- Rewrite **page HTML / titles in the raw response** → `cdp` (or default
  auto; the main frame always goes through CDP on Chrome).
- Change **title/DOM after render** → `res.onDom` — no network interception
  at all, works even when the HTML is service-worker served or hydration
  re-renders it (this is the resilient choice for SPA title/DOM tweaks).
- **Firefox users** → everything is network-level via `webrequest`, no
  banners, ever.

## MV3 readiness

All browser-specific behavior lives behind one `InterceptionStrategy` interface
(`src/background/engine/strategies/`). Migrating to MV3 later means: Tier A is
unchanged, Tier B swaps the webRequest redirect for `declarativeNetRequest`, Tier C
is unchanged — the pipeline, runtime, and editor don't move.

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
