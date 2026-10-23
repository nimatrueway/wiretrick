# Writing scripts

[← README](../README.md) · [Glossary](../GLOSSARY.md)

A script registers **handlers** at top level. Each handler takes its own
[route](#routes) first, then the function:

```ts
wt.about("Debug the user API");

const API = "*://app.example.com/api/*";

// Redirect / block / request headers / respond:
wt.onRequest(API, (ctx) => {
    // return { redirect: "https://myserver/user.json" };
    // return { block: true };
    return { headers: { set: { "x-debug": "1" } } };
});

// Response headers:
wt.onResponseHeaders(API, () => ({
    headers: { set: { "access-control-allow-origin": "*" } },
}));

// Replace the whole body:
// wt.replaceResponse("*://app.example.com/api/flags", () => ({ beta: true }));

// Stream-modify the body:
wt.onResponseBody("*://app.example.com/api/user*", (ctx, body) => String(body).replace('"role":"user"', '"role":"admin"'));

// Patch the page itself:
wt.onDom("*://app.example.com/*", () => {
    document.title = "🎯 " + document.title;
});
```

Register handlers synchronously at top level. A registration after an
`await` or inside a callback logs an error and is ignored. A file that
registers no handlers is a [library](#libraries-and-recipes).

## Routes

The first argument of every handler says where it applies:

| form | example |
|---|---|
| one URL pattern | `wt.onRequest("*://example.com/*", fn)` |
| a list | `wt.onRequest(["*://a.example.com/*", "*://b.example.com/*"], fn)` |
| route object | `wt.onRequest({ url, exclude, methods, resourceTypes, strategy }, fn)` |
| `onDom` route object | `wt.onDom({ url, exclude, when }, fn)` |

An empty list matches **nothing**, never everything.

### URL patterns

URL patterns are [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) strings, the web-standard syntax
also available to scripts as `new URLPattern(...)`. `*` is a wildcard
within a URL part, `:name` is a named segment, and a query or hash you
leave out matches any. `"<all_urls>"` matches every URL.

| URL pattern | matches |
|---|---|
| `*://example.com/*` | any scheme, any path on `example.com` (default port only) |
| `https://*.example.com/api/*` | every subdomain's `/api/…` (not `example.com` itself) |
| `https://cdn.example.com/static/*.js` | only `.js` files under `/static/` |
| `https://example.com/users/:id` | `/users/42`, not `/users/42/posts` |
| `http://localhost:8081/*` | that port only |
| `*://localhost:*/*` | any port (a URL pattern without a port matches only 80/443) |

An invalid URL pattern (e.g. `*example.com*`, which has no scheme) makes the
registration throw. The error shows on the script.

Named groups land in `ctx.groups` (`*` wildcards as `"0"`, `"1"`, …):

```ts
wt.onRequest("https://api.example.com/users/:id", (ctx) => {
    if (ctx.groups.id === "42") return { respond: { body: { id: 42, name: "Mock" } } };
});
```

### Route object: `exclude`, `methods`, `resourceTypes`, `strategy`

```ts
wt.onResponseBody(
    {
        url: "https://example.com/app/*",
        exclude: ["https://example.com/app/vendor/*"],
        methods: ["GET"],
        resourceTypes: ["script"],
        strategy: "debugger",
    },
    (ctx, body) => String(body).replace("DEBUG=false", "DEBUG=true"),
);
```

`exclude`, `methods` and `resourceTypes` only **narrow** a route.

- **`exclude`** — URL patterns to skip even when `url` matches. Cheap: one
  extra URL pattern test, only on URLs that already matched `url`, on every
  strategy. It can't narrow what `debugger` or `helper` pause (their filters
  can't express "except"), so an excluded URL may still be paused there and
  continued unchanged. The local helper checks `exclude` itself, so it
  doesn't ask the extension about excluded URLs.
- **`methods`** — HTTP methods, case-insensitive. Omit for any. As cheap as
  `exclude`, checked the same way everywhere.
- **`resourceTypes`** — resource types, the browser's label for why a request was
  made (webRequest names, also `ctx.resourceType`): `main_frame`,
  `sub_frame`, `stylesheet`, `script`, `image`, `font`, `object`,
  `xmlhttprequest` (fetch and XHR), `ping`, `csp_report`, `media`,
  `websocket`, `other`. Omit for every type. How much it saves depends on
  the strategy:

  | strategy | how `resourceTypes` is applied |
  |---|---|
  | `debugger` | Only these types are paused (the debugger's `Fetch.enable` patterns); other requests are never stopped. The cheapest way to keep a route off images, fonts and other assets. |
  | `webRequest` | Checked in the listener before any script runs. |
  | `helper` | Checked after the helper pauses the request: filters correctly, saves no work. |
  | `page` | Only sees page fetch/XHR (`xmlhttprequest`). A list without `xmlhttprequest` means the handler never runs, and the Log view warns. |
  | `rules` | Part of the browser-native rule: other types never match. |

  `onDom` routes have no `resourceTypes` or `methods`.
- **`strategy`** — run this handler on one [strategy](strategies.md):
  `"helper"`, `"page"`, `"webRequest"`, `"debugger"` or `"rules"`. Omit to use the default
  from Settings → Strategy. There is no fallback: when the strategy
  isn't available, the handler doesn't run and the Log view says why.
  To pick per browser or build, use `wt.isChrome`, `wt.isFirefox`,
  `wt.isMV2` and `wt.isMV3` (Chromium-based browsers count as Chrome;
  MV3 is the `dist-mv3/` build):

  ```ts
  wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "webRequest" : "helper" }, (ctx, body) => body);
  wt.onRequest({ url: "*://api.example.com/*", strategy: wt.isMV3 ? "debugger" : "webRequest" }, fn);
  wt.onRequest({ url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "webRequest" }, () => ({ block: true }));
  ```

  On `rules` the handler runs once when scripts load and its fixed result
  (block, redirect, headers) becomes a browser-native rule; `exclude`
  isn't supported there ([what `rules` can do](strategies.md#what-rules-can-do)).

> **Tip:** `page` is the lightest strategy, but it only sees the page's own
> fetch/XHR (REST/API) calls. For documents, `<script src>`, images,
> workers, or anything that must not slip through, use `helper`,
> `webRequest` or `debugger`. See [strategies](strategies.md).
>
> **Note:** on Chromium MV2, `webRequest` can redirect the page itself and
> change its headers, but not its body in place: `onResponseBody` never
> runs and a replaced page moves to a `chrome-extension://` URL. Use
> `helper` or `debugger` for that ([details](strategies.md#which-strategy-for-which-job)).

## Description and parameters

`wt.about("…")` sets a one-line description, shown as the script's
tooltip in the Editor and in the popup.

`wt.params` declares typed knobs the user changes from the popup's ⚙
dialog, the Editor or `settings.yaml` without touching the script:

```ts
wt.about("Force failures on the posts API");

const cfg = wt.params({
    enabled: { type: "boolean", default: true, description: "Master switch" },
    status:  { type: "enum", choices: ["500", "503"], default: "500" },
    note:    { type: "string", default: "forced failure" },
    tags:    { type: "stringList", default: [] },
});
// cfg.enabled: boolean · cfg.status: "500" | "503" · cfg.note: string · cfg.tags: string[]

wt.onRequest("*://app.example.com/posts/*", () => {
    if (!cfg.enabled) return;
    return { respond: { status: Number(cfg.status), body: { error: cfg.note, tags: cfg.tags } } };
});
```

`wt.defineParam(name, def)` declares one param and returns its value. It
writes to the same set as `wt.params`; the UI lists params in call order,
and defining the same name twice is an error:

```ts
const host = wt.defineParam("host", { type: "string", default: "api.example.com" });
```

Routes may be built from params. A param change re-runs the script and
re-arms its routes:

```ts
const cfg = wt.params({
    hosts: { type: "stringList", default: ["staging.example.com"], description: "Hosts to unlock" },
});
wt.onResponseHeaders(cfg.hosts.map((h) => `*://${h}/*`), () => ({
    headers: { set: { "access-control-allow-origin": "*" } },
}));
```

Param values persist per script and apply on save — the change is hot applied
like a code edit. Parameter types: `boolean` (switch), `number` (with
optional `min`, `max`, `step`), `string` (text; add `multiline: true` for a
textarea, written to `settings.yaml` as a `|` block scalar when it contains
newlines), `enum` (dropdown of `choices`), `stringList` (add/remove list).

Every param type accepts an optional `parse` function that turns the raw
value into something more convenient for the script. The param's type
becomes the parser's return type; the ⚙ dialog, the Editor and
`settings.yaml` keep editing (and storing) the raw value, and `parse` re-runs
on every change:

```ts
const cfg = wt.params({
    origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) },
    delay:  { type: "number", default: 2, description: "Seconds", parse: (sec) => sec * 1000 },
});
// cfg.origin: URL · cfg.delay: number (ms)

