# Changelog

All notable changes to Wiretrick. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's notes on GitHub are
its section below.

## [Unreleased]

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

[Unreleased]: https://github.com/nimatrueway/wiretrick/compare/v0.9.16...HEAD
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
