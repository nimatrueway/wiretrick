# Development

[← README](../README.md)

```bash
npm install
npm run build        # bundle to dist/
npm run watch        # rebuild on change
npm test             # vitest unit tests
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

## Releases

Pushing a `vX.Y.Z` tag runs the GitHub Action (typecheck → tests → build →
zips + signed `.crx` → helper binaries → GitHub release), so the artifacts
always match the tagged `manifest.json` version.

The helper is versioned separately in `helper/Cargo.toml`: bump it only when
the helper changes. When the extension starts depending on new helper
behavior, also raise `MIN_HELPER_VERSION` in `src/shared/helperInstall.ts` —
older helpers then log an upgrade error. Every release still ships helper
binaries, so the install command always fetches the newest one.

## How the MV3 build works

`npm run build` produces both bundles:

- **`dist/` (= `dist-mv2/`)** — the MV2 build.
- **`dist-mv3/`** — the Manifest V3 build (`manifest_version: 3`,
  background service worker, `action`, `host_permissions`).

How MV3 differs (Chrome forbids `eval` in service workers and extension
pages, and drops blocking `webRequest`):

- **User scripts compile and run in a sandbox page.** The manifest's
  `sandbox` key exempts `sandbox.html` from the extension CSP — it's the
  only MV3 context where `new Function` is allowed. The service worker
  routes compiles/ executions there through an offscreen document
  (`offscreen.html` bridges chrome.runtime ⇄ iframe postMessage). Handler
  results, script logs and `wt.storage` round-trip back over the same
  channel.
- **The hook tier carries page fetch/XHR interception** (patching in the
  page's MAIN world — same behavior, transforms execute in the sandbox).
  The `webrequest` tier is gone (no blocking webRequest in MV3).
- **Browser-initiated loads (`<script src>`, `<img>`, stylesheets, fonts,
  main-frame HTML) go through the debugger tier** for scripts whose
  `strategy` lists `cdp` (or through the local helper with `process`).
  The service worker
  drives `chrome.debugger` / CDP `Fetch` (pausing only URLs matching those
  scripts' `match` patterns, XHR/fetch excluded — the hook handles them);
  handler decisions (`onRequest`, `replaceResponse`, `modifyResponse`) are
  computed in the sandbox, so only the participating scripts apply.
  `auto`/`hook` scripts stay hook-only (a warning hints to add `"cdp"`).
  Caveats:
  - Chrome shows its "started debugging this browser" banner, and every
    http(s) tab is attached while such scripts exist (the resource's CDN
    host rarely equals the tab's host).
  - A very fast first navigation can load a resource before the debugger
    attaches; that is logged as a **warning** naming the URL and scripts
    ("loaded BEFORE the debugger attached … Reload the tab") — a reload is
    intercepted (tabs stay attached).
  - `onResponseHeaders` is applied at the Response stage
    (`Fetch.continueResponse` keeps the body streaming when no body handler
    changes it); redirects/error statuses pass through untransformed.
  - Extra permissions: `debugger`, `webNavigation` (attach as early as
    `onBeforeNavigate`), `webRequest` (observe-only, for the miss warning).
- **Folder sync works** — the poller runs in the service worker: a 25s
  keep-alive ping (any extension API call resets the SW's ~30s idle
  timer) holds the worker open while a folder is connected, with a 30s
  `chrome.alarms` poll as the fallback if the worker is reaped anyway.
- onDom runs in the page (MAIN world when the page CSP allows, isolated
  fallback otherwise). **`document_start` timing caveat:** in MV2 the
  always-alive background answers the bundle in ~1ms, so onDom handlers
  reliably beat the page's own scripts. In MV3 the service worker must
  wake first — analyses are cached in `chrome.storage.session` (and
  refreshed on every script change), so the bundle is served from storage
  without waking the sandbox, but a cold SW still costs ~50-100ms; inline
  page scripts may run before an onDom handler does. Fetch/XHR
  interception is unaffected.

Verify the MV3 bundle: `npx tsx test/mv3.e2e.ts` (SW registration, manager,
script save/list through the sandbox, settings.yaml, hook-tier interception,
debugger-tier `<script src>` interception incl. gzip, lazy chunks and reloads).
