# Writing scripts

[← README](../README.md)

```ts
wt.declareScript({
    match: ["*://app.example.com/api/user*"],
    // strategy: ["hook", "cdp"],   // optional — see strategies.md
});

// Redirect / cancel / request headers (synchronous):
wt.onRequest((ctx) => {
    // return { redirect: "https://myserver/user.json" };
    // return { cancel: true };
    return { headers: { set: { "x-debug": "1" } } };
});

// Response headers:
wt.onResponseHeaders((ctx) => {
    return { headers: { set: { "access-control-allow-origin": "*" } } };
});

// Replace the whole body:
// wt.replaceResponse(() => JSON.stringify({ mocked: true }));

// Stream-modify the body:
wt.modifyResponse((ctx, body) => body.replace('"role":"user"', '"role":"admin"'));
```

## Libraries

`wt.declareScript` is the only way to activate a script.
A source file without it is a **library**: inert on
its own (never matches, hidden from the popup) but importable by other
scripts:

```ts
// saved script named "utils" (utils.ts in the synced folder):
export function forceFail(url: string) { /* ... */ }

// in your script:
import { forceFail } from "./utils";   // "./utils", "utils", "utils.ts" all resolve
```

## Parameters — adjustable knobs

`params` are typed knobs the user changes from the popup's ⚙ dialog without
touching the script:

```ts
const cfg = wt.declareScript({
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

wt.onRequest((ctx) => {
    if (!cfg.enabled) return;
    return { respond: { status: Number(cfg.status), body: { error: cfg.note, tags: cfg.tags } } };
});
```

Param values persist per script and apply on save — the change hot-reloads
like a code edit. Parameter types: `boolean` (switch), `string` (text; add `multiline: true` for a textarea, written to
`settings.yaml` as a `|` block scalar when it contains newlines),
`enum` (dropdown of `choices`), `stringList` (add/remove list).

## DOM changes — `wt.onDom`

`wt.onDom` is not a network strategy — it registers a **DOM-ready callback
that runs inside the page's MAIN world** (the same world as the page's own
JS). Exact timing:

1. **Injection**: our bridge content script (`document_start`, isolated
   world) injects `hook.js` into the page via a script tag before any page
   script runs. The hook loads, fetches the scripts matching this page from
   the background, compiles them, and patches `fetch`/`XMLHttpRequest`.
2. **Registration**: while compiling, any `wt.onDom(handler)` calls are
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
5. **Timing — `{ when }`**: the second argument picks the moment. Each
   script keeps its own `when`; scripts with the same `when` run in list
   order.

   ```ts
   wt.onDom(() => { ... });                             // default: DOMContentLoaded
   wt.onDom(() => { ... }, { when: "document_start" }); // while HTML is still parsing
   wt.onDom(() => { ... }, { when: "document_end" });   // alias of DOMContentLoaded
   wt.onDom(() => { ... }, { when: "document_idle" });  // after window load
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
   - **One `onDom` per script:** a later call replaces the earlier one
     (and its `when`).
   - **Async handlers** aren't awaited; `when` only sets when they start.
   - **CSP fallback:** if the page forbids `eval`, handlers run in the
     extension's isolated world — same DOM and timing, but page globals
     (`window.myApp`) aren't visible.

Because it runs as page JS, `wt.onDom` works regardless of how the response
arrived — service-worker-served HTML, cached pages, or hydration overwriting
a CDP transform — which is exactly why it's the resilient choice for
title/DOM changes on SPAs.

## Multiple scripts — how handlers stack

When several enabled scripts match the same request, they run in **list
order** (top to bottom in the manager) with per-hook rules:

**`wt.onRequest`** — the first script that returns a *terminal* result
(`respond`, `redirect`, or `cancel`) wins and stops the chain; later scripts
don't run for that request. Scripts that return nothing (or only `headers`)
don't stop the chain — their header changes merge (later `set` wins per key,
`remove` accumulates) and apply even when a later script terminates.

**`respond`** — a terminal result that synthesizes the response immediately,
**without the network request ever happening**:

```ts
wt.onRequest((ctx) => ({
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

**`wt.onResponseHeaders`** — all matching scripts run and their changes
**merge**: `set` keys are applied in order (a later script's `set` of the
same header overwrites earlier ones), `remove` lists accumulate.

**`wt.modifyResponse`** — transforms **compose** like a pipeline: script A's
output becomes script B's input, in list order.

```text
body → [script 1 transform] → [script 2 transform] → … → page
```

**`wt.replaceResponse`** — the first script that returns a body wins;
later ones are skipped.

**Across strategies**: a script's `strategy` list only decides *which tier*
runs its handler — stacking order between scripts is unchanged regardless of
which tier each one uses.

## Async handlers

All `wt.*` hooks accept `async` handlers (returning a Promise). What happens
with the result depends on the tier:

| hook | hook tier (page fetch/XHR) | webRequest tier (Chromium MV2) | webRequest tier (Firefox) | cdp tier (Chrome, `strategy: ["cdp"]`) | process tier (Chrome, `strategy: ["process"]`) |
|---|---|---|---|---|---|
| `onRequest` redirect/cancel | n/a (hook doesn't redirect) | ⚠ result ignored, warning logged — blocking webRequest can't await; use `strategy: ["cdp"]` | ✅ awaited natively | ✅ awaited at the Request stage (redirect/cancel honored) | ✅ awaited (redirect/cancel/respond honored) |
| `onRequest` headers | n/a | ⚠ ignored + warning | ✅ awaited | ✅ awaited, applied at the Response stage | ✅ awaited, sent upstream |
| `onResponseHeaders` | n/a | ⚠ ignored + warning | ✅ awaited | ✅ awaited, merged into the fulfilled headers | ✅ awaited |
| `replaceResponse` | ✅ awaited — the page's `fetch`/XHR promise simply takes as long as the handler needs | ⚠ result ignored (a sync data-URL can't be built late) → the request is re-routed to the cdp tier | ✅ awaited, then redirect | ✅ awaited, fulfills the body | ✅ awaited, upstream never contacted |
| `modifyResponse` | ✅ awaited (chained between scripts) | — (re-routed to cdp) | ✅ awaited per chunk | ✅ awaited | ✅ awaited (served `no-store`) |
| `onDom` | ✅ awaited (fire-and-forget) | — | — | — | — |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `wt.modifyResponse(async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/cancel decided asynchronously** (e.g. after an API lookup)?
  Add `"cdp"` to `strategy` (`strategy: ["hook", "cdp"]`) so the CDP tier can await
  your handler; note the debugger banner appears while such requests are
  intercepted. Without `cdp`, an async `onRequest` on Chrome logs a warning
  and the request proceeds unmodified.
- **Async header changes** on Chrome likewise need `strategy: ["cdp"]`.
- The `process` tier awaits every handler kind (same as the cdp column,
  without the banner) — the simplest way to get async redirects/headers on
  Chrome.
- **Static replacement from an async source** (file read, fetch): async
  `replaceResponse` + default strategy is all you need.
