# Changelog

All notable changes to Wiretrick. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's notes on GitHub are
its section below.

## [Unreleased]

### Added

- One `wt.onPage` for all page code, with its isolation set by two route options: `js: "isolated" | "page"` (which JavaScript world it runs in) and `dom: "page" | "overlay"` (whether it changes the site's document or draws the script's own GUI). `wt.onPage({ url, dom: "overlay" }, fn)` is the overlay.
- `js: "page"` with `dom: "overlay"`, opt-in with `unsafe: true`: an overlay GUI whose code runs in the site's JavaScript world (its globals at hand), drawing in its own click-through document over the page. The site can see and tamper with it, so it gets no stores and no calls to or from it; it doesn't run where the page's CSP forbids `eval`. Without `unsafe: true` the script fails to compile.

### Changed

- Welcome sample chips and Network tags say "overlay" ("overlay shown") instead of "onOverlay".

### Deprecated

- `world` (now `js`) and `wt.onOverlay(route, fn)` (now `wt.onPage({ …route, dom: "overlay" }, fn)`). Both still work; the samples and docs use the new forms.

## [0.12.2] - 2026-11-04

### Added

- `ctx.evaluate` callbacks can also sit inside plain objects and arrays (`ctx.evaluate((cb) => …, { onOpen: () => …, onClose: () => … })`); before, passing one threw "arguments must be plain data".
- The diagnostics report includes the Problems view's current problems (errors and warnings per file, with line and column).
- A Problems warning when a `ctx.evaluate` function uses the script's own variables (like `cfg`), which aren't defined in the page world; it points at the variable's use inside the function. At run time the error now names the variable and says to pass it as an argument.

### Fixed

- In `.tsx` scripts, JSX like `<A x={y} />` could hide later onPage handlers from the Problems view's onPage checks, and wrongly flag the next top-level `wt.onPage` with "call wt.onPage() at the top level" (`/>` was read as the start of a regex).

## [0.12.1] - 2026-11-04

### Added

- `ctx.evaluate` callbacks: a function passed as an argument is a callback the page-world `fn` can call — also later, from the site's own events — to run code back in isolated code, where stores and the overlay are. E.g. `ctx.evaluate((set) => app.on("login", (u) => set(u.name)), (name) => { state.user = name; })`.

### Fixed

- The built-in `react`, `react-dom` and `valtio` threw "aren't available in page code" in `onPage` code, which now runs in the isolated world by default: they work there now (React loads on first use). `world: "page"` code still can't use them, and its error says so.

## [0.12.0] - 2026-11-04

### Added

- `.tsx` scripts: a script whose name ends in `.tsx` (`ui/Panel.tsx`) is a `.tsx` file everywhere — explorer (⚛ icon), tabs, the synced folder and imports (`./Panel` finds it). Create or rename a script with the `.tsx` extension; renaming keeps the extension unselected. JSX in a `.ts` script is now an error with a **Rename to Name.tsx** quick fix.

- `ctx.evaluate(fn, ...args)` in `onPage` code: runs `fn` in the page's own JavaScript world and resolves with its (awaited) result, so isolated code can read the site's globals. `fn` can't use the script's variables (pass them as arguments); arguments and result are plain data, and the result is page data the site could fake.

- `.svg` data files: `import logo from "./icons/logo.svg"` gives the SVG's markup as a string (typed `string`, in the Editor and the synced folder). Create one by typing `.svg` in New JSON File…, or put `.svg` files in the synced folder; they open as XML.

### Changed

