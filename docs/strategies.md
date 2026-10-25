# Interception strategies

[← README](../README.md) · [Glossary](../GLOSSARY.md)

Chrome and Firefox have fundamentally different extension APIs, and Chrome
itself can only reach some resources through some paths. Wiretrick therefore
has five **interception strategies**. Every handler runs on exactly
**one** of them:

1. its route's `strategy`, if set;
2. else the default from **Settings → Strategy** (`defaultStrategy:` in
   `settings.yaml`);
3. else the built-in default: `helper` on Chromium, `extension` on
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
| `helper` | a tiny local helper ([wiretrick-helper](local-helper.md)) is a loopback HTTPS proxy; a PAC routes only the hosts of `helper` handlers to it and it pauses requests for your handlers | **everything**: documents, script tags, images, workers, XHR — MV2 and MV3 | **never** | **Chromium-only**, needs the helper installed + the helper certificate trusted; your own proxy setting stays in effect |
| `page` | MAIN-world content script overrides `fetch` and `XMLHttpRequest` | requests the page's own JS makes (fetch/XHR — the majority of API traffic) | **never** | misses `<script src>`, `<img>`, documents, workers and requests made before the page patch loads; no `onResponseHeaders` |
| `extension` | the extension handles each request: blocking `webRequest` (+ `filterResponseData` on Firefox) | everything | never | **MV2 builds only** — Firefox and Chromium browsers that still run MV2 (ungoogled-chromium, Brave, Arc…). Redirect, block, request/response headers and synchronous `replaceResponse` (handler or `onRequest` result) work on both (Chromium serves replacements by redirecting, Firefox in place — see [below](#how-each-strategy-serves-a-replacement)); `onResponseBody` and awaiting async handlers are Firefox-only (Chromium has no `filterResponseData`, and its blocking webRequest can't await) |
| `debugger` | `chrome.debugger` + CDP Fetch domain: pause → run handlers → continue or fulfill | **everything**: documents, script tags, images, fonts, XHR — even requests the page didn't initiate | **yes** — Chrome shows a yellow "being debugged" bar while attached | Chromium-only; attach/detach is lazy and automatic |
| `rules` | each handler runs **once** when scripts load; its result becomes a browser-native rule (`declarativeNetRequest`) that the browser applies itself | **everything**, the first navigation included | **never** | block, redirect and request/response headers only, with a fixed result ([what `rules` can do](#what-rules-can-do)); Chrome MV3, Chromium MV2 and Firefox 113+ |

`wt.onDocument` isn't a network strategy: it runs in the page whatever the
setting ([details](scripting.md#dom-changes--wtondocument)).

## Pros and cons

The same text is shown under the strategy picker in Settings → Strategy.

| strategy | pros | cons |
|---|---|---|
| `helper` *(default, Chromium)* | Sees everything: documents, `<script src>`, CSS, images, workers, the first navigation. No banner. Async handlers, any status code, URL unchanged. | Chromium only. One-time install of the local helper and trust in the helper certificate. Matched hosts go through a local proxy (PAC); cert-pinned / mTLS sites break. Small per-request latency; bodies are buffered for `onResponseBody`. |
| `page` | No setup, no banner, no permissions, lightest. Works in every browser. | Only the page's own fetch/XHR. Misses documents, `<script src>`, images, workers and requests made before the page patch loads. |
| `extension` *(default, Firefox)* | No banner, no setup. On Firefox it reaches everything, bodies included. | Not on Chrome (MV3). Chromium MV2: no `onResponseBody`, no async handlers, replacements are served by redirect (URL changes, status always 200) — a replaced page shows a `chrome-extension://` URL. Firefox: can't change a replaced response's status. |
| `debugger` | Sees everything with nothing to install. | Chromium only. Chrome shows a "being debugged" banner while attached. May miss the first navigation in a fresh tab ([details](#first-page-load-with-debugger)). |
| `rules` | No banner, no setup, nothing runs per request: the browser itself applies the rules to every request, the first navigation included. Works in Chrome (MV3 and MV2) and Firefox. | Fixed results only: block, redirect (captures inserted as-is), set/remove request or response headers. No replaceResponse (handler or result) or onResponseBody, no exclude. The handler runs once when scripts load and can't read the request (method, headers…). |

> **Which one?** `page` is the most lightweight (no banner, no helper, no
> permissions prompt), but it only works on the page's own fetch/XHR
> (REST/API) calls. Documents, `<script src>`, images, workers and requests
> made before the page patch loads go straight past it. For robust interception
> use `helper` (Chromium), `extension` (Firefox / MV2 Chromium) or `debugger`.
> For a fixed block, redirect or header change, `rules` is lighter still and
> reaches everything.

> **`extension` on Chromium MV2 and the page itself (`main_frame`).**
> Redirect, block and request/response header changes work on the page
> load. Its *body* can't be changed in place: `onResponseBody` never runs,
> and replacements (`replaceResponse`) are served by redirecting the tab to the
> extension's `serve.html` — the address bar shows a `chrome-extension://…`
> URL and the page loses its origin (cookies, relative links, same-origin
> calls). To rewrite or replace the page itself on Chromium, use `helper`
> or `debugger` on that handler (`wt.onDocument` for DOM/title tweaks). Firefox's
> `extension` doesn't have this limit.

## Which strategy for which job?

- **Most things on Chromium** → the default `helper`, with the
  [local helper](local-helper.md) installed: every resource type, async
  handlers, no banner.
- **Firefox** → the default `extension`: everything is network-level, no
  banner, ever.
- **Nothing to install on Chrome** → `debugger` (sees everything, shows the
  banner) or `page` (no banner, fetch/XHR only).
- **Block, redirect or set headers the same way every time** → `rules`:
  the browser applies them itself — every resource type, no banner,
  nothing to install, in Chrome and Firefox
  ([what `rules` can do](#what-rules-can-do)).
- **Replace/transform JSON APIs only, lightest path** →
  `{ url, resourceTypes: ["xmlhttprequest"], strategy: "page" }`.
- **Rewrite page HTML / `<script src>` bodies** → `helper` or `debugger` on
  Chromium, `extension` on Firefox — not `page`.
- **Change title/DOM after render** → `wt.onDocument` — no network interception
  at all, works even when the HTML is service-worker served or hydration
  re-renders it (the resilient choice for SPA title/DOM tweaks).
- **Keep a route off assets** → set `resourceTypes`. On `debugger` other types are never
  paused, on `extension` they're filtered before any script runs; on
  `helper` the filter is correct but the request was already paused
  ([details](scripting.md#route-object-exclude-methods-resourcetypes-strategy)).

## When a strategy isn't available

The handler doesn't run, and the Problems view gets a warning under the
script for each such handler, e.g.

```text
onResponseBody #1: onResponseBody never runs with strategy "extension" on Chromium — its webRequest API can't read response bodies. Use "page" (page fetch/XHR, no banner), "debugger" (any resource, debugger banner) or "helper" (local helper)
```

Cases warned about as soon as scripts load:

- the strategy doesn't exist in this build — `extension` on Chrome MV3,
  `helper` or `debugger` on Firefox, `rules` in a browser without
  `declarativeNetRequest` (Firefox before 113);
- `onResponseBody` on `extension` on Chromium (its webRequest can't read bodies);
- `onResponseHeaders` on `page` (the page can't change response headers
  before the browser enforces them);
- `page` with `resourceTypes` that leave out `xmlhttprequest`;
- `helper` while the local helper isn't running (after a short grace
  period at startup) — the handlers start working once it connects.

A handler on `rules` that can't become a rule is an **error**, also found as
soon as scripts load (after every save): the script gets a red ⚠ in the
Editor and the popup whose tooltip names the handler and the reason, and the
Problems view gets an error under the script, e.g.

```text
onRequest #2: rules are fixed: the handler must return the same result for every request (it reads ctx.method) — this handler doesn't run
```

Only that handler is skipped; the script's other handlers keep running.
Saving the fixed script clears the error. The reasons are listed under
[what `rules` can do](#what-rules-can-do).

Body handlers that matched a request but didn't run on it get the
[Missed warning](#missed-warning).

## What `rules` can do

A `rules` handler doesn't run per request. When scripts load (after every
save, param change or enable toggle) Wiretrick runs it **once** and turns
what it returns into browser-native rules (`declarativeNetRequest` session
rules) that the browser then applies by itself — to every request, the
first navigation included, with no banner and no helper.

| handler returns | the rule |
|---|---|
| `onRequest` → `{ block: true }` | blocks the request |
| `onRequest` → `{ redirect: url }` | redirects it; `ctx.groups.*` and `ctx.url` may appear in the URL ([below](#captures-in-a-redirect)) |
| `onRequest` → `{ headers: { set, remove } }` | sets / removes request headers |
| `onResponseHeaders` → `{ headers: { set, remove } }` | sets / removes response headers |

The route works as everywhere: the full URL pattern syntax (named groups,
optional parts, custom regular expressions, wildcards), `methods` and
`resourceTypes`. Scripts stack as usual: the first script's block or
redirect wins, and when two scripts set the same header the later one
wins. A block or redirect makes the same handler's `headers` moot, as on
every strategy.

```ts
wt.onRequest({ url: "*://ads.example.com/*", strategy: "rules" }, () => ({ block: true }));
wt.onRequest({ url: "https://api.example.com/*", strategy: "rules" }, () => ({
    headers: { set: { "x-debug": "1" }, remove: ["cookie"] },
}));
wt.onResponseHeaders({ url: "https://example.com/*", strategy: "rules" }, () => ({
    headers: { remove: ["content-security-policy"] },
}));
// rules where the browser has them, the per-request extension strategy elsewhere
wt.onRequest({ url: "*://tracker.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }, () => ({ block: true }));
```

### Captures in a redirect

The redirect URL may contain the route's captures (`ctx.groups.name`,
`ctx.groups["0"]` for a `*`) and `ctx.url`, inserted **as-is** — the
browser substitutes them per request:

```ts
// /api/users/7    → https://staging.example.com/users/7?v=
// /api/v2/users/7 → https://staging.example.com/users/7?v=2
wt.onRequest(
    { url: "https://example.com/api{/v:ver}?/users/:id(\\d+)", strategy: "rules" },
    (ctx) => ({ redirect: `https://staging.example.com/users/${ctx.groups.id}?v=${ctx.groups.ver ?? ""}` }),
);
```

An optional group that didn't match is empty in the rule, so the handler
must say so with `?? ""`; any other fallback (`ctx.groups.ver ?? "1"`,
`ctx.groups.ver || "1"`) is an error, because a rule can't pick a value.
When the two forms need different results, write two handlers.

### Errors

Each of these is a red ⚠ on the script naming the handler; that handler
doesn't run, the rest of the script does:

- the handler reads the request — `ctx.method`, `ctx.requestHeaders`,
  `ctx.tabUrl`, `ctx.resourceType`, `ctx.statusLine`,
  `ctx.responseHeaders` (destructuring counts): a rule's result is fixed
  ("rules are fixed: the handler must return the same result for every
  request (it reads ctx.method)");
- a capture used anywhere but as-is in the redirect URL — in a header, an
  `if`, `.toUpperCase()`… ("captures can only be inserted into the redirect
  URL as-is"), or an optional capture without `?? ""`;
- more than 9 captures in one redirect (the browser substitutes `\1`–`\9`);
- `onResponseBody`, or `replaceResponse` (handler or `onRequest` result);
- `exclude` on the route — narrow the URL pattern instead;
- a method a rule can't match (e.g. `CONNECT`);
- the handler returns nothing ("does nothing on `rules`" — rules can't just
  observe requests);
- it throws, or doesn't settle within 2 s, during its one-time run;
- a custom regular expression the browser's regex engine (RE2) rejects —
  lookahead, lookbehind, backreferences — with the browser's reason;
- a URL pattern too complex for the browser's regex memory limit (2 KB in
  Chrome): about ten `:name` groups in one pattern, fewer with custom
  regexps. Use `*` for a run of segments you don't need. The error shows
  the generated regex, its length and its count of character classes,
  groups and captures, and says when the redirect's captures alone push it
  over;
- the browser refuses the rule (e.g. its limit on session or regex rules is
  reached), with the browser's reason.

> **State is frozen at load.** The one run sees params, but anything else the
> handler reads — the time, `wt.storage`, `Math.random()`, a counter — is
> read once and baked into the rule. It's refreshed only when scripts
> reload (a save, a param change, an enable toggle). Use another strategy
> for results that must change per request.

In the Network view a request a rule matched is marked Modified, with the
rule's action (e.g. `onRequest → block (rules)`). The Log view's line for
it is info level.

## The debugger banner

- **Lazy attach**: the debugger attaches only when a `debugger` handler's route
  matches the page or a request. On MV2 it detaches ~8s after the page
  settles — the banner clears while you keep browsing; MV3 keeps matching
  tabs attached.
- **Strict**: only handlers on `debugger` ever attach the debugger. Avoid the
  banner by picking `helper`, `page` or `extension` and use `wt.onDocument` for
  page changes.
- **Narrow with `resourceTypes`**: a `debugger` route only pauses its `resourceTypes`, so
  `resourceTypes: ["main_frame"]` leaves the page's assets and API calls alone.

## Troubleshooting `extension`

Set `logLevel: debug` in `settings.yaml` and reload the page: the Log view
then traces every request an `extension` handler matches — which scripts
ran, what each `onRequest` returned, whether the browser followed the
redirect, and how the request ended. Failures (`request FAILED net::…`) and
changes the browser **ignored** because another extension (e.g. a second
Wiretrick install) modified the same request are logged as warnings even
without debug. No `[extension]` line at all for a URL means the browser
never showed that request to the extension (e.g. served by a service worker
or the blocking listener could not be registered — that is logged as an
error).

## How each strategy serves a replacement

`replaceResponse` (handler or `onRequest` result) produces a whole new response.
It is final: nothing runs after it — no later handler, no `onResponseHeaders`
or `onResponseBody` (see
[how handlers stack](scripting.md#multiple-handlers--how-they-stack)).
Whether the page keeps its URL depends on the strategy that serves it:

| strategy | how | URL | status | reaches |
|---|---|---|---|---|
| `page` | a `Response` / XHR result is synthesized in the page; the network is never contacted | unchanged (`response.url` / `responseURL` is the request URL) | any | page `fetch` / XHR only |
| `extension`, **Chromium MV2** | **redirect**: page loads (main frame) go to the extension's `serve.html`, so the address bar shows a `chrome-extension://…` URL and the page loses its origin (cookies, relative URLs, same-origin calls); other requests get a `data:` URL | **changes** | 200 only | everything — but response bodies can't be read, so no `onResponseBody` |
| `extension`, **Firefox** | in place: the request goes out, then `filterResponseData` discards the real body and writes the replacement (Content-Type set, Content-Length/Encoding dropped) | unchanged | the server's (Firefox can't change it; a non-200 replacement is skipped with a warning) | everything; the request still reaches the server, and a network failure means no replacement |
| `debugger` | the debugger fulfills the request at the Request stage; the network is never contacted | unchanged | any | everything (banner shown) |
| `helper` | the local helper answers the proxied request; upstream is never contacted | unchanged | any | everything, no banner |

To keep the URL on Chromium, use `helper` or `debugger` for that handler.

### Missed warning

A body handler that silently does nothing is hard to spot, so after a
request completes (~1.5 s later) Wiretrick checks every enabled script's
`onResponseBody` and `replaceResponse` handlers whose route covers the
request (and `onRequest` handlers on `page`, for page fetch/XHR). If none of the script's body handlers ran for it, a WARN line
attributed to the script is logged, e.g.

```text
[My script] onResponseBody #1 never ran for https://example.com/ (document) — the "page" strategy only sees the page's own fetch/XHR — set strategy: "debugger" or "helper" on the route for other loads
```

The reason is picked from the situation:

- the handler is on `page` and the request isn't page fetch/XHR → set
  `strategy: "debugger"` or `"helper"` on the route;
- the handler is on `page` and the tab has no page hook (it was open
  before Wiretrick started or updated, so its content scripts never
  loaded) → reload the tab;
- on `helper` and the request went to localhost (127.x, `[::1]`) → Chrome
  never sends loopback requests through a proxy, so the helper can't see
  them; set `strategy: "page"` or `"debugger"` on the route;
- on `helper` and the helper isn't running → start/install the helper;
- on `helper` and the helper skipped the body on purpose → says why: a
  binary body (images, video, audio, fonts, wasm, PDFs, archives,
  binary `application/vnd.*` — with its Content-Type; `+json`/`+xml`
  types and HLS playlists (`mpegurl`) are passed as text), one over 64 MB, or a
  stream (server-sent events). A response with no body (204, 304, HEAD)
  isn't warned about at all;
- served from the browser cache → reload with the cache disabled (hard
  reload);
- on `debugger` but the debugger wasn't attached in time → the existing
  “was NOT intercepted” warning (logged once, not twice);
- otherwise → “no strategy observed it — check the Log view at debug level”.

Skipped: handlers on `rules` (the browser applies them; their body
handlers are errors at load), handlers that can never run where they are
(already warned at load, see [above](#when-a-strategy-isnt-available)), page fetch/XHR on
`page` in a tab with the hook (it reads bodies lazily — the page may simply never read one),
websocket, ping/beacon, CSP reports, the extension's own requests, and
requests a handler already ended (block/redirect/replacement) — those get
the skipped warning below instead.
Every request gets its own warning (no rate limit), in the Log and on its
Network row. In the Network view it shows as a yellow *missed* entry;
the row is not marked observed.

### Skipped warning

When a final result (block, redirect, replacement) ends a request, every
other enabled handler that matched it and now won't run gets a WARN line
naming who took priority and why:

```text
[Logger] onResponseBody #1 → skipped: [Blocklist] onRequest #1 → block took priority (strategy "rules" comes before "helper", so the request never got there) https://cdn.example.com/a.js
```

It shows as *missed* in the Network view (`is:missed`), one per request
like the warning above. The rules are in
[how handlers stack](scripting.md#multiple-handlers--how-they-stack).

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

| | `helper` (local helper) | `page` (page fetch/XHR) | `extension` (blocking webRequest) | `debugger` (chrome.debugger) | `rules` (browser-native rules) | `wt.onDocument` |
|---|---|---|---|---|---|---|
| **Chrome / Edge / Brave / Vivaldi, current** — `dist-mv3/` | ✅ no banner — **default** | ✅ | ❌ | ✅ banner shown | ✅ | ✅ |
| **Chromium with MV2** (ungoogled-chromium, Brave, Arc… — any Chromium that still loads MV2 extensions) — `dist/` | ✅ no banner — **default** | ✅ | ✅ no banner — redirect, block, headers, sync replaceResponse; no body streaming or async (see [async](scripting.md#async-handlers)) | ✅ banner shown | ✅ | ✅ |
| **Firefox** — `dist/` | ❌ (not needed: `extension` reaches everything) | ✅ | ✅ no banner — **default** | ❌ | ✅ 113+ | ✅ |

What reaches what on Chrome:

| resource | `helper` | `page` | `debugger` | `rules` |
|---|---|---|---|---|
| page `fetch` / XHR | ✅ | ✅ | ✅ | ✅ |
| main-frame HTML, iframes | ✅ | ❌ | ✅ | ✅ |
| `<script src>`, CSS, images, fonts | ✅ | ❌ | ✅ | ✅ |
| service/web workers' requests | ✅ | ❌ | ⚠ partly | ✅ |
| first navigation in a fresh tab | ✅ | ❌ | ⚠ may miss it ([details](#first-page-load-with-debugger)) | ✅ |
| sites pinning certs / mTLS | ❌ leave them out of `helper` routes | ✅ | ✅ | ✅ |
| `onResponseHeaders` | ✅ | ❌ | ✅ | ✅ fixed headers only |
| bodies (`onResponseBody`, `replaceResponse`) | ✅ | ✅ | ✅ | ❌ |

The local helper ships for these platforms (each release attaches the
binaries and a `SHA256SUMS`; the [installer](local-helper.md)
picks the right one):

| OS | x86-64 | ARM64 |
|---|---|---|
| Linux (glibc) | ✅ | ✅ |
| macOS | ✅ | ✅ |
| Windows 10+ | ✅ | ✅ via x64 emulation |

The helper registers itself for Chrome (stable/beta/dev/canary), Chromium,
Brave, Edge and Vivaldi.
