# Writing scripts

[← README](../README.md) · [Glossary](../GLOSSARY.md)

A script registers **handlers** at top level. Each handler takes its own
[route](#routes) first, then the function:

```ts
wt.describe("Debug the user API");

const API = "*://app.example.com/api/*";

// Redirect / cancel / request headers / mock:
wt.onRequest(API, (ctx) => {
    // return { redirect: "https://myserver/user.json" };
    // return { cancel: true };
    return { headers: { set: { "x-debug": "1" } } };
});

// Response headers:
wt.onResponseHeaders(API, () => ({
    headers: { set: { "access-control-allow-origin": "*" } },
}));

// Replace the whole body:
// wt.replaceResponse("*://app.example.com/api/flags", () => ({ beta: true }));

// Stream-modify the body:
wt.modifyResponse("*://app.example.com/api/user*", (ctx, body) => String(body).replace('"role":"user"', '"role":"admin"'));

// Patch the page itself:
wt.onDom("*://app.example.com/*", () => {
    document.title = "🎯 " + document.title;
});
```

Register handlers synchronously at top level. A registration after an
`await` or inside a callback logs an error and is ignored. A file that
registers no handlers is a [utility](#utilities-and-recipes).

## Routes

The first argument of every handler says where it applies:

| form | example |
|---|---|
| one pattern | `wt.onRequest("*://example.com/*", fn)` |
| a list | `wt.onRequest(["*://a.example.com/*", "*://b.example.com/*"], fn)` |
| route object | `wt.onRequest({ url, exclude, methods, types, strategy }, fn)` |
| `onDom` route object | `wt.onDom({ url, exclude, when }, fn)` |

An empty list matches **nothing**, never everything.

### Patterns

Patterns are [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) strings, the web-standard syntax
also available to scripts as `new URLPattern(...)`. `*` is a wildcard
within a URL part, `:name` is a named segment, and a query or hash you
leave out matches any. `"<all_urls>"` matches every URL.

| pattern | matches |
|---|---|
| `*://example.com/*` | any scheme, any path on `example.com` (default port only) |
| `https://*.example.com/api/*` | every subdomain's `/api/…` (not `example.com` itself) |
| `https://cdn.example.com/static/*.js` | only `.js` files under `/static/` |
| `https://example.com/users/:id` | `/users/42`, not `/users/42/posts` |
| `http://localhost:8081/*` | that port only |
| `*://localhost:*/*` | any port (a pattern without a port matches only 80/443) |

An invalid pattern (e.g. `*example.com*`, which has no scheme) makes the
registration throw. The error shows on the script.

Named groups land in `ctx.groups` (`*` wildcards as `"0"`, `"1"`, …):

```ts
wt.onRequest("https://api.example.com/users/:id", (ctx) => {
    if (ctx.groups.id === "42") return { respond: { body: { id: 42, name: "Mock" } } };
});
```

### Route object: `exclude`, `methods`, `types`, `strategy`

```ts
wt.modifyResponse(
    {
        url: "https://example.com/app/*",
        exclude: ["https://example.com/app/vendor/*"],
        methods: ["GET"],
        types: ["script"],
        strategy: "cdp",
    },
    (ctx, body) => String(body).replace("DEBUG=false", "DEBUG=true"),
);
```

`exclude`, `methods` and `types` only **narrow** a route.

- **`exclude`** — URL patterns to skip even when `url` matches. Cheap: one
  extra pattern test, only on URLs that already matched `url`, on every
  strategy. It can't narrow what `cdp` or `process` pause (their filters
  can't express "except"), so an excluded URL may still be paused there and
  continued unchanged. The local helper checks `exclude` itself, so it
  doesn't ask the extension about excluded URLs.
- **`methods`** — HTTP methods, case-insensitive. Omit for any. As cheap as
  `exclude`, checked the same way everywhere.
- **`types`** — resource types, the browser's label for why a request was
  made (webRequest names, also `ctx.resourceType`): `main_frame`,
  `sub_frame`, `stylesheet`, `script`, `image`, `font`, `object`,
  `xmlhttprequest` (fetch and XHR), `ping`, `csp_report`, `media`,
  `websocket`, `other`. Omit for every type. How much it saves depends on
  the strategy:

  | strategy | how `types` is applied |
  |---|---|
  | `cdp` | Only these types are paused (the debugger's `Fetch.enable` patterns); other requests are never stopped. The cheapest way to keep a route off images, fonts and other assets. |
  | `webrequest` | Checked in the listener before any script runs. |
  | `process` | Checked after the helper pauses the request: filters correctly, saves no work. |
  | `hook` | The hook only sees page fetch/XHR (`xmlhttprequest`). A list without `xmlhttprequest` means the handler never runs, and the LOG warns. |

  `onDom` routes have no `types` or `methods`.
- **`strategy`** — run this handler on one [strategy](strategies.md):
  `"process"`, `"hook"`, `"webrequest"` or `"cdp"`. Omit to use the default
  from Settings → Interception. There is no fallback: when the strategy
  isn't available, the handler doesn't run and the LOG says why.

> **Tip:** `hook` is the lightest strategy, but it only sees the page's own
> fetch/XHR (REST/API) calls. For documents, `<script src>`, images,
> workers, or anything that must not slip through, use `process`,
> `webrequest` or `cdp`. See [strategies](strategies.md).
>
> **Note:** on Chromium MV2, `webrequest` can redirect the page itself and
> change its headers, but not its body in place: `modifyResponse` never
> runs and a replaced page moves to a `chrome-extension://` URL. Use
> `process` or `cdp` for that ([details](strategies.md#which-strategy-for-which-job)).

## Description and parameters

`wt.describe("…")` sets a one-line description, shown as the script's
tooltip in the manager and in the popup.

`wt.params` declares typed knobs the user changes from the popup's ⚙
dialog, the manager or `settings.yaml` without touching the script:

```ts
wt.describe("Force failures on the posts API");

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

Param values persist per script and apply on save — the change hot-reloads
like a code edit. Parameter types: `boolean` (switch), `number` (with
optional `min`, `max`, `step`), `string` (text; add `multiline: true` for a
textarea, written to `settings.yaml` as a `|` block scalar when it contains
newlines), `enum` (dropdown of `choices`), `stringList` (add/remove list).

## Utilities and recipes

A file that registers no handlers is a **utility**: it never runs on its
own (the popup lists it only when it declares params) but other scripts
import it:

```ts
// saved script named "utils" (utils.ts in the synced folder):
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";   // "./utils", "utils", "utils.ts" all resolve
```

A utility can export **recipes** — functions that register handlers. The
handler belongs to the script that calls the recipe (its badge, log, popup
entry and params):

```ts
// utility "mocks":
export function mockJson(url: string, body: object) {
    wt.onRequest(url, () => ({ respond: { body } }));
}

// script:
import { mockJson } from "./mocks";
mockJson("*://api.example.com/me", { id: 1, role: "admin" });
```

Utilities may declare params too, as shared config. They're editable in the
popup (marked 𝑓, no enabled switch), the manager and `settings.yaml`, and
importers see the utility's values. Whether a file is a utility is decided
with its current param values, so a utility that registers handlers only
for some value becomes a script when you change it (and back):

```ts
// utility "gate": a utility until "on" is switched on
const p = wt.params({ on: { type: "boolean", default: false } });
if (p.on) wt.onRequest("*://api.example.com/*", () => ({ cancel: true }));
```

Param definitions can be shared too — export them from a utility and pass
them to `wt.params` (directly or spread); the importer gets its own values:

```ts
// utility "utils":
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
     with `modifyResponse` instead.
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
scripts top to bottom in the manager, then registration order within a
script. Per kind:

**`wt.onRequest`** — the first handler that returns a *terminal* result
(`respond`, `redirect`, or `cancel`) wins and stops the chain; later
handlers don't run for that request. Handlers that return nothing (or only
`headers`) don't stop the chain — their header changes merge (later `set`
wins per key, `remove` accumulates) and apply even when a later handler
terminates.

**`respond`** — a terminal result that synthesizes the response immediately,
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

It stacks like every terminal result: first handler to `respond` wins. On
`hook`, `cdp` and `process` the response is fulfilled in place with any
status and headers, URL kept. `webrequest` serves status 200 only (another
status is skipped with a warning): in place on Firefox, and on Chromium MV2
by redirect (a `data:` URL, or the extension's `serve.html` for page loads),
so the URL changes. See
[how each strategy serves a replacement](strategies.md#how-each-strategy-serves-a-replacement).

**`wt.onResponseHeaders`** — all matching handlers run and their changes
**merge**: `set` keys are applied in order (a later handler's `set` of the
same header overwrites earlier ones), `remove` lists accumulate.

**`wt.modifyResponse`** — transforms **compose** like a pipeline: handler
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

| handler | `hook` (page fetch/XHR) | `webrequest`, Chromium MV2 | `webrequest`, Firefox | `cdp` | `process` |
|---|---|---|---|---|---|
| `onRequest` redirect/cancel/respond | ✅ awaited | ⚠ result ignored, error logged — blocking webRequest can't await | ✅ awaited natively | ✅ awaited at the Request stage | ✅ awaited |
| `onRequest` headers | ✅ awaited | ⚠ ignored + error | ✅ awaited | ✅ awaited, applied at the Response stage | ✅ awaited, sent upstream |
| `onResponseHeaders` | — (not on `hook`) | ⚠ ignored + error | ✅ awaited | ✅ awaited, merged into the fulfilled headers | ✅ awaited |
| `replaceResponse` | ✅ awaited — the page's `fetch`/XHR promise simply takes as long as the handler needs | ⚠ result ignored + error (a sync redirect can't be built late) | ✅ awaited, written in place (URL kept) | ✅ awaited, fulfills the body | ✅ awaited, upstream never contacted |
| `modifyResponse` | ✅ awaited (chained between handlers) | — (can't read bodies) | ✅ awaited | ✅ awaited | ✅ awaited (served `no-store`) |
| `onDom` | runs in the page on every strategy; not awaited (fire-and-forget) | | | | |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `wt.modifyResponse(API, async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/cancel or header changes decided asynchronously** on Chromium?
  Use `process` or `cdp` (the default `process` already awaits). Only
  Chromium's `webrequest` can't: there an async result logs an error and the
  request proceeds unmodified — set `strategy: "process"` or `"cdp"` on the
  route.
- **Static replacement from an async source** (file read, fetch): async
  `replaceResponse` on the default strategy is all you need.
