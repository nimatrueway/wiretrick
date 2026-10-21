# Interception strategies

[← README](../README.md)

Chrome and Firefox have fundamentally different extension APIs, and Chrome
itself can only reach some resources through some paths. Wiretrick therefore
has **interception strategies** — pickable per script, individually or as a
**comma-separated priority list**:

```ts
wt.declareScript({
    match: ["*://api.example.com/*"],
    strategy: ["hook", "cdp"],   // ← try these in order
});
```

| strategy | how it works | can see | banner? | notes |
|---|---|---|---|---|
| `hook` | MAIN-world content script overrides `fetch`, `XMLHttpRequest`, `Response` consumers | any request the page's own JS makes (fetch/XHR — the majority of API traffic) | **never** | misses `<script src>`, `<img>`, documents; requires the page context |
| `cdp` | `chrome.debugger` + CDP Fetch domain: pause response → read body → transform → fulfill | **everything**: documents, script tags, images, fonts, XHR — even requests the page didn't initiate | **yes** — Chrome shows a yellow "being debugged" bar while attached | the only network-level path for main-frame HTML and non-JS resources on Chrome; attach/detach is lazy and automatic |
| `webrequest` | blocking `webRequest` (+ `filterResponseData` on Firefox) | everything | never | **MV2 builds only** — Firefox and Chromium browsers that still run MV2 (ungoogled-chromium, Brave, Arc…). Redirect, cancel, request/response headers and synchronous `onRequest` respond / `replaceResponse` work on both; response-body streaming (`modifyResponse`) and awaiting async handlers are Firefox-only (Chromium has no `filterResponseData`, and its blocking webRequest can't await) |
| `process` | a tiny local helper ([wiretrick-helper](process-helper.md)) is a loopback HTTPS proxy; a PAC routes only the matched hosts to it and it pauses requests for your handlers | **everything**: documents, script tags, images, workers, XHR — MV2 and MV3 | **never** | **Chrome-only**, needs the helper installed + its CA trusted; your own proxy setting stays in effect; falls through the list when the helper is unavailable |
| `auto` (default) | engine picks per request | — | minimized | resolves to `hook` when the page hook is ready, else `cdp` |

## Priority lists

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
- `strategy: ["webrequest", "hook"]` — network-level first (blocking webRequest on
  Firefox / MV2 Chromium), page hook otherwise.
- `strategy: ["process", "cdp"]` — network-level on Chrome without the banner via
  the local helper; the debugger only when the helper isn't installed/running.
  `["hook", "process"]` keeps page fetch/XHR in the hook and sends the rest
  (documents, script tags, images…) through the helper.

Unknown names are dropped with a warning in the log; a list that ends up empty falls back to `auto`.

**Debugger use is strict**: the debugger is only ever used when the
script's list explicitly contains `cdp` (or is the single default `auto`).
A script with `strategy: ["hook"]` / `["hook", "process"]` / `["webrequest"]` will never
attach the debugger for any request.

## Banner minimization (what the engine does on its own)

- **Learning**: the engine records which resource types each script actually
  matches. A script observed ≥3 times matching only fetch/XHR is treated as
  permanently hook-covered — it will never trigger the debugger again.
- **Lazy attach**: the debugger attaches only when a CDP-relevant script
  matches an in-flight request, and detaches ~8s after the page settles —
  the banner clears while you keep browsing.
- **Strict tier gating**: a script whose list has no `cdp` (e.g.
  `strategy: ["hook"]`) never attaches the debugger for anything — main frames
  included; use `wt.onDom` for page changes instead.
- **Claim dedup**: when the hook transforms a request, the CDP tier skips it
  (no double transforms).
- **Strict page CSP fallback**: if a page's own CSP forbids `eval` (so the
  hook cannot compile scripts in that page at all), the hook reports it and
  the tab automatically falls back to the CDP tier for body transforms —
  features keep working, the banner shows while it does.

## Which strategy for which job?