const hosts = wt.defineParam("hosts", { type: "stringList", default: ["a.com"], parse: (l) => new Set(l) });
// hosts: Set<string>
```

A parser that throws is a script error naming the param, e.g.
`param "origin": parse failed for value "xyz": Invalid URL` — the script
shows its error indicator and the Log an ERROR line, like any other load
error. For `enum`, `parse` receives the choice typed as `string`.

## Libraries and recipes

A file that registers no handlers is a **library**: it never runs on its
own (the popup lists it only when it declares params) but other scripts
import it:

```ts
// saved script named "utils" (utils.ts in the synced folder):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";   // "./utils", "utils", "utils.ts" all resolve
```

A library can export **recipes** — functions that register handlers. The
handler belongs to the script that calls the recipe (its badge, log, popup
entry and params):

```ts
// library "mocks":
export function mockJson(url: string, body: object) {
    wt.onRequest(url, () => ({ respond: { body } }));
}

// script:
import { mockJson } from "./mocks";
mockJson("*://api.example.com/me", { id: 1, role: "admin" });
```

Libraries may declare params too, as shared config. They're editable in the
popup (marked 𝑓, no enabled switch), the Editor and `settings.yaml`, and
importers see the library's values. Whether a file is a library is decided
with its current param values, so a library that registers handlers only
for some value becomes a script when you change it (and back):

```ts
// library "gate": a library until "on" is switched on
const p = wt.params({ on: { type: "boolean", default: false } });
if (p.on) wt.onRequest("*://api.example.com/*", () => ({ block: true }));
```

Param definitions can be shared too — export them from a library and pass
them to `wt.params` (directly or spread); the importer gets its own values:

```ts
// library "utils":
export const envParam = { type: "stringList", default: ["dev"] } as const;

