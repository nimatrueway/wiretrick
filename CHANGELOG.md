# Changelog

All notable changes to Wiretrick. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's notes on GitHub are
its section below.

## [Unreleased]

### Changed

- Network filter (Basic): ↑/↓ put the highlighted suggestion in the text
  box, in the filter box and in **+ Filter**; Esc puts back what you typed.

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

[Unreleased]: https://github.com/nimatrueway/wiretrick/compare/v0.9.6...HEAD
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
