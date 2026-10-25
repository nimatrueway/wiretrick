# Writing scripts

[← README](../README.md) · [Glossary](../GLOSSARY.md)

A script registers **handlers** at top level. Each handler takes its own
[route](#routes) first, then the function:

```ts
wt.about("Debug the user API");

const API = "*://app.example.com/api/*";

// Redirect / block / request headers / replaceResponse:
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
wt.onDocument("*://app.example.com/*", () => {
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
| `onDocument` route object | `wt.onDocument({ url, exclude, when }, fn)` |

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
    if (ctx.groups.id === "42") return { replaceResponse: { body: { id: 42, name: "Mock" } } };
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
  | `extension` | Checked in the listener before any script runs. |
  | `helper` | Checked after the helper pauses the request: filters correctly, saves no work. |
  | `page` | Only sees page fetch/XHR (`xmlhttprequest`). A list without `xmlhttprequest` means the handler never runs, and the Problems view warns. |
  | `rules` | Part of the browser-native rule: other types never match. |

  `onDocument` routes have no `resourceTypes` or `methods`.
- **`strategy`** — run this handler on one [strategy](strategies.md):
  `"helper"`, `"page"`, `"extension"`, `"debugger"` or `"rules"`. Omit to use the default
  from Settings → Strategy. There is no fallback: when the strategy
  isn't available, the handler doesn't run and the Log view says why.
  To pick per browser or build, use `wt.isChrome`, `wt.isFirefox`,
  `wt.isMV2` and `wt.isMV3` (Chromium-based browsers count as Chrome;
  MV3 is the `dist-mv3/` build):

  ```ts
  wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "extension" : "helper" }, (ctx, body) => body);
  wt.onRequest({ url: "*://api.example.com/*", strategy: wt.isMV3 ? "debugger" : "extension" }, fn);
  wt.onRequest({ url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }, () => ({ block: true }));
  ```

  On `rules` the handler runs once when scripts load and its fixed result
  (block, redirect, headers) becomes a browser-native rule; `exclude`
  isn't supported there ([what `rules` can do](strategies.md#what-rules-can-do)).

> **Tip:** `page` is the lightest strategy, but it only sees the page's own
> fetch/XHR (REST/API) calls. For documents, `<script src>`, images,
> workers, or anything that must not slip through, use `helper`,
> `extension` or `debugger`. See [strategies](strategies.md).
>
> **Note:** on Chromium MV2, `extension` can redirect the page itself and
> change its headers, but not its body in place: `onResponseBody` never
> runs and a replaced page moves to a `chrome-extension://` URL. Use
> `helper` or `debugger` for that ([details](strategies.md#which-strategy-for-which-job)).

### Binary bodies

`onResponseBody` handlers get **text** bodies only, as a string. The
route's `binary` option (only `onResponseBody` routes accept it) picks
which bodies the handler gets — **binary** ones are images, video, audio,
fonts, wasm, PDFs, archives, as a `Uint8Array`:

| `binary`   | text bodies | binary bodies | a binary body it misses           |
| ---------- | ----------- | ------------- | --------------------------------- |
| unset      | ✓ string    | —             | "never ran" warning in the Log    |
| `false`    | ✓ string    | —             | silent (a debug line says why)    |
| `true`     | —           | ✓ `Uint8Array`| —                                 |
| `"both"`   | ✓ string    | ✓ `Uint8Array`| —                                 |

```ts
// swap a logo for another image
wt.onResponseBody({ url: "*://example.com/img/logo*.png", binary: true }, async (ctx, body) => {
    const res = await fetch("https://example.org/other.png");
    return new Uint8Array(await res.arrayBuffer());
});

// look into everything on a CDN without changing it: playlists and segments
wt.onResponseBody({ url: "*://cdn.example.com/*", binary: "both" }, (ctx, body) => {
    if (typeof body === "string") console.log(ctx.url, "text", body.length, "chars");
    else console.log(ctx.url, body.length, "bytes, sync byte", body[0] === 0x47);
});

// text only, and no warning for the images it skips
wt.onResponseBody({ url: "*://example.com/*", binary: false }, (ctx, body) => body);
```

A `"both"` handler gets either, so check `typeof body`. Return values
work as for text: a string, a `Uint8Array` or an object (JSON) replaces
the body; `undefined` or the same body leaves it unchanged. Handlers
whose `binary` option excludes a body are skipped; when that leaves none
of a script's handlers for a body, the "onResponseBody never ran" warning
explains it — unless every one of them set `binary` explicitly (`false`,
or `true` on a text body), which counts as a choice: only a DEBUG line
records it.

**Text or binary** is decided once per response, the same way on every
strategy, from the `Content-Type` header (lowercased, parameters after
`;` dropped) matched against a list of globs, where `*` matches anything,
`/` included:

```
text/*  *json  *xml  *javascript  *ecmascript  *mpegurl  *yaml  *toml  *graphql  */x-www-form-urlencoded
```

So `image/svg+xml`, `application/vnd.api+json` and HLS playlists
(`application/vnd.apple.mpegurl`) are text; `image/png`, `video/mp2t` or
an Excel file (`application/vnd.openxmlformats-…sheet`) are binary. Set
`textTypes:` under `settings:` in `settings.yaml` to change it — the list
**replaces** the defaults, so copy the ones you still want:

```yaml
settings:
  textTypes:
    - text/*
    - "*json"
    - "*xml"
    - "*javascript"
    - application/x-ndjson-custom
```

The header is trusted. The body is only sniffed when `Content-Type` is
missing (a zero byte in the first 512 bytes → binary). A binary body
labeled `text/*` is therefore decoded as UTF-8, and if a handler rewrites
it the bytes are corrupted — fix it by narrowing `textTypes`. A text body
with an unlisted type (say `application/x-subrip`) is binary, so plain
handlers never see it: add the type to `textTypes`, or use `binary: true`
(or `"both"`) and decode it with `new TextDecoder().decode(body)`.

**Limitations and implications:**

- The whole body is buffered and the response is held until every handler
  finishes — for binary bodies too. A tapped video segment or large
  download costs memory and latency, and video playback can stall. Keep
  `binary: true` / `"both"` routes narrow (`url`, `resourceTypes`,
  `methods`).
- `helper` passes bodies up to 64 MB; larger ones are skipped (and the
  warning says so).
- On the MV3 build (every strategy) and on `page`, bodies cross extension
  messaging as base64: ~33% larger copies and extra CPU per body.
- Streams — server-sent events (`text/event-stream`) and
  `multipart/x-mixed-replace` — are never passed to `onResponseBody`.
- A Range request's `206` response holds only the requested part, so the
  handler gets partial bytes (common for video and audio).
- Responses served from the browser cache aren't seen.
- `Content-Encoding` (gzip, br…) is already decoded: the handler gets the
  plain bytes.
- `extension` on Chromium MV2 has no bodies at all and `rules` never
  does. `page` sees only the page's fetch/XHR, and binary bodies only for
  `fetch()`: an XHR with `responseType` `arraybuffer` or `blob` isn't
  intercepted (text XHRs are).
- `textTypes` is one global setting: it changes what every script sees.

## Request body

Every handler's `ctx` has the request payload, **read-only**:
`ctx.requestBody` is a string for text and a `Uint8Array` for binary,
decided by the request's `Content-Type` exactly like
[response bodies](#binary-bodies) (`textTypes` included). `ctx.json()`
parses it as JSON — the *request* body, not the response.

```ts
wt.onRequest({ url: "*://app.example.com/api/*", methods: ["POST"] }, (ctx) => {
    const q = ctx.json(); // undefined without a body; throws on invalid JSON
    if (q?.operationName === "GetFlags") return { replaceResponse: { body: { beta: true } } };
});
```

It is `undefined` when there is no body (GET, HEAD), it is over 8 MB, or
the strategy can't get it:

| strategy | what it gets | `undefined` for |
| --- | --- | --- |
| `page` | the page's fetch/XHR body (a copy; the page's own is never read) | `ReadableStream` bodies |
| `debugger` | the paused request's post data | uploads with a file part |
| `helper` | the body, buffered only for requests a handler pauses (helper 0.4.1+) | uploads that stall for 2 s (passed on untouched), older helpers |
| `extension` | webRequest's copy; a form post arrives URL-encoded, the kind is sniffed (no `Content-Type` yet) | file and very large uploads (Chromium omits them) |
| `rules` | — the handler runs once, without a request; reading it is an error | |

It is the same in `onRequest`, `replaceResponse`, `onResponseHeaders` and
`onResponseBody`. Changing it has no effect on what is sent.

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
    return { replaceResponse: { status: Number(cfg.status), body: { error: cfg.note, tags: cfg.tags } } };
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
    wt.onRequest(url, () => ({ replaceResponse: { body } }));
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

## Imports, folders and data files

A script's name is its path in the explorer: a script `api mock` in the
folder `mock` is named `mock/api mock` (`mock/api mock.ts` in the synced
folder). Imports resolve like TypeScript, relative to the importing
script's folder:

```ts
// in "mock/api mock":
import { double } from "./helpers";          // the script "mock/helpers"
import { envParam } from "../utils";         // the script "utils" at the root
import { mockJson } from "utils";            // bare: resolved from the root
```

The `.ts`/`.js` extension is optional and matching is case-insensitive. A
segment may also be written with every character other than letters,
digits, `_` and `-` replaced by `_` (`./My_Utils` finds "My Utils").

A **data file** is a JSON file in the explorer (`.json`); it never runs,
scripts import it by its path:

```ts
// data file "mock/rate-limits.json": { "max": 5, "window": 60 }
import limits from "./mock/rate-limits.json"; // the whole object
import { max } from "./mock/rate-limits.json"; // one property

wt.onRequest("*://api.example.com/*", () => ({ headers: { set: { "x-limit": String(max) } } }));
```

Each import gets a freshly parsed copy, so a handler changing it doesn't
affect other scripts. Saving, renaming or deleting a data file hot-applies
every script that imports it (directly or through a library). A missing
data file or invalid JSON is a compile error on the importing script,
naming the data file and the JSON error's line and column. In the Code
view the import is typed from the data file (hovers and completions show its
properties) and F12 on it opens the data file. Renaming or
moving a script, data file or folder doesn't rewrite the import specifiers
pointing at it.

### Packages from unpkg

A **package import** pulls an npm package into a script by its
[unpkg.com](https://unpkg.com) URL, pinned to an exact version:

```ts
import dayjs from "https://unpkg.com/dayjs@1.11.13";
import { addDays } from "https://unpkg.com/date-fns@4.1.0/addDays.js"; // a file inside the package
import { chunk } from "https://unpkg.com/lodash-es@4.17.21";

wt.onRequest("*://api.example.com/*", () => ({
    headers: { set: { "x-tomorrow": dayjs(addDays(new Date(), 1)).format("YYYY-MM-DD") } },
}));
```

The URL is `https://unpkg.com/<package>@<version>[/<path>]`. Scoped names
(`@scope/name`) and prerelease versions (`1.0.0-beta.1`) work. The version
must be exact: `dayjs`, `dayjs@1`, `dayjs@^1.11.0` or `dayjs@latest` are a
compile error on the import line (`pin an exact version, e.g.
https://unpkg.com/dayjs@1.2.3`), because a range could change what the
script runs. Other hosts, `http://` URLs and query strings aren't allowed.

**How it works.** Saving a script downloads the package (or the file you
named) and everything it imports: relative files, and the package's own
dependencies at the versions its `package.json` asks for. ES modules are
converted to CommonJS, and CommonJS/UMD files run as they are, like in
Node.js (`process.env.NODE_ENV` is `"production"`). The download is kept in
the extension's storage, so the script also runs offline and after a
restart. A pinned npm version never changes, so it isn't downloaded again.
Downloads no script imports any more are deleted when you save or delete
scripts. If the download fails (offline, a typo, a missing file), the import
line gets a compile error such as `cannot import "https://unpkg.com/…":
download failed (HTTP 404 — no such package, version or file)`; save again to retry. A dependency of the
package that fails to download isn't an error until the package `require`s
it at runtime, so optional dependencies don't break anything. Node.js
built-ins (`fs`, `path`, `crypto`, …) aren't available: `require("fs")`
throws `"fs" is a Node.js built-in — not available in Wiretrick scripts`.
Packages work on every strategy and in `wt.onDocument` handlers (the
downloaded code is sent to the page along with the script).

**Types.** Wiretrick also downloads the package's TypeScript declarations:
its own (`types`, `typings`, `exports` or a `.d.ts` next to the file), else
the matching `@types/<package>` major version. Packages with neither are
typed `any`. In the Code view, hovers, completions and errors work as soon as
the save that downloads them finishes. In the [synced
folder](editor.md#synced-folder) they're written to `.wiretrick/types/`, and
the generated `tsconfig.json` maps `https://unpkg.com/*` there (`paths`), so
VS Code and `tsc` type-check the same imports.

**Limits.**

- Only unpkg.com URLs can be imported. Packages that need Node.js built-ins,
  native code, WebAssembly fetched at runtime, or a bundler (CSS imports,
  `import.meta.url` assets) don't work.
- Top-level `await` in a package isn't supported. A script's `import()` of a
  package URL must be a string literal so the save finds and downloads it.
- Per import: at most 1000 files, 5 MB per file and 20 MB in total; typings
  stop at 500 files or 10 MB. A download times out after 15 s.
- `typesVersions` in a package's `package.json` is ignored.
- In the Code view, global declarations from downloaded typings are visible
  in every script (the synced folder's `tsconfig.json` doesn't include them).

**Security.** A package is third-party code that runs with the same powers as
your script: it sees and can change the requests and pages your handlers
touch. Import only packages you trust. Pinning means the code can't change
after you review it: npm versions are immutable, and the copy Wiretrick
stored is the one that runs. Downloads come straight from unpkg.com over
HTTPS, so you trust unpkg to serve npm's files unaltered. Only the extension
background downloads them (when scripts are saved, imported or compiled);
pages never fetch them.

## DOM changes — `wt.onDocument`

`wt.onDocument` is not a network strategy — it registers a **DOM-ready callback
that runs inside the page's MAIN world** (the same world as the page's own
JS). Its route is frame URL pattern(s), or `{ url, exclude, when }`. A
script may register several, each with its own route and `when`. Exact
timing:

1. **Injection**: our bridge content script (`document_start`, isolated
   world) injects `hook.js` into the page via a script tag before any page
   script runs. The hook asks the background for the scripts with an
   `onDocument` route matching this frame's URL and compiles them.
2. **Registration**: while compiling, the `wt.onDocument(route, handler)` calls
   whose route matches the frame are captured (the handler is stored, not
   yet run).
3. **Execution**: by default (`when: "document_end"`) the captured handlers
   run exactly once, when the `DOMContentLoaded` event fires — i.e. the
   full DOM is parsed and queryable, but stylesheets/images may still be loading, and framework
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
   wt.onDocument("*://example.com/*", () => { ... });                                       // default: document_end
   wt.onDocument({ url: "*://example.com/*", when: "document_start" }, () => { ... });      // while HTML is still parsing
   wt.onDocument({ url: "*://example.com/*", when: "document_end" }, () => { ... });        // DOMContentLoaded (DOM parsed)
   wt.onDocument({ url: "*://example.com/*", when: "document_idle" }, () => { ... });       // after the page's load event
   ```

   | `when` | Runs | DOM state | Use for |
   |---|---|---|---|
   | `document_start` | as soon as the script is compiled | `<html>` only; `head`/`body` usually `null` | stubbing globals, `MutationObserver` on `document`, capture listeners — getting in ahead of page code |
   | `document_end` *(default)* | at `DOMContentLoaded` (DOM parsed), `defer`/module scripts done | complete DOM; images/CSS/iframes may still load; framework hydration may not have happened | most title/text/attribute changes |
   | `document_idle` | after the page's `load` event | everything loaded | final layout/sizes, content built during load |

   - **Already past that moment?** (slow bundle, bfcache restore) The
     handler runs immediately.
   - **`document_start` race:** in the MV2 build the bundle arrives in ~1ms
     and reliably beats page scripts. In the MV3 build a cold service
     worker can take ~50-100ms, so early inline `<script>`s may already
     have run. When page code *must* see your change, rewrite the response
     with `onResponseBody` instead.
   - **`document_idle` always waits for the page's `load` event**, unlike
     Chrome's content-script `run_at: "document_idle"` (which can fire
     before `load`); one slow image or ad iframe delays it.
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

Because it runs as page JS, `wt.onDocument` works regardless of how the response
arrived — service-worker-served HTML, cached pages, or hydration overwriting
a body transform — which is exactly why it's the resilient choice for
title/DOM changes on SPAs.

## Multiple handlers — how they stack

The same rules apply on every strategy. When several handlers match a
request, two things decide what happens: **list order** and **stage**.

**List order** — scripts top to bottom in the Editor's explorer, then
registration order within a script. With folders, the explorer order is
depth-first: in each folder, its subfolders first (alphabetically, each with
its whole content), then its scripts in their own order.

**Stages** — a request goes through the stages in this order. Each stage runs
its handlers from every script in list order before the next stage starts:

```text
onRequest → replaceResponse → (network) → onResponseHeaders → onResponseBody
```

So a `wt.onRequest` block in the last script still wins over a
`wt.replaceResponse` in the first one.

### Final results end the request

A **final result** is an `onRequest` `block`, `redirect` or
`replaceResponse`, or a body returned by `wt.replaceResponse`. The first
one wins. Nothing runs on that request after it: no later handler of the
same stage, and no later stage. A replaced response never reaches the
network, `onResponseHeaders` or `onResponseBody`. A redirect starts a new
request to the target, and the handlers matching the target run on it.

```ts
wt.onRequest("*://api.example.com/me", () => ({
    replaceResponse: {
        body: { id: 1, name: "Mocked User" },  // object → JSON; strings/bytes pass through
        status: 200,                            // default 200
        mime: "application/json",               // default: guessed from the URL
        headers: { set: { "x-mock": "1" } },
    },
}));
```

On `page`, `debugger` and `helper` a replacement is served with any status
and headers, URL kept, and the request is never sent. `extension` serves
status 200 only (another status isn't served, with a warning): in place on
Firefox, where the request is sent and its body discarded, and on Chromium
MV2 by redirect (a `data:` URL, or the extension's `serve.html` for page
loads), so the URL changes. See
[how each strategy serves a replacement](strategies.md#how-each-strategy-serves-a-replacement).

### Results that stack

- **Header edits** (`onRequest` `headers`, `wt.onResponseHeaders`): every
  handler runs. For each header (case-insensitive) the **later handler in
  the list wins**, whether it sets or removes it. A later `remove` deletes an
  earlier `set`, and a later `set` undoes an earlier `remove`. Request
  header edits still apply when a later `onRequest` handler redirects.
- **`wt.onResponseBody`**: transforms **compose** like a pipeline. Handler
  A's output becomes handler B's input, in list order.

```text
body → [transform 1] → [transform 2] → … → page
```

### Across strategies

A handler's `strategy` decides which mechanism runs it, and the mechanisms
sit at different points on the request's way out. Each one is a layer:

```text
page → rules → extension → debugger → helper → server
```

Inside a layer the rules above apply. Across layers, the request reaches a
layer only if the layers in front of it let it through:

- A final result in one layer means the layers **behind** it never see the
  request (a `rules` block means the `helper` gets nothing).
- Layers **in front** see a replacement or a redirect as an ordinary
  response, so their `onResponseHeaders` and `onResponseBody` still run on
  it. A `helper` replacement still goes through a `page` `onResponseBody`.
- After a block there is no response, so the response handlers of the layers
  in front don't run either.

### Warnings when a handler is skipped

When a handler matches a request but doesn't run because of the rules above,
the Log shows a warning naming both handlers and the reason. In the Network
view the request is marked **missed** (filter: `is:missed`):

```text
[Cache buster] onResponseBody #1 → skipped: [API mocks] onRequest #1 → replaceResponse took priority (a replaced response is final) https://api.example.com/me
[Tracker] onRequest #1 → skipped: [Ad blocker] onRequest #2 → block took priority (it comes earlier in the list) https://ads.example.com/x.js
[Logger] onResponseBody #1 → skipped: [Blocklist] onRequest #1 → block took priority (strategy "rules" comes before "helper", so the request never got there) https://cdn.example.com/a.js
```

A header edit replaced by a later handler is a warning too:

```text
[B] onRequest #1 overrides request header "authorization" from [A] onRequest #1 (the later one in the list wins) https://api.example.com/me
```

Each warning is logged at most once a minute per handler and URL.

## Async handlers

All `wt.*` handlers may be `async` (return a Promise). What happens with the
result depends on the handler's strategy:

| handler | `page` (page fetch/XHR) | `extension`, Chromium MV2 | `extension`, Firefox | `debugger` | `helper` |
|---|---|---|---|---|---|
| `onRequest` redirect/block/replaceResponse | ✅ awaited | ⚠ result ignored, error logged — blocking webRequest can't await | ✅ awaited natively | ✅ awaited at the Request stage | ✅ awaited |
| `onRequest` headers | ✅ awaited | ⚠ ignored + error | ✅ awaited | ✅ awaited, applied at the Request stage | ✅ awaited, sent upstream |
| `onResponseHeaders` | — (not on `page`) | ⚠ ignored + error | ✅ awaited | ✅ awaited, merged into the fulfilled headers | ✅ awaited |
| `replaceResponse` | ✅ awaited — the page's `fetch`/XHR promise simply takes as long as the handler needs | ⚠ result ignored + error (a sync redirect can't be built late) | ✅ awaited, written in place (URL kept) | ✅ awaited at the Request stage, upstream never contacted | ✅ awaited, upstream never contacted |
| `onResponseBody` | ✅ awaited (chained between handlers) | — (can't read bodies) | ✅ awaited | ✅ awaited | ✅ awaited (served `no-store`) |
| `onDocument` | runs in the page on every strategy; not awaited (fire-and-forget) | | | | |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `wt.onResponseBody(API, async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/block or header changes decided asynchronously** on Chromium?
  Use `helper` or `debugger` (the default `helper` already awaits). Only
  the `extension` strategy on Chromium can't: there an async result logs an error and the
  request proceeds unmodified — set `strategy: "helper"` or `"debugger"` on the
  route.
- **Static replacement from an async source** (file read, fetch): async
  `replaceResponse` on the default strategy is all you need.
