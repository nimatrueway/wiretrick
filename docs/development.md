# Development

[← README](../README.md) · [Glossary](../GLOSSARY.md)

```bash
npm install
npm run build        # bundle to dist/
npm run watch        # rebuild on change
npm test             # vitest unit tests
npm run typecheck
npm run test:e2e     # full browser e2e (needs E2E_CHROMIUM, see below)
```

The e2e suite (`test/e2e.ts`) launches a fresh MV2-capable Chromium, loads the
extension, seeds sample scripts through the real Editor page, and verifies
every strategy against a local HTTP server: matcher, redirect, block, request +
response headers, replaceResponse (main frame + fetch), onResponseBody (fetch /
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

- **`dist/` (= `dist-mv2/`)** — the MV2 build for Chromium.
- **`dist-firefox/`** — the same MV2 build for Firefox (the `.xpi`): its
  manifest also registers the page hook as a MAIN-world content script,
  which Chromium's MV2 rejects ("The 'world' property is restricted…").
  On Chromium MV2 the bridge injects the hook with a `<script>` tag instead.
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
- **The `page` strategy carries page fetch/XHR interception** (patching in the
  page's MAIN world — same behavior, transforms execute in the sandbox).
  The `extension` strategy is gone (no blocking webRequest in MV3).
- **Browser-initiated loads (`<script src>`, `<img>`, stylesheets, fonts,
  main-frame HTML) go through the `debugger` strategy** for handlers whose
  strategy is `debugger` (or through the local helper with `helper`).
  The service worker
  drives `chrome.debugger` / CDP `Fetch` (pausing only URLs matching those
  handlers' routes, fetch/XHR included);
  handler decisions (`onRequest`, `replaceResponse`, `onResponseBody`) are
  computed in the sandbox, so only the owning handlers apply.
  `page` handlers stay fetch/XHR-only (a page load they match is warned about).
  Caveats:
  - Chrome shows its "started debugging this browser" banner, and every
    http(s) tab is attached while such scripts exist (the resource's CDN
    host rarely equals the tab's host).
  - The first navigation in a tab usually leaves before the debugger
    attaches. If a script matches the page itself and the request was a
    GET, it is re-issued through the debugger (`Page.navigate`) so it IS
    intercepted ("re-loaded it through the debugger" in the log). Anything
    else that slips through (POSTs, very fast subresources) is logged as a
    **warning** ("… was NOT intercepted by "X" — it loaded before the
    debugger attached … Reload the tab"); a reload is intercepted (tabs
    stay attached). MV2 attaches only once the navigation has started, so
    there the page itself is always missed on its first load (warned).
  - `onResponseHeaders` is applied at the Response stage
    (`Fetch.continueResponse` keeps the body streaming when no body handler
    changes it); redirects/error statuses pass through untransformed.
  - Extra permissions: `debugger`, `webNavigation` (attach as early as
    `onBeforeNavigate`), `webRequest` (observe-only, for the Missed warning).
- **Folder sync works** — the poller runs in the service worker: a 25s
  keep-alive ping (any extension API call resets the SW's ~30s idle
  timer) holds the worker open while a folder is connected, with a 30s
  `chrome.alarms` poll as the fallback if the worker is reaped anyway.
- onDocument runs in the page (MAIN world when the page CSP allows, isolated
  fallback otherwise). **`document_start` timing caveat:** in MV2 the
  always-alive background answers the bundle in ~1ms, so onDocument handlers
  reliably beat the page's own scripts. In MV3 the service worker must
  wake first — analyses are cached in `chrome.storage.session` (and
  refreshed on every script change), so the bundle is served from storage
  without waking the sandbox, but a cold SW still costs ~50-100ms; inline
  page scripts may run before an onDocument handler does. Fetch/XHR
  interception is unaffected.

Verify the MV3 bundle: `npx tsx test/mv3.e2e.ts` (SW registration, Editor,
script save/list through the sandbox, settings.yaml, `page` interception,
`debugger` `<script src>` interception incl. gzip, lazy chunks and reloads).
