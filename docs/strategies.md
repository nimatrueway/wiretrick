# Interception strategies

[← README](../README.md) · [Glossary](../GLOSSARY.md)

Chrome and Firefox have fundamentally different extension APIs, and Chrome
itself can only reach some resources through some paths. Wiretrick therefore
has four **interception strategies**. Every handler runs on exactly
**one** of them:

1. its route's `strategy`, if set;
2. else the default from **Settings → Strategy** (`defaultStrategy:` in
   `settings.yaml`);
3. else the built-in default: `helper` on Chromium, `webRequest` on
   Firefox.

```yaml
settings:
  defaultStrategy: helper
```

```ts
wt.onRequest("*://api.example.com/*", fn);                                  // settings default
wt.onResponseBody({ url: "https://example.com/app/*.js", strategy: "debugger" }, fn); // this handler only
```

`strategy` is a single value — there are no priority lists and no `auto`.
**There is no fallback:** when the chosen strategy isn't available, the
handler doesn't run and Wiretrick says so (see
[below](#when-a-strategy-isnt-available)). Handlers of one script may use
different strategies; each request is still handled by each handler at
most once.

| strategy | how it works | can see | banner? | notes |
|---|---|---|---|---|
| `helper` | a tiny local helper ([wiretrick-helper](process-helper.md)) is a loopback HTTPS proxy; a PAC routes only the hosts of `helper` handlers to it and it pauses requests for your handlers | **everything**: documents, script tags, images, workers, XHR — MV2 and MV3 | **never** | **Chromium-only**, needs the helper installed + the helper certificate trusted; your own proxy setting stays in effect |
| `page` | MAIN-world content script overrides `fetch` and `XMLHttpRequest` | requests the page's own JS makes (fetch/XHR — the majority of API traffic) | **never** | misses `<script src>`, `<img>`, documents, workers and requests made before the page patch loads; no `onResponseHeaders` |
| `webRequest` | blocking `webRequest` (+ `filterResponseData` on Firefox) | everything | never | **MV2 builds only** — Firefox and Chromium browsers that still run MV2 (ungoogled-chromium, Brave, Arc…). Redirect, block, request/response headers and synchronous `onRequest` respond / `replaceResponse` work on both (Chromium serves replacements by redirecting, Firefox in place — see [below](#how-each-strategy-serves-a-replacement)); `onResponseBody` and awaiting async handlers are Firefox-only (Chromium has no `filterResponseData`, and its blocking webRequest can't await) |
| `debugger` | `chrome.debugger` + CDP Fetch domain: pause → run handlers → continue or fulfill | **everything**: documents, script tags, images, fonts, XHR — even requests the page didn't initiate | **yes** — Chrome shows a yellow "being debugged" bar while attached | Chromium-only; attach/detach is lazy and automatic |

`wt.onDom` isn't a network strategy: it runs in the page whatever the
setting ([details](scripting.md#dom-changes--wtondom)).

## Pros and cons

The same text is shown under the strategy picker in Settings → Strategy.

| strategy | pros | cons |
|---|---|---|
| `helper` *(default, Chromium)* | Sees everything: documents, `<script src>`, CSS, images, workers, the first navigation. No banner. Async handlers, any status code, URL unchanged. | Chromium only. One-time install of the local helper and trust in the helper certificate. Matched hosts go through a local proxy (PAC); cert-pinned / mTLS sites break. Small per-request latency; bodies are buffered for `onResponseBody`. |
| `page` | No setup, no banner, no permissions, lightest. Works in every browser. | Only the page's own fetch/XHR. Misses documents, `<script src>`, images, workers and requests made before the page patch loads. |
| `webRequest` *(default, Firefox)* | No banner, no setup. On Firefox it reaches everything, bodies included. | Not on Chrome (MV3). Chromium MV2: no `onResponseBody`, no async handlers, replacements are served by redirect (URL changes, status always 200) — a replaced page shows a `chrome-extension://` URL. Firefox: can't change a replaced response's status. |
| `debugger` | Sees everything with nothing to install. | Chromium only. Chrome shows a "being debugged" banner while attached. May miss the first navigation in a fresh tab ([details](#first-page-load-with-debugger)). |

> **Which one?** `page` is the most lightweight (no banner, no helper, no
> permissions prompt), but it only works on the page's own fetch/XHR
> (REST/API) calls. Documents, `<script src>`, images, workers and requests
> made before the page patch loads go straight past it. For robust interception
> use `helper` (Chromium), `webRequest` (Firefox / MV2 Chromium) or `debugger`.

> **`webRequest` on Chromium MV2 and the page itself (`main_frame`).**
> Redirect, block and request/response header changes work on the page
> load. Its *body* can't be changed in place: `onResponseBody` never runs,
> and `replaceResponse` / `respond` are served by redirecting the tab to the
> extension's `serve.html` — the address bar shows a `chrome-extension://…`
> URL and the page loses its origin (cookies, relative links, same-origin
> calls). To rewrite or replace the page itself on Chromium, use `helper`
> or `debugger` on that handler (`wt.onDom` for DOM/title tweaks). Firefox's
> `webRequest` doesn't have this limit.

## Which strategy for which job?

- **Most things on Chromium** → the default `helper`, with the
  [local helper](process-helper.md) installed: every resource type, async
  handlers, no banner.
- **Firefox** → the default `webRequest`: everything is network-level, no
  banner, ever.
- **Nothing to install on Chrome** → `debugger` (sees everything, shows the
  banner) or `page` (no banner, fetch/XHR only).
- **Replace/transform JSON APIs only, lightest path** →
  `{ url, resourceTypes: ["xmlhttprequest"], strategy: "page" }`.
- **Rewrite page HTML / `<script src>` bodies** → `helper` or `debugger` on
  Chromium, `webRequest` on Firefox — not `page`.
- **Change title/DOM after render** → `wt.onDom` — no network interception
  at all, works even when the HTML is service-worker served or hydration
  re-renders it (the resilient choice for SPA title/DOM tweaks).
- **Keep a route off assets** → set `resourceTypes`. On `debugger` other types are never
  paused, on `webRequest` they're filtered before any script runs; on
  `helper` the filter is correct but the request was already paused
  ([details](scripting.md#route-object-exclude-methods-resourcetypes-strategy)).

## When a strategy isn't available

The handler doesn't run, and the Log view gets one warning per script naming the
handlers, e.g.

```text
[My script] onResponseBody #1: onResponseBody never runs with strategy "webRequest" on Chromium — its webRequest API can't read response bodies. Use "page" (page fetch/XHR, no banner), "debugger" (any resource, debugger banner) or "helper" (local helper)
```

Cases warned about as soon as scripts load:

- the strategy doesn't exist in this build — `webRequest` on Chrome MV3,
  `helper` or `debugger` on Firefox;
- `onResponseBody` on Chromium's `webRequest` (it can't read bodies);
- `onResponseHeaders` on `page` (the page can't change response headers
  before the browser enforces them);
- `page` with `resourceTypes` that leave out `xmlhttprequest`;
- `helper` while the local helper isn't running (after a short grace
  period at startup) — the handlers start working once it connects.

Body handlers that matched a request but didn't run on it get the
[Missed warning](#missed-warning).

## The debugger banner

- **Lazy attach**: the debugger attaches only when a `debugger` handler's route
  matches the page or a request. On MV2 it detaches ~8s after the page
  settles — the banner clears while you keep browsing; MV3 keeps matching
  tabs attached.
- **Strict**: only handlers on `debugger` ever attach the debugger. Avoid the
  banner by picking `helper`, `page` or `webRequest` and use `wt.onDom` for
  page changes.
- **Narrow with `resourceTypes`**: a `debugger` route only pauses its `resourceTypes`, so
  `resourceTypes: ["main_frame"]` leaves the page's assets and API calls alone.

## Troubleshooting `webRequest`

Set `logLevel: debug` in `settings.yaml` and reload the page: the Log view
then traces every request a `webRequest` handler matches — which scripts
ran, what each `onRequest` returned, whether the browser followed the
redirect, and how the request ended. Failures (`request FAILED net::…`) and
changes the browser **ignored** because another extension (e.g. a second
Wiretrick install) modified the same request are logged as warnings even
without debug. No `[webRequest]` line at all for a URL means the browser
never showed that request to the extension (e.g. served by a service worker
or the blocking listener could not be registered — that is logged as an
error).

## How each strategy serves a replacement

`replaceResponse` and `onRequest` → `respond` produce a whole new response.
Whether the page keeps its URL depends on the strategy that serves it:

| strategy | how | URL | status | reaches |
|---|---|---|---|---|
| `page` | a `Response` / XHR result is synthesized in the page; the network is never contacted | unchanged (`response.url` / `responseURL` is the request URL) | any | page `fetch` / XHR only |
| `webRequest`, **Chromium MV2** | **redirect**: page loads (main frame) go to the extension's `serve.html`, so the address bar shows a `chrome-extension://…` URL and the page loses its origin (cookies, relative URLs, same-origin calls); other requests get a `data:` URL | **changes** | 200 only | everything — but response bodies can't be read, so no `onResponseBody` |
| `webRequest`, **Firefox** | in place: the request goes out, then `filterResponseData` discards the real body and writes the replacement (Content-Type set, Content-Length/Encoding dropped) | unchanged | the server's (Firefox can't change it; a non-200 `respond` is skipped with a warning) | everything; the request still reaches the server, and a network failure means no replacement |
| `debugger` | the debugger fulfills the paused request | unchanged | any | everything (banner shown) |
| `helper` | the local helper answers the proxied request | unchanged | any | everything, no banner |

To keep the URL on Chromium, use `helper` or `debugger` for that handler.

### Missed warning

A body handler that silently does nothing is hard to spot, so after a
request completes (~1.5 s later) Wiretrick checks every enabled script's
`onResponseBody` and `replaceResponse` handlers whose route covers the
request. If none of the script's body handlers ran for it, a WARN line
attributed to the script is logged, e.g.

```text
[My script] onResponseBody #1 never ran for https://example.com/ (document) — the "page" strategy only sees the page's own fetch/XHR — set strategy: "debugger" or "helper" on the route for other loads
```

The reason is picked from the situation:

- the handler is on `page` and the request isn't page fetch/XHR → set
  `strategy: "debugger"` or `"helper"` on the route;
- on `helper` and the helper isn't running → start/install the helper;
- served from the browser cache → reload with the cache disabled (hard
  reload);
- on `debugger` but the debugger wasn't attached in time → the existing
  “was NOT intercepted” warning (logged once, not twice);
- otherwise → “no strategy observed it — check the Log view at debug level”.

Skipped: handlers that can never run where they are (already warned at
load, see [above](#when-a-strategy-isnt-available)), page fetch/XHR on
`page` (it reads bodies lazily — the page may simply never read one),
websocket, ping/beacon, CSP reports, the extension's own requests, and
requests a script already ended in `onRequest` (block/redirect/respond).
Each script + URL warns at most once a minute, and at most 20 warnings a
minute overall. In the Network view it shows as a yellow *missed* entry;
the row is not marked observed.

## First page load with `debugger`

The debugger can only attach once a navigation has begun, so the page
request often leaves first:

- **MV3**: a missed GET page load that a handler matches is re-issued
  through the debugger right away (one extra, early-aborted request), so
  it is intercepted. Missed POSTs and very fast subresources are logged
  as a warning; the tab stays attached, so a reload is intercepted.
- **MV2**: the page itself is always missed on its first load and a
  warning is logged; reload within a few seconds (the debugger detaches
  once the page goes idle).

`helper` has no such gap.

## Compatibility

Which strategies each browser and build gives you
([strategies](#interception-strategies) explained above). The Settings
strategy picker disables the ones the current browser can't use.

| | `helper` (local helper) | `page` (page fetch/XHR) | `webRequest` | `debugger` (chrome.debugger) | `wt.onDom` |
|---|---|---|---|---|---|
| **Chrome / Edge / Brave / Vivaldi, current** — `dist-mv3/` | ✅ no banner — **default** | ✅ | ❌ | ✅ banner shown | ✅ |
| **Chromium with MV2** (ungoogled-chromium, Brave, Arc… — any Chromium that still loads MV2 extensions) — `dist/` | ✅ no banner — **default** | ✅ | ✅ no banner — redirect, block, headers, sync respond/replace; no body streaming or async (see [async](scripting.md#async-handlers)) | ✅ banner shown | ✅ |
| **Firefox** — `dist/` | ❌ (not needed: `webRequest` reaches everything) | ✅ | ✅ no banner — **default** | ❌ | ✅ |

What reaches what on Chrome:

| resource | `helper` | `page` | `debugger` |
|---|---|---|---|
| page `fetch` / XHR | ✅ | ✅ | ✅ |
| main-frame HTML, iframes | ✅ | ❌ | ✅ |
| `<script src>`, CSS, images, fonts | ✅ | ❌ | ✅ |
| service/web workers' requests | ✅ | ❌ | ⚠ partly |
| first navigation in a fresh tab | ✅ | ❌ | ⚠ may miss it ([details](#first-page-load-with-debugger)) |
| sites pinning certs / mTLS | ❌ leave them out of `helper` routes | ✅ | ✅ |
| `onResponseHeaders` | ✅ | ❌ | ✅ |

The local helper ships for these platforms (each release attaches the
binaries and a `SHA256SUMS`; the [installer](process-helper.md)
picks the right one):

| OS | x86-64 | ARM64 |
|---|---|---|
| Linux (glibc) | ✅ | ✅ |
| macOS | ✅ | ✅ |
| Windows 10+ | ✅ | ✅ via x64 emulation |

The helper registers itself for Chrome (stable/beta/dev/canary), Chromium,
Brave, Edge and Vivaldi.
