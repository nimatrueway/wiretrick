# Writing scripts

[← README](../README.md) · [Glossary](../GLOSSARY.md)

A script registers **handlers** at top level. Each handler takes its own
[route](#routes) first, then the function:

```ts
wt.metadata({ description: "Debug the user API" });

const API = { url: "*://app.example.com/api/*", strategy: "helper" } as const;

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
// wt.replaceResponse({ ...API, url: "*://app.example.com/api/flags" }, () => ({ beta: true }));

// Stream-modify the body:
wt.onResponseBody({ url: "*://app.example.com/api/user*", strategy: "helper" }, (ctx, body) => String(body).replace('"role":"user"', '"role":"admin"'));

// Patch the page itself:
wt.onPage("*://app.example.com/*", () => {
    document.title = "🎯 " + document.title;
});

// Draw the script's own GUI over the page:
wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, () => {
    document.body.append("Hello from the overlay");
});
```

Register handlers synchronously at top level. A registration after an
`await` or inside a callback logs an error and is ignored. A file that
registers no handlers is a [library](#libraries-and-recipes). To share a
script, publish it at a URL ending in `.wiretrick.ts`; opening that URL
[installs it](packages.md).

## Routes

The first argument of every handler says where it applies. A network
handler's route is an object with `url` and a required `strategy` — there
is no default strategy, and a bare URL pattern isn't accepted (the script
fails to load and the Problems view points at the call):

| form | example |
|---|---|
| one URL pattern | `wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, fn)` |
| a list | `wt.onRequest({ url: ["*://a.example.com/*", "*://b.example.com/*"], strategy: "helper" }, fn)` |
| all options | `wt.onRequest({ url, exclude, methods, resourceTypes, strategy }, fn)` |
| `onPage` (no strategy) | `wt.onPage("*://example.com/*", fn)` or `wt.onPage({ url, exclude, when, js, dom, unsafe }, fn)` |

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
wt.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => {
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

  `onPage` routes have no `resourceTypes` or `methods`.
- **`strategy`** — **required**: the [strategy](strategies.md) that runs
  this handler: `"helper"`, `"page"`, `"extension"`, `"debugger"` or
  `"rules"`. There is no default — a route without one (or a bare URL
  pattern) makes the script fail to load. There is no fallback: when the strategy
  isn't available, the handler doesn't run and the Log view says why.
  To pick per browser or build, use `wt.isChrome`, `wt.isFirefox`,
  `wt.isMV2` and `wt.isMV3` (Chromium-based browsers count as Chrome;
  MV3 is the `dist-mv3/` build):

  ```ts
  wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "extension" : "helper" }, (ctx, body) => body.replace("DEBUG=false", "DEBUG=true"));
  wt.onRequest({ url: "*://api.example.com/*", strategy: wt.isMV3 ? "debugger" : "extension" }, fn);
  wt.onRequest({ url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }, () => ({ block: true }));
  ```

  On `rules` the handler runs once when scripts load and its fixed result
  (block, redirect, headers) becomes a browser-native rule; `exclude`
  isn't supported there ([what `rules` can do](strategies.md#what-rules-can-do)).
  Its code never runs for a request, so the Problems view warns about
  `console.log`, `wt.log`, `fetch`, timers and store writes in it.

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
wt.onResponseBody({ url: "*://example.com/img/logo*.png", binary: true, strategy: "helper" }, async (ctx, body) => {
    const res = await fetch("https://example.org/other.png");
    return new Uint8Array(await res.arrayBuffer());
});

// look into everything on a CDN without changing it: playlists and segments
wt.onResponseBody({ url: "*://cdn.example.com/*", binary: "both", strategy: "helper" }, (ctx, body) => {
    if (typeof body === "string") console.log(ctx.url, "text", body.length, "chars");
    else console.log(ctx.url, body.length, "bytes, sync byte", body[0] === 0x47);
});

// text only, and no warning for the images it skips
wt.onResponseBody({ url: "*://example.com/*", binary: false, strategy: "helper" }, (ctx, body) => console.log(ctx.url, body.length));
```

A `"both"` handler gets either, so check `typeof body`. Return values
work as for text: a string, a `Uint8Array` or an object (JSON) replaces
the body; returning nothing (`undefined` / `null`) leaves it unchanged.
Any returned body counts as a change, even the one the handler received:
it's re-encoded and served (a text body loses a BOM). Handlers
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

A non-text `Content-Type` is trusted. A text one is checked against the
bytes: a body that isn't valid UTF-8 (a binary payload served as
`text/plain`, a Latin-1 page) is binary, so it's never handed out as a
string that would corrupt it. Without a `Content-Type` the body is
sniffed (a zero byte in the first 512 bytes, or invalid UTF-8 → binary).
A text body
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
wt.onRequest({ url: "*://app.example.com/api/*", methods: ["POST"], strategy: "helper" }, (ctx) => {
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

`wt.metadata({ description: "…" })` sets a one-line description, shown as
the script's tooltip in the Editor and in the popup. Its other fields —
`name`, `version`, `homepage`, `author`, `license`, `updateURL` and `connect` — describe
the script as a shared package (see [Packages](packages.md)). Call it once.

`wt.params` declares typed knobs the user changes from the popup's ⚙
dialog, the Editor or `settings.yaml` without touching the script:

```ts
wt.metadata({ description: "Force failures on the posts API" });

const cfg = wt.params({
    enabled: { type: "boolean", default: true, description: "Master switch" },
    status:  { type: "enum", choices: ["500", "503"], default: "500" },
    note:    { type: "string", default: "forced failure" },
    tags:    { type: "stringList", default: [] },
});
// cfg.enabled: boolean · cfg.status: "500" | "503" · cfg.note: string · cfg.tags: string[]

wt.onRequest({ url: "*://app.example.com/posts/*", strategy: "helper" }, () => {
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
wt.onResponseHeaders({ url: cfg.hosts.map((h) => `*://${h}/*`), strategy: "helper" }, () => ({
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
import it.

```ts
// utils.ts:
export function double(n: number) { return n * 2; }

// in your script:
import { double } from "./utils";   // "./utils", "utils", "utils.ts" all resolve
```

A library can export **recipes** — functions that register handlers. The
handler belongs to the script that calls the recipe (its badge, log, popup
entry and params):

```ts
// mocks.ts:
export function mockJson(url: string, body: object) {
    wt.onRequest({ url, strategy: "helper" }, () => ({ replaceResponse: { body } }));
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
// gate.ts: a library until "on" is switched on
const p = wt.params({ on: { type: "boolean", default: false } });
if (p.on) wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => ({ block: true }));
```

Param definitions can be shared too — export them from a library and pass
them to `wt.params` (directly or spread); the importer gets its own values:

```ts
// utils.ts:
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

The `.ts`/`.tsx`/`.js` extension is optional (with both `x.ts` and `x.tsx`,
`./x` is the `.ts` one) and matching is case-insensitive.

A **data file** is a JSON or SVG file in the explorer (`.json`, `.svg`); it
never runs, scripts import it by its path:

```ts
// data file "mock/rate-limits.json": { "max": 5, "window": 60 }
import limits from "./mock/rate-limits.json"; // the whole object
import { max } from "./mock/rate-limits.json"; // one property

wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => ({ headers: { set: { "x-limit": String(max) } } }));
```

An `.svg` imports as its markup, a string (`import logo from
"./icons/logo.svg"` → `'<svg …>…</svg>'`), e.g. for an overlay's
`innerHTML` or a mocked response body.

Each JSON import gets a freshly parsed copy, so a handler changing it doesn't
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

wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
    headers: { set: { "x-tomorrow": dayjs(addDays(new Date(), 1)).format("YYYY-MM-DD") } },
}));
```

The URL is `https://unpkg.com/<package>@<version>[/<path>]`. Scoped names
(`@scope/name`) and prerelease versions (`1.0.0-beta.1`) work. The version
must be exact: `dayjs`, `dayjs@1`, `dayjs@^1.11.0` or `dayjs@latest` are an
error, because a range could change what the script runs. The Editor
underlines such a URL as you type (`pin an exact version, e.g.
https://unpkg.com/dayjs@1.2.3`), and its quick fix (**Ctrl+.** / **⌘.**,
or the light bulb) rewrites it to the version unpkg serves now, e.g.
`https://unpkg.com/dayjs` → `https://unpkg.com/dayjs@1.11.13`. Other
hosts, `http://` URLs and query strings aren't allowed.

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
Packages work on every strategy and in `wt.onPage` (and overlay)
handlers (the downloaded code is sent to the page along with the script).

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
  native code, WebAssembly fetched at runtime, or a bundler (`import.meta.url`
  assets, CSS imported from inside a package's JavaScript) don't work.
- A `.css` file (`import "https://unpkg.com/daisyui@5.0.43/daisyui.css"`)
  becomes a `<style>` in the script's [overlay](#overlays--dom-overlay);
  everywhere else it's ignored.
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

## Shared state and fetching — `wt.globalStore`, `wt.pageStore`, `wt.fetch`

### `wt.globalStore`

`wt.globalStore(name, initial)` returns a live object that every copy of the
script shares: its handlers on every strategy see the same values, and
changes survive a browser restart. It's a [valtio](https://valtio.dev)
proxy — read and assign like a plain object.

```ts
const state = wt.globalStore("state", { mocking: true, hits: 0, seen: [] as string[] });

wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => {
    state.hits++;
    state.seen.push(ctx.url);
    if (state.mocking) return { replaceResponse: { body: { mocked: true } } };
});
```

- **Name.** The first argument is the store's key: one store per name per
  script. A script with two stores uses two names. Call `wt.globalStore` at top
  level and share the result; a second call with the same name throws.
- **Initial.** Used the first time. Later, the saved values win and
  `initial` only adds fields that are missing, so you can add fields
  without losing data.
- **Persist.** `{ persist: true }` (default) keeps the whole store across
  browser restarts; `{ persist: false }` keeps it only while the browser
  runs; `{ persist: ["mocking"] }` keeps only those top-level fields.
- **Values.** JSON only — objects, arrays, strings, numbers, booleans,
  `null` — at most 1 MB per store. A change that breaks this is undone and
  logged. Functions and getters on the object stay local and aren't shared.
- **Watching.** `import { subscribe } from "valtio"` runs code when the
  store changes. A `rules` handler that reads a store is re-run (and its
  rules rebuilt) when the store changes.
- The saved copy lives in `wt.storage` as `"$store:<name>"`; change the
  store, not that key (writing it logs a warning).

### `wt.pageStore`

`wt.pageStore(name, initial)` is a store with one copy per page. Each
tab's page starts from `initial`; a navigation or a reload starts a new
page, so its copy starts over (a single-page app's route change doesn't).
A network handler sees the copy of the page its request comes from, and an
overlay sees its own page's — so the overlay and the handlers of that
page's requests share state, and other tabs aren't affected.

```ts
const page = wt.pageStore("page", { staging: false });

wt.onRequest({ url: "https://api.example.com/*", strategy: "helper" }, (ctx) => {
    if (page.staging) return { redirect: ctx.url.replace("api.", "staging-api.") };
});

wt.onPage({ url: "https://example.com/*", dom: "overlay" }, () => {
    const box = document.body.appendChild(document.createElement("input"));
    box.type = "checkbox";
    box.onchange = () => (page.staging = box.checked); // this tab only
});
```

- **Read it before the first `await`.** The handler knows its page only in
  its synchronous part; after an `await` the store throws. Read what you
  need first.
- **Which page.** A navigation's own requests (the document, a redirect of
  it) belong to the page being left. Requests that aren't from a page
  (service workers, other apps through the helper) get a throwaway copy of
  `initial` for that call.
- **Lifetime.** A page's copy goes when the page ends (navigation, reload
  or closing the tab); it's never saved to disk. Values follow the same
  JSON rules as `wt.globalStore`.
- **Names.** One name space with `wt.globalStore`: a script can't have a
  global and a page store with the same name.
- Available in `onPage` code (the copy of its page) and the overlay; not
  in page-world `onPage` code (`js: "page"`, see below) unless it opts in
  with `unsafe: true`, nor in `rules` handlers (their rules are built once for every
  page).

### Stores in `onPage` code

`onPage` code (isolated, the default world) gets live copies of the script's stores, like the overlay: reads are
synchronous, writes reach the background, the overlay and other tabs
(`wt.pageStore`: this page's copy only), and their changes come back.

Page-world `onPage` code (`js: "page"`) runs in the page's own
JavaScript, so the page could read the stores and forge writes to them.
There, `wt.globalStore` and `wt.pageStore` throw, and calls to an
overlay handle reject — anything page-world code can call, the page can
call too. Keep such code isolated and reach into the page with
[`ctx.evaluate`](#reading-the-page--ctxevaluate) instead. The Problems view
warns about a page-world `onPage` handler that uses a store or an
overlay handle ("…which the API explicitly disallows in the page
world"); its quick fix drops `js: "page"`.

If the code must live in the page's world anyway, `unsafe: true` on its
route accepts that risk: that script's page-world code then gets live
stores (same copies, persistence and cross-tab sync as isolated code)
and can call its overlay (top frame). The page can then read and change
**that script's** stores and call its overlay too — never another
script's: the background only lets a script's stores be reached from the
page's world when that script has an `unsafe: true` page-world route for
the frame's URL, and checks again whenever scripts change.

```ts
const state = wt.globalStore("state", { user: "" });
const overlay = wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, () => ({
    greet: (name: string) => `hi ${name}`,
}));

wt.onPage({ url: "*://app.example.com/*", js: "page", unsafe: true }, async () => {
    state.user = (window as any).myApp?.user?.name ?? "";  // the site's globals, directly
    document.title = await overlay.greet(state.user);
});
```

The built-in `react` and `valtio` imports still aren't available there
(watch a store with a timer or from the overlay instead).

```ts
const page = wt.pageStore("page", { hits: 0 });

wt.replaceResponse({ url: "https://example.com/api/*", strategy: "page" }, () => {
    page.hits++;
});

wt.onPage("https://example.com/*", () => {
    const badge = document.body.appendChild(document.createElement("output"));
    setInterval(() => (badge.value = `${page.hits} API calls`), 500);
});
```

### `wt.fetch`

`wt.fetch(url, init)` is `fetch` for scripts. It runs in the background,
with the extension's host permissions (no CORS) and the browser's cookies,
and returns a normal `Response`.

```ts
// the real response, even though this script mocks the same URL
wt.replaceResponse({ url: "*://api.example.com/user", strategy: "helper" }, async () => {
    const real = await (await wt.fetch("https://api.example.com/user", { bypass: true })).json();
    return { ...real, role: "admin" };
});
```

- `bypass: true` keeps every script's handlers — this one's too — off
  that request. The Log lists it as a `bypass`.
- The URL must be absolute. Bodies are capped at 10 MB each way.
  `signal` (abort) isn't supported.
- `from: "background"` is the default in handlers. `from: "page"` fetches
  as the page — its origin, cookies and CORS rules — and works only in
  [overlays](#overlays--dom-overlay), where it's the default (relative URLs
  resolve against the page); in handlers it rejects.

### Built-in valtio and React

`valtio` (and `valtio/vanilla`, `valtio/utils`, `valtio/react`) and React 19
(`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) come with the
extension: import them by name, or by any `https://esm.sh/` URL of those
packages, with no download. They load only in scripts that import them.
JSX (`<div />`) goes in a `.tsx` script — one whose name ends in `.tsx`,
like `ui/Panel.tsx` (create or rename it with the extension; a plain
script's `.ts` is implied). It compiles with React's automatic runtime, so
components need no `import React`. JSX in a `.ts` script is an error with a
**Rename to Name.tsx** quick fix. The built-ins work in `wt.onPage`
code too (the default isolated world: React loads into it on first use,
and handlers that import it start once it has), but not with
`js: "page"`, where using one throws.

```ts
import { subscribe } from "valtio";

const state = wt.globalStore("state", { mocking: false });
subscribe(state, () => wt.log("mocking is now", state.mocking));
```

## DOM changes — `wt.onPage`

`wt.onPage` is not a network strategy — it registers a **DOM-ready callback
that runs in the page**: by default in an isolated world (same DOM, none of
the page's own JS), or with `js: "page"` in the page's own JavaScript
world; with `dom: "overlay"` it draws the script's [own GUI](#overlays--dom-overlay)
instead. Its route is frame URL pattern(s), or `{ url, exclude, when, js, dom, unsafe }`.
A script may register several, each with its own route, `when`, `js` and `dom`. Exact
timing:

1. **Injection**: our bridge content script (`document_start`, isolated
   world) injects `hook.js` into the page via a script tag before any page
   script runs. The hook (page world) and the isolated runtime ask the
   background for the scripts with an `onPage` route matching this frame's
   URL and compile them.
2. **Registration**: while compiling, the `wt.onPage(route, handler)` calls
   whose route matches the frame are captured (the handler is stored, not
   yet run).
3. **Execution**: by default (`when: "document_end"`) the captured handlers
   run exactly once, when the `DOMContentLoaded` event fires — i.e. the
   full DOM is parsed and queryable, but stylesheets/images may still be loading, and framework
   hydration (React/Vue) has *not* necessarily finished yet.
   - If the hook's bundle arrives **after** `DOMContentLoaded` already fired
     (late bundle, bfcache restore), handlers run immediately at
     registration time.
4. **Context**: handlers get full DOM access — `document.title` writes,
   observers, etc. They can be `async` (the engine doesn't await
   them). `ctx` is the same request-context shape (`url`, `method`, …) with
   the frame URL.
5. **Timing — `when`**: the route object picks the moment. Handlers with
   the same `when` run in script-list order, then registration order.

   ```ts
   wt.onPage("*://example.com/*", () => { ... });                                       // default: document_end
   wt.onPage({ url: "*://example.com/*", when: "document_start" }, () => { ... });      // while HTML is still parsing
   wt.onPage({ url: "*://example.com/*", when: "document_end" }, () => { ... });        // DOMContentLoaded (DOM parsed)
   wt.onPage({ url: "*://example.com/*", when: "document_idle" }, () => { ... });       // after the page's load event
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
   - **`js`** — which JavaScript world the handler runs in:

     | `js` | Sees | The page | May use |
     |---|---|---|---|
     | `"isolated"` *(default)* | the DOM; no page globals (`window.myApp`) — read them with [`ctx.evaluate`](#reading-the-page--ctxevaluate) | can't see or tamper with it | stores, calling the overlay ([the isolated world](#the-isolated-world)) |
     | `"page"` | the DOM and the page's globals; its `fetch`/XHR go through the `page` strategy | sees it, can tamper with it | neither (stores throw, overlay calls reject) — unless `unsafe: true` ([stores in `onPage` code](#stores-in-onpage-code)), which the page then reaches too |

     On Chrome (MV3) isolated code needs user scripts turned on
     ([how](#user-scripts-on-chrome)); `js: "page"` code doesn't.

     ```ts
     wt.onPage("*://example.com/*", () => { ... });                       // isolated
     wt.onPage({ url: "*://example.com/*", js: "page" }, () => { ... });  // the page's own world
     ```
   - **`dom`** — which document it draws in: `"page"` *(default)*, the
     site's, in every matching frame; or `"overlay"`, the script's own
     ([overlays](#overlays--dom-overlay)). Together:

     | `js` \\ `dom` | `"page"` | `"overlay"` |
     |---|---|---|
     | `"isolated"` | the default | the overlay, in its own frame |
     | `"page"` | the site's world | the overlay's document, the site's world — needs `unsafe: true` ([below](#page-world-overlays--unsafe-true)) |
   - **CSP fallback:** if the page forbids `eval`, `js: "page"` handlers
     run in the extension's isolated world — same DOM and timing, but page
     globals aren't visible.

### Reading the page — `ctx.evaluate`

`ctx.evaluate(fn, ...args)` runs `fn` in the page's own JavaScript world
from isolated code and resolves with its result (awaited if it returns a
promise) — so you can read the site's globals without moving the whole
handler into the page:

```ts
wt.onPage("*://app.example.com/*", async (ctx) => {
    const user = await ctx.evaluate((key: string) => (window as any).app?.[key], "user");
    if (typeof user?.name === "string") panel.textContent = user.name;
});
```

- `fn` is sent as source and runs on its own: it can't use the script's
  variables, imports or `wt` — pass what it needs as `args`. Arguments and
  the result are plain data (structured-clonable); anything else rejects.
- A function argument (also one inside a plain object or array) is a
  **callback**: `fn` gets a stand-in that calls it back in isolated code, where stores and the overlay are — also later, from
  the site's own events, for as long as the document lives. Its arguments
  are copied plain data the site could fake; it returns nothing to `fn`.

  ```ts
  const ps = wt.pageStore("app", { user: "" });

  wt.onPage("*://app.example.com/*", (ctx) =>
      ctx.evaluate((setUser) => {
          const app = (window as any).app;
          setUser(app.user?.name);
          app.on("login", (u: any) => setUser(u?.name));
      }, (name: unknown) => {
          if (typeof name === "string") ps.user = name;
      })
  );
  ```

- Errors are the script's (Problems view, red badge), not the site's: a
  callback that throws, a callback the page calls with arguments that
  aren't plain data (the call is dropped), and a rejection your code
  doesn't handle. So is a rejecting `async` handler.
- It runs as page code: the page sees the call and can fake the answer, so
  treat the result as [page data](#page-world-results-are-page-data) and
  never pass secrets (store values, tokens) in.
- It rejects with what `fn` threw, when the page's CSP forbids `eval`, and
  when Wiretrick's page hook isn't running in the frame. A script variable
  used in `fn` rejects with "isn't defined in the page world", and the
  Problems view warns about it as you save.
- A `fetch` made in `fn` is the page's own, so the `page` strategy sees
  it; a `fetch` made in isolated code isn't.

Because it runs in the page, `wt.onPage` works regardless of how the response
arrived — service-worker-served HTML, cached pages, or hydration overwriting
a body transform — which is exactly why it's the resilient choice for
title/DOM changes on SPAs.

## Overlays — `dom: "overlay"`

`wt.onPage({ url, dom: "overlay" }, fn)` gives a script its own GUI on a page: `fn` runs
in a transparent frame laid over the tab, and whatever it draws in that
frame's `document` shows on top of the page. Clicks on empty areas go
through to the page.

```tsx
import { createRoot } from "react-dom/client";
import { useSnapshot } from "valtio";

const mock = wt.globalStore("mock", { enabled: false });

wt.replaceResponse({ url: "*://app.example.com/api/me", strategy: "helper" }, () =>
    mock.enabled ? { name: "Test user", plan: "pro" } : undefined);

wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, () => {
    function Panel() {
        const snap = useSnapshot(mock);
        return (
            <label style={{ position: "fixed", right: 16, bottom: 16 }}>
                <input type="checkbox" checked={snap.enabled}
                       onChange={() => (mock.enabled = !mock.enabled)} /> Mock /api/me
            </label>
        );
    }
    createRoot(document.body.appendChild(document.createElement("div"))).render(<Panel />);
});
```

Clicking the box changes `mock.enabled`; the next `/api/me` request sees
it right away, and the value survives restarts.

- **Route.** The same as any `wt.onPage` (`{ url, exclude, when, dom:
  "overlay" }`), matched against the tab's top page. Overlays exist in
  the top frame only.
- **One overlay per script per tab.** Every matching overlay handler of
  the script runs in the same frame, in registration order, sharing the
  script's top-level variables. The frame is created at the earliest
  matching `when`; a script whose routes don't match gets none.
- **What runs there.** The whole script evaluates in the frame, but only
  its overlay handlers run: network handlers and `dom: "page"` handlers
  register nothing there. Stores (`wt.globalStore`) are live copies of the
  background's, so the GUI and the handlers see the same values; a
  `wt.pageStore` is the copy of the overlay's page. `wt.log`,
  `console.*`, errors and unhandled rejections go to the script's Log.
- **Isolation.** The page's CSS can't reach the GUI and the GUI's CSS
  can't leak into the page. The page can't find the frame (it sits in a
  closed shadow root) or read the script's code, which comes from the
  extension, never through the page. Strict page CSPs don't stop it.
- **Clicks and stacking.** The frame covers the viewport; the parts with
  visible elements take clicks and everything else lets them through to
  the page. A full-viewport element (a modal backdrop) takes every click.
  With several scripts' overlays, the one last clicked is on top.
- **Saving and disabling.** Saving the script reloads its overlay (store
  values stay); disabling it removes the overlay.
- **Preview in the Editor.** The Editor's **Preview** tab (⌥⇧V) runs the
  open script's overlay without its page, with the real stores, and reloads
  it on save; see [Preview](editor.md#preview).
- **`ctx`.** `ctx.url` is the page's URL. `ctx.onNavigate(fn)` runs `fn(url)`
  whenever the page navigates in place (`pushState`, back/forward,
  `#hash`), as single-page apps do; the overlay stays. It returns a
  function that stops listening.

  ```ts
  wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, (ctx) => {
      const badge = document.body.appendChild(document.createElement("div"));
      badge.textContent = "In the cart";
      const show = (url: string) => (badge.hidden = !url.includes("/cart"));
      show(ctx.url);
      ctx.onNavigate(show);
  });
  ```

### Keyboard shortcuts

`ctx.shortcut(keys, fn)` runs `fn` when the keys are pressed on the page:

```ts
wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, (ctx) => {
    const box = document.body.appendChild(document.createElement("div"));
    box.textContent = "Hello";
    box.hidden = true;
    ctx.shortcut("Alt+Shift+H", () => (box.hidden = !box.hidden));   // beats the page's own shortcuts
    // ctx.shortcut("Mod+K", fn, { priority: "after-page" })          // only if the page didn't handle it
});
```

- **Keys.** Modifiers (`Mod`, `Ctrl`, `Alt`, `Shift`, `Meta`, in any
  order) then one key: a character (`K`, `1`, `/`) or a name (`Esc`,
  `Enter`, `Space`, `Up`, `F2`, `Plus`). `Mod` is ⌘ on macOS and Ctrl
  elsewhere. Modifiers must match exactly; `Alt+L` works with Option on
  macOS too.
- **Before or after the page.** By default the shortcut wins: the page
  never sees the key. With `{ priority: "after-page" }` it runs only if
  the page didn't handle the key (didn't call `preventDefault` or stop it).
- **Where.** On the page (its top frame) and while the overlay has focus.
  Keys typed into a text field, `<select>` or editable area are left
  alone, and events the page makes up itself don't count.
- **Several scripts.** If two scripts' overlays use the same keys, the
  one higher in the script list gets them; the other's Log says so.
- `ctx.shortcut` returns a function that removes the shortcut. Shortcuts
  go away with the overlay (save, disable).

### Fetching from the overlay

The overlay's own `fetch` is the page's: the page's content script makes
the request, with the page's origin, cookies and CORS rules, and relative
URLs resolve against the page. Your scripts' handlers see it like any
request — on every strategy except `page`, which only sees the page's own
JavaScript. `wt.fetch` defaults to the same in an overlay; `bypass: true`
keeps every script's handlers off the request, and `from: "background"`
fetches from the extension instead (host permissions, no CORS).

```ts
wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, async () => {
    const me = await (await fetch("/api/me")).json();                            // as the page, through your handlers
    const real = await (await wt.fetch("/api/me", { bypass: true })).json();     // as the page, skipping all handlers
    const other = await wt.fetch("https://other.site/x", { from: "background" }); // from the extension, no CORS
});
```

### Calls between the overlay and the page

`wt.onPage` returns a handle to the functions its
handler returns. Call them from the other side with `await`:

```ts
const app = wt.onPage("*://app.example.com/*", () => ({
    flags: () => Object.keys((window as any).__APP_FLAGS__ ?? {}),
}));

wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, async () => {
    const names = await app.flags();   // string[], inferred
    const list = document.body.appendChild(document.createElement("pre"));
    list.textContent = names.join("\n");
});
```

- **Exposing.** A handler that returns a plain object of functions exposes
  them; any other return value exposes nothing. Types follow: `app.flags`
  is `() => Promise<string[]>`, and a wrong argument is a compile error.
- **Calls are async.** Arguments and results are JSON, at most 1 MB each.
  A call made before the other side's handler has returned waits for it.
  A call fails with:
  - `WtTimeoutError` after 10 s without an answer;
  - `WtCallError` when the function threw (its message only), doesn't
    exist, the value isn't JSON or is too big, or the handler isn't
    running on this page (its route didn't match, or it threw);
  - `DisconnectedError` when the other side went away (the overlay
    closed, the script reloaded, the page navigated).
- **Top frame only.** The overlay talks to the script's `onPage` code in
  the top frame.
- **Register at top level.** `wt.onPage` must be called
  at the top level of the script (not inside a function, `if` or loop), so
  both sides number their handlers the same way; Problems flags a call
  elsewhere. Handles from an imported library don't connect.
- **Who can call whom.** The overlay can call any `onPage` code.
  Page-world `onPage` code (`js: "page"`) can only answer: it shares its
  world with the site, which could fake its calls, so `overlay.fn()` there
  rejects with `page-world onPage code can't call the overlay; …`, and
  Problems shows that error with a quick fix (Ctrl+. / ⌘.) that drops
  `js: "page"` — unless its route says `unsafe: true`, accepting that the
  site can call the overlay too
  ([stores in `onPage` code](#stores-in-onpage-code)). Network handlers have no
  tab: their calls reject.

### The isolated world

`onPage` code runs, by default, where the site's JavaScript can't see or
imitate it: same DOM, none of the site's globals (read them with
[`ctx.evaluate`](#reading-the-page--ctxevaluate)). That code can call the
overlay:

```ts
const page = wt.onPage("*://app.example.com/*", () => {
    document.addEventListener("click", (e) => {
        if (e.altKey) overlay.picked((e.target as Element).tagName);   // calls the GUI
    }, true);
    return {
        highlight(sel: string) {
            const els = [...document.querySelectorAll<HTMLElement>(sel)];
            els.forEach((el) => (el.style.outline = "2px solid red"));
            return els.length;
        },
    };
});

const overlay = wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.onchange = async () => (input.title = `${await page.highlight(input.value)} matches`);
    return {
        picked(tag: string) { input.value = tag.toLowerCase(); },
    };
});
```

Isolated code gets `wt.storage`, `wt.log`, `wt.params` and `console`
(lines go to the Log tagged `isolated › host`, as the overlay's are
`overlay › host` and page-world code's `page › host`); `wt.globalStore`
and `wt.pageStore` are live copies, as in the overlay (see
[Stores in `onPage` code](#stores-in-onpage-code)), and `wt.fetch` is the
overlay's.

#### User scripts on Chrome

Firefox and the Chromium MV2 build run isolated code in the extension's
content-script world. The Chrome (MV3) build runs it through Chrome's
user scripts API, which is off until you turn it on:

1. **Grant the permission.** When a script has isolated `onPage` code,
   the Editor shows a banner: click **Grant permission** (the optional
   "user scripts" permission).
2. **Allow user scripts.** Chrome 138 and later: turn on **Allow User
   Scripts** on Wiretrick's details page (`chrome://extensions/?id=…`; the
   banner's **Open extension details** button and the Problems error link
   there). Chrome 120–137: turn on **Developer mode** at the top right of
   `chrome://extensions` instead.

Until then the handler doesn't run, Problems shows an error on its
`wt.onPage` line saying how to turn user scripts on, and the overlay's
calls into it reject with `not running on this page (user scripts are
off)`. Once they're on, pages loaded from then on run it (reload open
ones); after that, saving the script updates open pages in place.

Chrome 133 and later give each script's isolated code a world of its
own; before that, scripts share one user-script world (each still in its
own scope, apart from the site's JavaScript).

### Page-world overlays — `unsafe: true`

`js: "page"` with `dom: "overlay"` draws in an overlay document but runs
in the site's JavaScript world, for a GUI that needs the site's globals
at hand (`window.myApp`) instead of going through
[`ctx.evaluate`](#reading-the-page--ctxevaluate). It's opt-in at your own
risk — without `unsafe: true` the script doesn't compile:

```ts
wt.onPage({ url: "*://app.example.com/*", js: "page", dom: "overlay", unsafe: true }, (ctx) => {
    const app = (window as any).myApp;          // the site's window
    const b = document.body.appendChild(document.createElement("button"));  // the overlay's document
    b.textContent = `user: ${app?.user?.name}`;
});
```

- **What you give up.** The site can see the overlay (its host element is
  in the page, its window is the site's), call into it and tamper with it.
  Like any `unsafe: true` page-world code it has the script's stores
  (which the site can then read and change) and can call the script's
  default overlay, if it has one; nothing calls into it (its handle is
  inert), and there's no `ctx.evaluate`. `ctx.onNavigate` and
  `ctx.shortcut` work.
- **How it runs.** The script evaluates again in the page's world (top
  frame only), with `document` set to the overlay's: a transparent frame in
  a closed shadow root over the page, clicks on its empty areas going
  through. Its top-level variables aren't shared with the script's other
  `js: "page"` handlers.
- **CSP.** Where the page's CSP forbids `eval` it doesn't run, and the Log
  says so. The Editor's Preview tab runs it in its own frame instead.

### Page-world results are page data

Page-world `onPage` code and `ctx.evaluate` run among the site's own scripts, which can
replace `Object.keys`, patch your functions or answer in their place. Its
results are fine to show, but treat them like anything else the site
sends: check them before they decide what your network handlers do (which
URLs to redirect, which headers to set). The isolated world and the
overlay can't be reached by the site.

### Frameworks and CSS

- **React and valtio** are [built in](#built-in-valtio-and-react). A `.tsx`
  script's JSX compiles with the automatic runtime against the built-in React.
- **Another JSX runtime:** a `/** @jsxImportSource <url> */` comment at the
  top switches the file to it, e.g. Preact from unpkg
  (`/** @jsxImportSource https://unpkg.com/preact@10.26.4 */`, with hooks
  from `https://unpkg.com/preact@10.26.4/hooks`). Lit, Solid or plain DOM by
  [package import](#packages-from-unpkg) work too. Pin one version so
  everything shares a single copy.
- **CSS:** a `.css` [package import](#packages-from-unpkg) becomes a
  `<style>` in the overlay; inline styles and `<style>` elements you add
  work as usual.
- **Tailwind 4 + daisyUI:** Tailwind's browser build generates CSS from the
  classes it finds in the overlay's document. Load it with a dynamic
  `import()` inside the handler so it only runs in the overlay:

  ```tsx
  import "https://unpkg.com/daisyui@5.0.43/daisyui.css";
  import { createRoot } from "react-dom/client";
  import { useState } from "react";

  wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, async () => {
      await import("https://unpkg.com/@tailwindcss/browser@4.1.11");
      function Modal() {
          const [open, setOpen] = useState(true);
          return open ? (
              <div className="modal modal-open">
                  <div className="modal-box">
                      <h3 className="text-lg font-bold">Debug tools</h3>
                      <button className="btn" onClick={() => setOpen(false)}>Close</button>
                  </div>
              </div>
          ) : null;
      }
      createRoot(document.body.appendChild(document.createElement("div"))).render(<Modal />);
  });
  ```

### Recipes

- **Edit a handler's setting live:** keep it in a store and bind an input
  to it.

  ```ts
  const redirect = wt.globalStore("redirect", { target: "" });

  wt.onRequest({ url: "*://cdn.example.com/app.js", strategy: "helper" }, () =>
      redirect.target ? { redirect: redirect.target } : undefined);

  wt.onPage({ url: "*://app.example.com/*", dom: "overlay" }, () => {
      const input = document.body.appendChild(document.createElement("input"));
      input.value = redirect.target;
      input.onchange = () => (redirect.target = input.value);   // the next app.js load is redirected
  });
  ```

- **Modal:** a full-viewport backdrop `<div>` (`position: fixed; inset: 0`)
  takes every click until it's closed.
- **Toast:** a fixed element plus `setTimeout` to remove it.
- **Remember open/closed:** a store field (`ui.open`), so it survives
  reloads and is the same in every tab.
- **Per-tab switch:** a `wt.pageStore` field, so turning it on in one tab
  leaves the others alone and a reload turns it off again.

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
wt.onRequest({ url: "*://api.example.com/me", strategy: "helper" }, () => ({
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
| `onPage` | run in the page / overlay on every strategy; not awaited (fire-and-forget) | | | | |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `wt.onResponseBody(API, async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/block or header changes decided asynchronously** on Chromium?
  Use `helper` or `debugger` (both await). Only
  the `extension` strategy on Chromium can't: there an async result logs an error and the
  request proceeds unmodified — set `strategy: "helper"` or `"debugger"` on the
  route.
- **Static replacement from an async source** (file read, fetch): async
  `replaceResponse` on `helper`, `debugger` or `page` is all you need.
