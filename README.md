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

## How body interception works (`res.modifyResponse`)

- **Firefox** — network-level via `webRequest.filterResponseData`. Nothing else needed.
- **Chrome** — `webRequest` cannot touch bodies there, so three banner-free-first tiers:
  1. **Hook** — a MAIN-world content script overrides `fetch`/`XMLHttpRequest` and
     streams page-initiated responses through your transform (covers most traffic).
  2. **Proxy** — other resources (scripts, CSS, images, fonts) are redirected to an
     extension service worker that fetches the original, transforms it, and serves it
     with the right Content-Type.
  3. **CDP (opt-in)** — `@strategy cdp` uses `chrome.debugger` + Fetch domain for
     main-frame HTML and anything the first two tiers cannot see. Shows the
     "debugging" banner only while active.

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