// script:
import { envParam } from "./utils";
const cfg = wt.params({ intercept_environments: envParam });
```

## DOM changes — `wt.onDom`

`wt.onDom` is not a network strategy — it registers a **DOM-ready callback
that runs inside the page's MAIN world** (the same world as the page's own
JS). Its route is frame URL pattern(s), or `{ url, exclude, when }`. A
script may register several, each with its own route and `when`. Exact
timing:

1. **Injection**: our bridge content script (`document_start`, isolated
   world) injects `hook.js` into the page via a script tag before any page
   script runs. The hook asks the background for the scripts with an
   `onDom` route matching this frame's URL and compiles them.
2. **Registration**: while compiling, the `wt.onDom(route, handler)` calls
   whose route matches the frame are captured (the handler is stored, not
   yet run).
3. **Execution**: by default the captured handlers run exactly once, when
   the `DOMContentLoaded` event fires — i.e. the full DOM is parsed and
   queryable, but stylesheets/images may still be loading, and framework
   hydration (React/Vue) has *not* necessarily finished yet.
   - If the hook's bundle arrives **after** `DOMContentLoaded` already fired
     (late bundle, bfcache restore), handlers run immediately at
     registration time.
4. **Context**: handlers run as page JS — full DOM access, `document.title`
   writes, observers, etc. They can be `async` (the engine doesn't await
   them). `ctx` is the same request-context shape (`url`, `method`, …) with
   the frame URL.
5. **Timing — `when`**: the route object picks the moment. Handlers with
   the same `when` run in script-list order, then registration order.

   ```ts
   wt.onDom("*://example.com/*", () => { ... });                                       // default: DOMContentLoaded
   wt.onDom({ url: "*://example.com/*", when: "document_start" }, () => { ... });      // while HTML is still parsing
   wt.onDom({ url: "*://example.com/*", when: "document_end" }, () => { ... });        // alias of DOMContentLoaded
   wt.onDom({ url: "*://example.com/*", when: "document_idle" }, () => { ... });       // after window load
   ```

   | `when` | Runs | DOM state | Use for |
   |---|---|---|---|
   | `document_start` | as soon as the script is compiled | `<html>` only; `head`/`body` usually `null` | stubbing globals, `MutationObserver` on `document`, capture listeners — getting in ahead of page code |
   | `DOMContentLoaded` *(default)* | HTML fully parsed, `defer`/module scripts done | complete DOM; images/CSS/iframes may still load; framework hydration may not have happened | most title/text/attribute changes |
   | `document_end` | same as `DOMContentLoaded` | same | alias matching content-script `run_at` |
   | `document_idle` | after window `load` | everything loaded | final layout/sizes, content built during load |

   - **Already past that moment?** (slow bundle, bfcache restore) The
     handler runs immediately.
   - **`document_start` race:** in the MV2 build the bundle arrives in ~1ms
     and reliably beats page scripts. In the MV3 build a cold service
     worker can take ~50-100ms, so early inline `<script>`s may already
     have run. When page code *must* see your change, rewrite the response
     with `onResponseBody` instead.
   - **`document_idle` always waits for `load`**, unlike Chrome's
     content-script `document_idle`; one slow image or ad iframe delays it.
   - **Once per document, per matching frame.** Every frame (iframes too)
     is matched against its *own* URL. SPA soft navigations (`pushState`)
     and framework re-renders don't re-run it — start a `MutationObserver`
     inside the handler to keep re-applying. Hard navigations start over.
   - **Live edits re-run immediately**, regardless of `when`, when you save
     the script with the page open — keep handlers idempotent.
   - **Async handlers** aren't awaited; `when` only sets when they start.
   - **CSP fallback:** if the page forbids `eval`, handlers run in the
     extension's isolated world — same DOM and timing, but page globals
     (`window.myApp`) aren't visible.

Because it runs as page JS, `wt.onDom` works regardless of how the response
arrived — service-worker-served HTML, cached pages, or hydration overwriting
a body transform — which is exactly why it's the resilient choice for
title/DOM changes on SPAs.

## Multiple handlers — how they stack

When several handlers match the same request, they run in **list order**:
scripts top to bottom in the Editor, then registration order within a
script. Per kind:

**`wt.onRequest`** — the first handler that returns a *final* result
(`respond`, `redirect`, or `block`) wins and stops the chain; later
handlers don't run for that request. Handlers that return nothing (or only
`headers`) don't stop the chain — their header changes merge (later `set`
wins per key, `remove` accumulates) and apply even when a later handler
returns a final result.

**`respond`** — a final result that synthesizes the response immediately,
**without the network request ever happening**:

```ts
wt.onRequest("*://api.example.com/me", () => ({
    respond: {
        body: { id: 1, name: "Mocked User" },  // object → JSON; strings/bytes pass through
        status: 200,                            // default 200
        mime: "application/json",               // default: guessed from the URL
        headers: { set: { "x-mock": "1" } },
    },
}));
```

It stacks like every final result: first handler to `respond` wins. On
`page`, `debugger` and `helper` the response is fulfilled in place with any
status and headers, URL kept. `webRequest` serves status 200 only (another
status is skipped with a warning): in place on Firefox, and on Chromium MV2
by redirect (a `data:` URL, or the extension's `serve.html` for page loads),
so the URL changes. See
[how each strategy serves a replacement](strategies.md#how-each-strategy-serves-a-replacement).

**`wt.onResponseHeaders`** — all matching handlers run and their changes
**merge**: `set` keys are applied in order (a later handler's `set` of the
same header overwrites earlier ones), `remove` lists accumulate.

**`wt.onResponseBody`** — transforms **compose** like a pipeline: handler
A's output becomes handler B's input, in list order.

```text
body → [transform 1] → [transform 2] → … → page
```

**`wt.replaceResponse`** — the first handler that returns a body wins;
later ones are skipped.

**Across strategies**: a handler's `strategy` only decides *which mechanism* runs
it — stacking order is unchanged regardless of which strategy each handler
uses.

## Async handlers

All `wt.*` handlers may be `async` (return a Promise). What happens with the
result depends on the handler's strategy:

| handler | `page` (page fetch/XHR) | `webRequest`, Chromium MV2 | `webRequest`, Firefox | `debugger` | `helper` |
|---|---|---|---|---|---|
| `onRequest` redirect/block/respond | ✅ awaited | ⚠ result ignored, error logged — blocking webRequest can't await | ✅ awaited natively | ✅ awaited at the Request stage | ✅ awaited |
| `onRequest` headers | ✅ awaited | ⚠ ignored + error | ✅ awaited | ✅ awaited, applied at the Response stage | ✅ awaited, sent upstream |
| `onResponseHeaders` | — (not on `page`) | ⚠ ignored + error | ✅ awaited | ✅ awaited, merged into the fulfilled headers | ✅ awaited |
| `replaceResponse` | ✅ awaited — the page's `fetch`/XHR promise simply takes as long as the handler needs | ⚠ result ignored + error (a sync redirect can't be built late) | ✅ awaited, written in place (URL kept) | ✅ awaited, fulfills the body | ✅ awaited, upstream never contacted |
| `onResponseBody` | ✅ awaited (chained between handlers) | — (can't read bodies) | ✅ awaited | ✅ awaited | ✅ awaited (served `no-store`) |
| `onDom` | runs in the page on every strategy; not awaited (fire-and-forget) | | | | |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `wt.onResponseBody(API, async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/block or header changes decided asynchronously** on Chromium?
  Use `helper` or `debugger` (the default `helper` already awaits). Only
  Chromium's `webRequest` can't: there an async result logs an error and the
  request proceeds unmodified — set `strategy: "helper"` or `"debugger"` on the
  route.
- **Static replacement from an async source** (file read, fetch): async
  `replaceResponse` on the default strategy is all you need.