- **`onPage` code runs in the isolated world by default** (same DOM, none of the site's JavaScript), so it can use `wt.globalStore`/`wt.pageStore` and call the overlay. Code that needs the site's globals or the `page` strategy to see its `fetch` uses `world: "page"` — the new name of `world: "main"`, which still works — or `ctx.evaluate`. On Chrome (MV3) default-world code needs user scripts turned on (the Editor's banner says how); `world: "page"` code doesn't. `wt.onDocument` follows the same default.

- Scripts saved with JSX are renamed once to `Name.tsx` (their `settings.yaml` section follows, also in the synced folder), since TypeScript parses JSX only in `.tsx` files.

### Fixed

- In the synced folder, VS Code and `tsc` couldn't find `valtio`, `react` or `react-dom` ("Cannot find module"): their typings are now written to `.wiretrick/types/builtin/` and mapped in the generated `tsconfig.json`, which also covers `.tsx` files and no longer sets an option `tsc` rejects.

- A script renamed while its synced folder wasn't connected came back as a duplicate (the old file re-imported) on reconnect; its file is now moved instead.

## [0.11.1] - 2026-11-04

### Added

- `wt.globalStore` and `wt.pageStore` in isolated-world `onPage` code (`world: "isolated"`): live copies like the overlay's — synchronous reads, writes that reach the background, the overlay and (global stores) other tabs, `wt.pageStore` being the copy of the code's page.

- Problems view warnings for a main-world `onPage` handler that uses a store or an `onOverlay` handle (both disallowed there: the page could read and forge them), with a quick fix that moves the handler to `world: "isolated"`. In main-world code the stores' error now says to use the isolated world.

## [0.11.0] - 2026-11-04

### Changed

- The bottom panel in a narrow window: the view's filter moves to its own row below the tabs (panel narrower than 720 px), and the Problems / Log / Network / Preview tabs become icons (narrower than 520 px; the name is in the tooltip).

- **Breaking:** `wt.store` is now `wt.globalStore` (same behavior); calling `wt.store` throws with the new name.

### Added

- `wt.pageStore(name, initial)`: a store with one copy per page — a navigation or reload starts it over, a single-page app's route change doesn't, and other tabs have their own. A network handler sees the copy of its request's page (until its first `await`) and an overlay its own page's, so a switch in the overlay can change what the handlers do for that tab only. Not available in `onPage` code or `rules` handlers.

- Network: a page's document request names the scripts whose `onPage` ran or whose `onOverlay` was shown on it, and the overlay's fetches name their script (both as observed).

### Fixed

- Chrome: an overlay's calls into isolated-world `onPage` code, and back, are matched to the overlay's own document, so a call made while the tab navigates can't reach the next page.
- `strategy: "page"` handlers now see a page's first requests too: the `fetch`/`XHR` calls its inline scripts make while it loads used to go out before the hook knew the page's handlers. They now wait for that (at most 3 s); pages with no page-strategy handlers get their native `fetch`/`XHR` back untouched. Chrome MV2 injects the hook inline so it runs before the page's own scripts (strict-CSP pages too).
- Chrome MV3: after turning on "Allow User Scripts" on chrome://extensions, coming back to the Editor clears the "user scripts are off" banner and Problems error and registers the isolated `onPage` code right away (it used to wait for the next script change).

## [0.10.0] - 2026-11-03

### Added

- `wt.onOverlay(route, fn)` gives a script its own GUI on a page: `fn` runs in a transparent frame over the tab (top frame, one per script), so the page's CSS and JavaScript can't reach it and clicks on its empty areas go through to the page. It shares the script's `wt.store`s with the network handlers, so a switch in the GUI can turn a mock on or off live. Its `fetch` (and `wt.fetch`, `from: "page"`) fetches as the page, with its cookies. `ctx.onNavigate(fn)` follows single-page-app navigations. Saving the script reloads its overlay; disabling it removes it.
- The Editor's bottom panel has a **Preview** tab (⌥⇧V): the open script's overlay, live, in a frame in the Editor, reloaded on every save. Its stores are the real ones, so a switch in the preview turns a mock on or off in your tabs. A URL field sets the overlay's `ctx.url` (it starts from the script's route); with no page behind it, the overlay's `fetch` goes from the extension background (a badge says so), and calls into `onPage` code reject.
- `ctx.shortcut(keys, fn)` in an overlay: a keyboard shortcut on the page (`"Alt+Shift+H"`, `"Mod+K"` — ⌘ on macOS, Ctrl elsewhere) that beats the page's own, or runs only if the page didn't handle the key with `{ priority: "after-page" }`. It works while the overlay has focus too, leaves text fields alone, and ignores key events the page makes up. Two scripts with the same keys: the one higher in the list keeps them, with a Log warning.
- `wt.onPage` and `wt.onOverlay` return the functions their handler returns, to call from the other side: `const page = wt.onPage(route, () => ({ count: (sel: string) => … }))`, then `await page.count("a")` in the overlay, typed. Calls are async, JSON (≤ 1 MB), and time out after 10 s. Isolated-world `onPage` code can call the overlay too (`overlay.picked(tag)`); main-world code can only answer.
- Scripts can use JSX (`.tsx`): it compiles against the built-in React, or another runtime with `/** @jsxImportSource <url> */`. A `.css` package import becomes a `<style>` in the script's overlay (e.g. daisyUI; Tailwind 4's browser build works via `import()`).
- `wt.onPage` and `wt.onOverlay` must be called at the top level of a script; Problems flags them elsewhere.
- An import from an unpinned unpkg URL (`import { sleep } from "https://unpkg.com/asyncbox"`, or `@latest`, `@^1`) is now underlined in the Editor as you type, before saving, with a **Pin to asyncbox@6.5.0** quick fix (Ctrl+. / ⌘.) that fills in the version unpkg resolves it to. After saving, the error points at the URL rather than the start of the line, and the Problems view lists it once.
- `wt.onPage({ url, world: "isolated" }, fn)` runs page code in the extension's isolated world: same DOM, none of the site's JavaScript, and the site can't see or tamper with it. On Chrome it runs through Chrome's user scripts API, which needs the optional "user scripts" permission (the Editor shows a banner with a **Grant permission** button) and **Allow User Scripts** on Wiretrick's details page (Developer mode before Chrome 138). Until then, Problems shows an error saying how to turn them on, and the overlay's calls into that code reject with `not running on this page (user scripts are off)`.
- Log lines and runtime errors from script code that runs on a page say where it ran: `overlay › host`, `isolated › host` or `page › host`. A main-world `overlay.fn()` call shows in Problems with a quick fix that moves the handler to `world: "isolated"`.
- `wt.store(name, initial)`: a live object shared by every copy of a script — its handlers on every strategy see the same values — kept across browser restarts (`{ persist: false }` or a list of fields to keep less). It's a valtio proxy; values are JSON, up to 1 MB per store. A `rules` handler that reads a store is re-run when the store changes.
- `wt.fetch(url, init)`: `fetch` from the extension background (host permissions, no CORS, the browser's cookies), returning a normal `Response`; in an overlay it fetches as the page. `{ bypass: true }` keeps every script's handlers off that request, e.g. to get the real response a script mocks; the Log shows it as a bypass.
- `valtio` and React 19 (`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) are built in: scripts import them by name or by an `https://esm.sh/` URL, with no download. They load only in scripts that import them.
- A welcome page for first-time users: with no scripts yet, the Editor opens on a gallery of the samples. **Try it** adds one (turned on), waits until it's running and opens its page in a new tab with the change already visible; **Open** just adds it. Reopen it from Help (**?**) → **Welcome**.
- Two new samples (Help → Samples and the welcome page): **Overlay panel (React + wt.store)** — a React panel over dummyjson.com that turns a `page` mock on and off through a shared `wt.store` and asks `onPage` code to fetch through it; **Overlay outline (calls + shortcut)** — a floating outline of a Wikipedia article that gets the headings from `onPage` code, scrolls the page on click and hides with Alt+Shift+O. Samples are now type-checked in the tests.
- Help → Reference covers `wt.onPage` (with `world`), `wt.onOverlay` (`ctx.onNavigate`, `ctx.shortcut`, React), calls between the overlay and the page, and `wt.store` / `wt.fetch`.
- The popup marks the scripts behind the toolbar badge number with a green dot, and its header says how many are active on the current tab (enabled, and matched the page or one of its requests since it loaded). It updates while the popup is open.
- The toolbar icon shows when script changes are being applied: from saving (compiling) until every strategy has reloaded and open tabs got the hot-reload, it fades with a spinning arc in the corner and its tooltip says "applying script changes…". Changes that finish within 150 ms don't show it.

### Changed

- **Breaking:** there is no default strategy any more. Every network handler names its own: `wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, fn)` (the same for `onResponseHeaders`, `replaceResponse` and `onResponseBody`). A bare URL pattern (`wt.onRequest("*://example.com/*", fn)`) or a route without `strategy` now stops the script from loading, with the error shown in Problems at that line. Existing scripts are not rewritten: add `strategy` to their routes. `onDocument` is unchanged and still takes a bare pattern.
- The `defaultStrategy` setting is gone. The update removes it (and its comment block) from `settings.yaml`; if it's typed back in, the editor flags it as having no effect. Settings no longer has a **Strategies** section: each strategy's pros and cons, and which ones this browser can't run, are now a table in Help (**?**) → Reference → *Strategies*, under the strategy docs.
- The bundled samples (Help → Samples) no longer need the local helper. Redirect, block, request headers, CORS and parameters use `rules` (no banner, Chrome and Firefox). The fetch/XHR replace and transform samples use `page` and show their result in a box on dummyjson.com. Storage now counts Wikipedia visits from `onDocument`. Only **Rewrite page HTML** and **Serve a local file**, which must change the page itself, use `debugger` on Chrome (with its banner) and `extension` on Firefox. Adding a sample now turns it on and gives it a unique name ("Redirect a URL 2") if one is taken.

- `wt.onDocument` is renamed `wt.onPage`. The old name keeps working, unchanged; the editor marks it deprecated.
- The samples, the docs, Help → Reference and the editor's hover docs use `wt.onPage`; `wt.onDocument` is no longer documented beyond its deprecation note.
- The page can no longer read or write a script's `wt.storage` unless that script's `onPage` code runs in the page.
- The extension's pages are now built with React and Valtio: the popup and the Network view (before: Preact) and the whole Editor (before: hand-written DOM code), from its page layout, explorer tree, toolbar, panel and status bar to its dialogs. They look and behave the same; the extension's download is larger.

### Fixed

- Settings → Logging → **Default level** showed "Debug+" until a level had been chosen, though the Log panel showed Info+ (the actual default).
- `wt.storage.get` in an `onDocument` handler returned `{ value }` instead of the stored value (unless the page's CSP had moved the handler to the isolated world).

## [0.9.18] - 2026-10-31

### Added

- Network: Copy → **Copy as HAR** (**Copy all as HAR** with several rows selected) puts a HAR 1.2 log on the clipboard: headers, cookies, query string, timings, server IP, and the request/response bodies as recorded (a comment marks bodies that were cut or not captured). Opens in devtools' Network panel or any HAR viewer.
- WebSocket warnings: a redirect or `replaceResponse` aimed at a WebSocket (`ws:`/`wss:`) now logs a clear warning that it isn't applied (Chrome ignores redirects on WebSocket handshakes, so the socket still connects to the original URL), instead of an "info: redirect" that looked like it worked. `debugger`/`page` routes that match a WebSocket warn that they never see it, and routes aimed only at WebSockets with `replaceResponse`/`onResponseBody` show up in Problems. Only block and request-header changes work on a WebSocket ([details](docs/strategies.md)).

### Fixed

- Network: ↑/↓, PageUp/PageDown and Home/End did nothing in the request table. They now move the selection (Shift extends it) and scroll it into view; an open details pane follows the selected request, and Enter opens it.
- The toolbar badge kept counting scripts after they were disabled (or deleted), and never reset when the tab moved to another site. It now drops them right away and starts over on each page load. On Chrome (MV3) it also counts scripts that match only the page's requests (an API host, a CDN) rather than the page URL, as it already did on MV2/Firefox.
- Moving or deleting scripts didn't re-check the scripts importing them, so a now-broken `import "./lib/util"` showed no error until that file was edited. After a move or delete, the moved scripts and everything importing them (directly or through other scripts, at the old path or the new one) are type-checked again.

### Changed

- Log and Network share the panel header's actions, in the same place on both: **Clear** empties the Log and the Network recording together (also ⌥⇧K), and **Download diagnostics** saves the diagnostics report. The Log's separate debug-log download is gone (the report includes the debug log), as is the Network view's own Clear.
- Network view: each request/response body is now kept up to 2 MB by default (was 256 kB). `bodyCap:` / Settings → Network → Body capture still changes it.

## [0.9.17] - 2026-10-26

### Added

- URIs in the Log are clickable, any scheme: `https:`, `chrome:`, `file:`, `data:`… open in a new tab (⌘/Ctrl- or middle-click: in the background); `vscode:`, `mailto:` and other app schemes open their app. Punctuation right after a URI isn't taken into it. A link wrapped over several lines stays hovered across the gaps between them.
- Network: select several requests (Shift-click, Ctrl/⌘-click, Ctrl/⌘+A) and right-click them for Open in new tab and Copy → Copy URL / Copy as cURL / Copy as fetch, devtools-style (all selected at once). Ctrl/⌘+C copies the selected URLs. The full-URL tooltip on rows is gone (Copy URL replaces it).
- Log filter bar like Network's: Basic chips or an Advanced query with autocomplete and **?** help, over `message` (bare words, `"phrases"`, `/regex/`), `source`, `level` (`level:>=warn`) and `is:observed` / `is:link`. It replaces the Log's text and source boxes; the level menu stays.
- Filter bars (Network and Log): Ctrl+Space in Basic shows suggestions for the word at the caret, or opens the + Filter field list there. The + Filter field list works from the keyboard: ↑/↓ (or a letter) to move, Enter or Tab to pick, Esc back to the filter box.
- Network: a **Copy** button on the Payload and Response bodies (copies the body as shown, JSON pretty-printed).
- Settings → Network → Body capture (`bodyCap:` in `settings.yaml`, kB): how much of each request/response body the Network view keeps, 16–16384 kB (default 256). A cut body's notice points there.
- Log scroll lock, as in VS Code: a 🔒 button in the Log toolbar stops new lines from scrolling the view until clicked again. Scrolling up also pauses auto-scrolling (the button shows it), and scrolling back to the end resumes it.

### Fixed

- Settings → Strategy scrolled sideways on Chrome MV3: the unavailable `extension` option in the picker spelled out its whole reason, stretching it past the pane.

### Changed

- Settings → Strategy: the pros/cons table is the picker now (click a row, or its radio button) instead of a separate dropdown above it listing the same strategies. Unavailable ones are greyed out with the reason.
- Settings → Synced folder → Folder path says how to copy a folder's path on your OS (the browser's folder picker can't reveal it), shows an example path for it, and cleans up what's pasted: the quotes Windows' Copy as path adds, a `file://` URI, a trailing slash.
- After you pick a synced folder, Settings → Folder path flashes and shows a ⚠ while the path is empty or doesn't end in that folder's name (likely another folder's). Pressing the ↗ button without a path takes you there too.

## [0.9.16] - 2026-10-25

### Changed

- `onResponseBody` handlers may return nothing (`void` / `undefined` / `null`) to leave the body as it is — now in the typings too, like every other handler. Any body returned counts as modified, even the one the handler received: bodies are no longer compared, so `(ctx, body) => body` re-encodes and serves the body (use a handler that returns nothing to only read it).

## [0.9.15] - 2026-10-25

### Fixed

- A binary body served with a text `Content-Type` (x.com's `jf.x.com/onboarding/web/landing` is `text/plain`) was decoded as UTF-8 and re-encoded, corrupting it even when the handler returned it unchanged; x.com stopped loading under an `onResponseBody` on `*`. A text body that isn't valid UTF-8 is now binary (`binary: true` routes only), and a body handed back unchanged keeps its original bytes on every strategy.
- Picking a field suggestion (e.g. `script:`) with Tab opened the "+ Filter" popup at the far right of the filter bar; it now opens under the word it came from.

## [0.9.14] - 2026-10-25

### Added

- Package imports: a script can import an npm package by its pinned unpkg.com URL, e.g. `import dayjs from "https://unpkg.com/dayjs@1.11.13"`. Saving downloads the package and its dependencies once and stores them, so scripts also run offline, on every strategy and in `wt.onDocument`. Its TypeScript declarations (or `@types`) type-check the import in the Code view and, through `.wiretrick/types/` and `tsconfig.json` `paths`, in the synced folder. Unpinned versions and other hosts are compile errors. See [Packages from unpkg](docs/scripting.md#packages-from-unpkg).

## [0.9.13] - 2026-10-25

### Added

- `ctx.requestBody` and `ctx.json()`: every handler can read the request payload (read-only), as a string or a `Uint8Array` decided by `Content-Type` and `textTypes` like response bodies. Works on `page`, `debugger`, `helper` (helper 0.4.1+, bodies up to 8 MB) and `extension`; not on `rules`. See [Request body](docs/scripting.md#request-body).

### Changed

- An `onRequest` result is now exactly one of `replaceResponse`, `redirect`, `block` or `headers`. Returning several is a type error in the editor. At runtime only the first in that order applies, the same on every strategy, and a warning names what was ignored. Previously `headers` were silently dropped next to a `redirect` on most strategies but applied on `extension`. To change a redirected request's headers, add an `onRequest` handler for the target URL.

### Fixed

- Scripts saved under an older version kept that version's parsed routes until edited (e.g. `binary: false` stayed "unset" and still warned). Stored script meta is now recompiled once after every extension update.
- The "body is binary" warning no longer tells you to add `binary: true` when the script already has such a route. It names that route and says what dropped the body — usually an outdated helper (reinstall it).

## [0.9.12] - 2026-10-24

### Added

- `binary: "both"` on an `onResponseBody` route: the handler gets text
  bodies as a string and binary ones as a `Uint8Array`.
- `binary: false` keeps a handler text-only and silences the "the body is
  binary" warning for it; the warning now mentions this.

### Changed

- `binary: true` now means binary bodies **only** — text bodies skip the
  handler. Use `binary: "both"` for the old behavior.
- The local helper is now v0.4.0 and the extension requires it: helpers
  from before v0.9.11 don't know about binary routes or
  `settings.textTypes` (they still treated HLS playlists as binary), so
  the extension now asks you to reinstall.

### Fixed

- Two requests to the same URL (e.g. a playlist fetched twice, once from
  the browser cache) now each show their own script results in the Network
  view and their own "onResponseBody never ran" reason. Before, both
  landed on the latest row and shared one reason — e.g. "the body is
  binary" for a request that never reached the helper.

## [0.9.11] - 2026-10-24

### Added

- `onResponseBody` can tap binary bodies (images, video, fonts, wasm,
  PDFs…): add `binary: true` to the route and the handler also gets binary
  bodies as a `Uint8Array` (and may return new bytes). Handlers without it
  still get text bodies only. Works on every strategy that sees bodies —
  `helper`, `debugger`, `page` (fetch only) and Firefox `extension` — and
  on the MV3 build, which used to pass text bodies only. Buffering a large
  binary body holds the response until handlers finish; see
  [Binary bodies](docs/scripting.md#binary-bodies) for the limitations.
- `textTypes:` in `settings.yaml` sets which Content-Types are text (globs,
  `*` = anything; replaces the defaults). Every strategy now uses this one
  list, so a body is text or binary the same way everywhere.

### Fixed

- Text `application/vnd.*` responses are no longer treated as binary:
  `+json` / `+xml` types (e.g. `application/vnd.api+json`) and HLS playlists
  (`application/vnd.apple.mpegurl`, `.m3u8`) now reach `onResponseBody` on
  every strategy. Needs the updated helper.
- "onResponseBody never ran" now says when `debugger`, `page` or
  `extension` skipped a binary body, and how to get it (`binary: true` or
  `settings.textTypes`).

## [0.9.10] - 2026-10-24

### Changed

- "onResponseBody never ran" and "→ skipped" warnings are no longer rate
  limited (once a minute per script + URL, 20 a minute overall): every
  request gets its own Log line and *missed* entry on its Network row, in
  every tab. Before, a burst like a video's segments stopped being flagged
  after the first 20.

## [0.9.9] - 2026-10-24

### Fixed

- "onResponseBody never ran" on the helper strategy said "no strategy
  observed it" for bodies the helper skips on purpose (e.g. YouTube's
  `/videoplayback` video, `.wasm`). It now says why — a binary body (with
  its Content-Type), one over 64 MB, or a stream — and no longer warns for
  responses without a body (204, 304, HEAD).
- Network filter (Basic), + Filter on a text field with suggestions (tab,
  script…): ↑/↓ now move through the suggestion list instead of switching
  the operator; Alt+↑/↓ switches the operator (plain ↑/↓ still does when
  there's no list, as on url).

### Added

- Shortcuts for the bottom panel: ⌥⇧P / ⌥⇧L / ⌥⇧N (Alt+Shift+P/L/N) show
  Problems, Log or Network and focus its filter (again: close the panel);
  ⌥⇧K clears the Log or Network view shown. Alt+Shift letters avoid the
  Chrome, Firefox and OS shortcuts. ⌘⇧M now focuses the Problems filter too.
- Settings → About: a Help… button opens the API reference, samples and
  shortcuts (the same as the ? in the editor toolbar).

## [0.9.8] - 2026-10-24

### Added

- Network filter (Basic): `OR ` / `AND ` typed between capsules set the
  connector there; Backspace turns an OR back into AND.
- Network filter: status suggestions say what each code means (404 Not
  Found) and name the classes (2xx Success, 4xx Client error, 5xx Server
  error) instead of "range".

### Changed

- Network filter: suggestions open under the word being completed instead
  of spanning the whole box.
- Panel: the Problems, Log and Network filters sit in the same slim spot in
  the panel header, next to the tabs (Network no longer has a filter bar of
  its own); clear and Network's collect diagnostics are icons after them.
  When the panel is narrow the filters move to a row of their own.
- Network filter: Basic/Advanced is a single `{ }` toggle inside the filter
  box.

### Fixed

- Missed warning: a `helper` handler matching a localhost URL (e.g. after
  redirecting to a local dev server) now says the helper can't see
  loopback requests — Chrome never proxies them — and suggests `page` or
  `debugger`, instead of "no strategy observed it".
- Log: redirect lines read from → to (`onRequest → redirect <url> →
  <target>`) instead of putting the target before the request's URL.
- Network filter (Basic): Shift+←/→ with the caret between capsules,
  Shift+click, and dragging from the text onto capsules now select them.

## [0.9.7] - 2026-10-24

### Added

- A problem that says where to fix it ("Settings → Local helper") links
  there, in the Problems view and the editor hover.
- Network filter (Basic): typing `OR ` or `AND ` turns into a connector
  capsule, `(` / `-(` opens a group (NOT group) that the next filters go
  into, and `)` closes it. Backspace takes them back one at a time.
- Network filter (Basic): Enter, Space or a double-click on a capsule
  turns it back into text you edit in place. ←/→ stop on either side of
  each capsule, so you can type a filter before or between them, or
  Backspace/Delete the capsule next to the caret.
- Network filter (Basic): `(` and `)` can be typed anywhere among the
  capsules — open a group before one capsule, move to another and close
  it (or type `)` first, then `(`). Backspace/Delete next to a parenthesis
  removes just that one, so it can be moved.

### Changed

- Network: the type toggles, the script and tab dropdowns and the
  script-activity menu are gone — the filter bar does it all (`type:`,
  `script:`, `tab:`, `is:observed` / `is:modified`). It starts with an
  `is:touched` chip, so by default you still see what scripts touched.
- Network filter (Basic): ↑/↓ put the highlighted suggestion in the text
  box, in the filter box and in **+ Filter**; Esc puts back what you typed.
- **+ Filter**: on text fields (url, host, path, …) ↑/↓ switch the operator
  (contains, is, matches…); Tab adds the filter, like **Add**.

### Fixed

- **+ Filter**: **Add** ignored a value picked with ↑/↓.

## [0.9.6] - 2026-10-24

### Added

- Network filter: Ctrl+Z / Ctrl+Shift+Z undo and redo Basic filter changes,
  chips included.
- **+ Filter**: ↑/↓ move through the value suggestions from the text box,
  and Enter picks the highlighted one.
- Adding a filter puts the focus back in the filter text box.

### Changed

- Release notes are the version's CHANGELOG.md section, with install steps
  in [docs/install.md](docs/install.md).

## [0.9.5] - 2026-10-24

### Changed

- **Predictable handler precedence, the same on every strategy.** A request
  goes through `onRequest → replaceResponse → (network) → onResponseHeaders →
  onResponseBody`, and each stage runs every script's handlers in list order
  before the next one starts. See
  [how handlers stack](docs/scripting.md#multiple-handlers--how-they-stack).
- A final result (block, redirect, replacement) ends the request: no later
  handler or stage runs, and a replaced response never reaches the network.
- Header edits (`onRequest` `headers`, `onResponseHeaders`): for each header
  the handler later in the list wins, whether it sets or removes it.
- `debugger`: `replaceResponse` is served before the request goes out (the
  server is never contacted) and no longer runs `onResponseHeaders` or
  `onResponseBody`.
- `extension`: every script's `onRequest` runs before any `replaceResponse`.
  On Firefox, an async result no longer stops the later scripts, and a
  replacement no longer runs `onResponseHeaders`.
- `page`: `fetch` now honors `onRequest` block, redirect and header changes.
  XHR no longer runs `replaceResponse` before `onRequest`, and no longer
  transforms a body twice.

### Added

- A warning when a matching handler is skipped because another took
  priority, naming both handlers and the reason (Network: `is:missed`).
- A warning when a header edit is overridden by a later handler.
- Network filter: autocomplete in Basic mode, AND/OR groups that round-trip
  with Advanced mode, and chips that select like text.

## [0.9.4] - 2026-10-24

### Added

- Network view: a Basic/Advanced filter bar with a query syntax,
  autocomplete and help.

## [0.9.3] - 2026-10-23

### Added

- Open button: a custom editor URL (with `{path}` and `{line}`) next to
  VS Code and VS Code Insiders.

## [0.9.2] - 2026-10-23

### Added

- A warning when a `page`-strategy request runs in a tab that has no page
  hook (reload the tab).

## [0.9.1] - 2026-10-23

### Added

- Explorer: select several files to move or delete them together.

### Changed

- Rename keeps the `.ts` extension visible but unselected.
- The status bar shows the Problems, Log and Network counts; the bottom
  panel tabs no longer have badges.

## [0.9.0] - 2026-10-23

### Added

- Folders: a VS Code-like explorer tree, synced recursively with the
  scripts folder.
- JSON data files: edit them in the Editor and `import` them from scripts.
- Network view: filter by script (the Wiretrick column).
- A collect-diagnostics button in the panel header while the Network view
  is open.
- The Log explains why `onResponseBody` made no change when it returns the
  body it received.

### Changed

- Releases are published right away; the signed Firefox `.xpi` is added
  when Mozilla finishes signing it.

## [0.8.3] - 2026-10-23

### Changed

- Problems show in the editor as markers: their hover comes before the API
  docs, and F8 reaches them.

## [0.8.2] - 2026-10-23

### Added

- Problems view: live errors and warnings per script that clear once fixed,
  each pointing at a line, with squiggles in the editor. `rules` and route
  problems point at the URL pattern.

### Fixed

- Chromium MV2: dropped the MAIN-world hook entry it rejects.
- Folder sync no longer echoes a received change back as sending.

## [0.8.1] - 2026-10-22

### Changed

- Network counts are live before the view opens; Touched is the default
  filter; the panel has a close button.
- Folder sync badge: a solid triangle that moves in its direction.

### Fixed

- No native tooltip stacks on top of Wiretrick's tooltips.

## [0.8.0] - 2026-10-22

### Changed

- Renamed the `extension` strategy, `wt.onDocument` and the
  `replaceResponse` result; `manager.html` is now `editor.html`.
- Dropped the `DOMContentLoaded` `when` option: `document_end` is the
  default.
- A save with a compile error still sets the baseline.

### Added

- Tooltips you can hover, which copy on click.
- `rules`: smaller regexes, and a too-complex error that shows the regex,
  its size and the limit.

## [0.7.0] - 2026-10-22

### Added

- The `rules` strategy: browser-native declarativeNetRequest rules.
- `wt.isChrome`, `wt.isFirefox`, `wt.isMV2` and `wt.isMV3` to pick a
  strategy per browser.

### Changed

- Panel counts stay until the Log or Network view is cleared.

## [0.6.0] - 2026-10-22

### Added

- Editor: API types in hovers are links that drill into the same hover,
  a read-only `wt-api.d.ts`, and Go Back/Forward.
- Params: an optional `parse` function on every param definition.
- Save button shows the save state; a folder sync status button.

### Fixed

- Quick saves and slow-drive echoes no longer cause conflicts; the
  conflict dialog takes focus and has key shortcuts.

## [0.5.0] - 2026-10-22

### Changed

- Renamed the script API (strategies, `wt.about`, `onResponseBody`,
  `block`, `resourceTypes`, `defaultStrategy`) and UI terms (Editor,
  Observed, Touched, Library, Synced folder…), with a one-time migration.
- Clearing the Log also drops its replay history.

### Added

- Imported param definitions compile; library params are editable in the
  popup.
- Folder sync refreshes typings, `tsconfig` and the schema on every start.

## [0.4.0] - 2026-10-22

### Changed

- Simpler script API: routes per handler, a single strategy, params.
- Removed deprecated APIs and legacy migrations.

### Added

- A VS Code-style status bar with unseen Log/Network counts.
- Network keeps script-touched requests while the view isn't open.
- Help dialog: type-to-search in Reference and Samples.

## [0.3.9] - 2026-10-21

### Added

- Network view: Tapped/Modified markers, a filter menu, a "never ran"
  warning, and in-place replacements.
- About: checks for the latest release.

### Fixed

- `extension` strategy header changes (`extraHeaders`), and the final
  headers shown in Network.

## [0.3.8] - 2026-10-21

### Changed

- Scripts match URLs with URLPattern.
- Ship only the Monaco files the editor loads.

## [0.3.7] - 2026-10-21

### Added

- A VS Code-like Editor, diagnostics, a Shortcuts tab in the help dialog;
  Ctrl+` toggles the bottom panel.

## [0.3.6] - 2026-10-21

### Fixed

- MV2 popup params resolve imports.

## [0.3.5] - 2026-10-21

### Fixed

- Folder sync: the background is the single writer, and scripts saved
  outside the Editor are written to the folder.
- `tsWorker.js` stays under AMO's 5 MB file limit.

## [0.3.4] - 2026-10-20

### Fixed

- Release: whitespace in the AMO keys.

## [0.3.3] - 2026-10-20

Release-only rebuild.

## [0.3.2] - 2026-10-20

### Added

- A Firefox `.xpi` (signed by Mozilla when the keys are set);
  `wiretrick-mv2-*` release names.

## [0.3.1] - 2026-10-20

### Added

- A new icon, with a 32 px size for HiDPI toolbars.

## [0.3.0] - 2026-10-20

### Added

- Settings → Appearance: system, dark or light theme.
- Partial import/export with a checklist of scripts and settings.
- `settings.yaml`: diagnostics, completion and hover, a generated schema,
  and whole-file folder sync.
- VS Code-style completion details, parameter hints and hovers.

## [0.2.0] - 2026-10-20

### Added

- The script list docks to either edge; inline rename.
- `debugger`: a first page load that slipped past is re-issued through the
  debugger (MV3).
- Detects a helper older than the extension needs.

### Changed

- A script's name is its file name.

## [0.1.0] - 2026-10-20

### Added

- Network view, a Preact popup, and script error indicators; Editor
  TypeScript errors show as errors.

### Changed

- The script API is `wt.*` (was `res.*`).

## [0.0.1] - 2026-10-19

First release of Wiretrick, a TypeScript rewrite of Resource Override:
scripts with typed handlers, interception strategies, a local helper,
two-way folder sync, and signed MV2/MV3 packages.

[Unreleased]: https://github.com/nimatrueway/wiretrick/compare/v0.12.2...HEAD
[0.12.2]: https://github.com/nimatrueway/wiretrick/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/nimatrueway/wiretrick/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/nimatrueway/wiretrick/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/nimatrueway/wiretrick/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/nimatrueway/wiretrick/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/nimatrueway/wiretrick/compare/v0.9.18...v0.10.0
[0.9.18]: https://github.com/nimatrueway/wiretrick/compare/v0.9.17...v0.9.18
[0.9.17]: https://github.com/nimatrueway/wiretrick/compare/v0.9.16...v0.9.17
[0.9.16]: https://github.com/nimatrueway/wiretrick/compare/v0.9.15...v0.9.16
[0.9.15]: https://github.com/nimatrueway/wiretrick/compare/v0.9.14...v0.9.15
[0.9.14]: https://github.com/nimatrueway/wiretrick/compare/v0.9.13...v0.9.14
[0.9.13]: https://github.com/nimatrueway/wiretrick/compare/v0.9.12...v0.9.13
[0.9.12]: https://github.com/nimatrueway/wiretrick/compare/v0.9.11...v0.9.12
[0.9.11]: https://github.com/nimatrueway/wiretrick/compare/v0.9.10...v0.9.11
[0.9.10]: https://github.com/nimatrueway/wiretrick/compare/v0.9.9...v0.9.10
[0.9.9]: https://github.com/nimatrueway/wiretrick/compare/v0.9.8...v0.9.9
[0.9.8]: https://github.com/nimatrueway/wiretrick/compare/v0.9.7...v0.9.8
[0.9.7]: https://github.com/nimatrueway/wiretrick/compare/v0.9.6...v0.9.7
[0.9.6]: https://github.com/nimatrueway/wiretrick/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/nimatrueway/wiretrick/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/nimatrueway/wiretrick/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/nimatrueway/wiretrick/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/nimatrueway/wiretrick/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/nimatrueway/wiretrick/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/nimatrueway/wiretrick/compare/v0.8.3...v0.9.0
[0.8.3]: https://github.com/nimatrueway/wiretrick/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/nimatrueway/wiretrick/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/nimatrueway/wiretrick/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/nimatrueway/wiretrick/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/nimatrueway/wiretrick/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/nimatrueway/wiretrick/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nimatrueway/wiretrick/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nimatrueway/wiretrick/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/nimatrueway/wiretrick/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/nimatrueway/wiretrick/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/nimatrueway/wiretrick/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/nimatrueway/wiretrick/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/nimatrueway/wiretrick/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/nimatrueway/wiretrick/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/nimatrueway/wiretrick/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/nimatrueway/wiretrick/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nimatrueway/wiretrick/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nimatrueway/wiretrick/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nimatrueway/wiretrick/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nimatrueway/wiretrick/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/nimatrueway/wiretrick/releases/tag/v0.0.1