- Mock/transform **JSON APIs** → default `auto` (hook covers it; no banner).
- Rewrite **page HTML / titles in the raw response** → `cdp` (or default
  auto; the main frame always goes through CDP on Chrome).
- Change **title/DOM after render** → `wt.onDom` — no network interception
  at all, works even when the HTML is service-worker served or hydration
  re-renders it (the resilient choice for SPA title/DOM tweaks).
- **Never see the banner at all** → `strategy: ["hook"]` and combine with
  `wt.onDom` for anything the hook can't reach.
- **Firefox users** → everything is network-level via `webrequest`, no
  banners, ever.
- **Chrome, network-level, no banner** (documents, `<script src>`, images,
  async redirects/headers) → `strategy: ["process", "cdp"]` with the
  [local helper](process-helper.md) installed.

## Troubleshooting `webrequest`

Set `logLevel: debug` in `settings.yaml` and reload the page: the LOG panel
then traces every request a `webrequest`-tier script matches — which scripts
ran, what each `onRequest` returned, whether the browser followed the
redirect, and how the request ended. Failures (`request FAILED net::…`) and
changes the browser **ignored** because another extension (e.g. a second
Wiretrick install) modified the same request are logged as warnings even
without debug. No `[webrequest]` line at all for a URL means the browser
never showed that request to the extension (e.g. served by a service worker
or the blocking listener could not be registered — that is logged as an
error).

## First page load with `cdp`

The debugger can only attach once a navigation has begun, so the page
request often leaves first:

- **MV3**: a missed GET page load that a script matches is re-issued
  through the debugger right away (one extra, early-aborted request), so
  it is intercepted. Missed POSTs and very fast subresources are logged
  as a warning; the tab stays attached, so a reload is intercepted.
- **MV2**: the page itself is always missed on its first load and a
  warning is logged; reload within a few seconds (the debugger detaches
  once the page goes idle).

## Compatibility

Which interception paths each browser and build gives you
([strategies](#interception-strategies) explained above):

| | `hook` (page fetch/XHR) | `wt.onDom` | `cdp` (debugger) | `webrequest` | `process` (local helper) |
|---|---|---|---|---|---|
| **Chrome / Edge / Brave / Vivaldi, current** — `dist-mv3/` | ✅ | ✅ | ✅ banner shown | ❌ | ✅ no banner |
| **Chromium with MV2** (ungoogled-chromium, Brave, Arc… — any Chromium that still loads MV2 extensions) — `dist/` | ✅ | ✅ | ✅ banner shown | ✅ no banner — redirect, cancel, headers, sync respond/replace; no body streaming or async (see [async](scripting.md#async-handlers)) | ✅ no banner |
| **Firefox** — `dist/` | ✅ | ✅ | ❌ | ✅ no banner | ❌ (not needed: `webrequest` reaches everything) |

What reaches what on Chrome:

| resource | `hook` | `cdp` | `process` |
|---|---|---|---|
| page `fetch` / XHR | ✅ | MV2 ✅ · MV3 left to the hook | ✅ |
| main-frame HTML, iframes | ❌ | ✅ | ✅ |
| `<script src>`, CSS, images, fonts | ❌ | ✅ | ✅ |
| service/web workers' requests | ❌ | ⚠ partly | ✅ |
| first navigation in a fresh tab | ❌ | ⚠ MV3 may miss it ([details](development.md#how-the-mv3-build-works)) | ✅ |
| sites pinning certs / mTLS | ✅ | ✅ | ❌ leave them out of `match` |

The `process` helper ships for these platforms (each release attaches the
binaries and a `SHA256SUMS`; the [installer](process-helper.md)
picks the right one):

| OS | x86-64 | ARM64 |
|---|---|---|
| Linux (glibc) | ✅ | ✅ |
| macOS | ✅ | ✅ |
| Windows 10+ | ✅ | ✅ via x64 emulation |

The helper registers itself for Chrome (stable/beta/dev/canary), Chromium,
Brave, Edge and Vivaldi.
