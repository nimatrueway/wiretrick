# The Editor

[← README](../README.md) · [Glossary](../GLOSSARY.md)

The Editor is Wiretrick's full-page UI. Its **Code view** embeds **Monaco** (the VS Code editor) with full TypeScript
IntelliSense for the `wt` API — completions, hover docs, and diagnostics work
out of the box. Shortcuts follow VS Code (⌘ = Ctrl on Windows/Linux; F1
lists the Code view commands, and the **?** dialog's **Shortcuts** tab has a
searchable list of all of them):

| Shortcut | Action |
| --- | --- |
| ⌘S | Save and hot apply the script (or save the data file) |
| ⌘P | Quick-open a script, data file or settings.yaml by path (cursor position is remembered per file) |
| ⌘⇧E | Focus the explorer |
| ⌘B | Show/hide the explorer |
| ⌘J or ⌘` | Show/hide the Problems/Log/Network views |
| ⌘⇧M | Show the Problems view (again: hide it) |
| ⌥Z | Toggle word wrap |
| ⌘, | Open Settings |
| ⌘/, ⌘F, ⌘D | Comment, find, select next occurrence (Monaco) |
| F8 / ⇧F8 | Go to the next / previous problem in the script (TypeScript, compile, rules, runtime, route) |
| F12 | Go to definition — also into the `wt` API typings; on a JSON import it opens the data file |
| Alt+← / Alt+→ (⌃- / ⌃⇧- on macOS) | Go back / forward after a definition jump or a hover type link |

In a hover, the `wt` API types in the signature (`Route`, `RequestCtx`, …,
dotted underline) and `{@link}`s in its docs are clickable: a click swaps the
same hover for that type's signature and docs, so you can drill down type by
type without leaving your script; **← Back to …** at the top walks back up.
To read the source, press F12 / ⌘-click on `wt.onRequest`, `ctx.url`, a
`Wiretrick.*` type: the API typings (`wt-api.d.ts`) open read-only in the
Code view at that declaration. Hovers and F12 work there too, so you can keep
digging; Go back returns to your script with its cursor and unsaved edits
intact.

Tooltips (in the Editor and the popup) and Code view hovers stay open while
the pointer is over them; click one to copy its text (error messages
included) — links in a hover keep working.

Explorer layout, panel visibility and word wrap are remembered. To debug the
engine itself, open `chrome://extensions` and click the service worker /
background page under *Inspect views*.

If the stored script (or data file) changed since you opened it (synced folder, another tab),
⌘S shows a **save conflict** diff instead of saving. It takes the keyboard:
**O** overwrite with mine, **T** take theirs, **K** or Esc keep editing (for
a deleted script or data file: **R** recreate, **D** discard my text). Saves in quick
succession run one after another, so they never conflict with each other.

The **Save** button shows the save state itself: **● Save** (unsaved
changes), a spinner while saving, and a dimmed **✓ Saved** when there's
nothing to save. Next to it, the folder button shows
[folder sync](#synced-folder) at a glance, and the ↗ button opens the
script's synced file in your editor. **Settings → Open button** picks the
editor: VS Code, VS Code Insiders, **Custom editor (URL)**, or nothing (it
hides the button). Like React DevTools' "Open in Editor URL", a custom
editor is a URL template: `{path}` is the file's absolute path and `{line}`
the cursor line, e.g. `cursor://file{path}:{line}`,
`zed://file{path}:{line}` or `idea://open?file={path}&line={line}`.

## Explorer

The explorer on the left looks and works like VS Code's explorer: a tree of
[folders](scripting.md#imports-folders-and-data-files) (chevron, indent
guides), one `Name.ts` row per script ([libraries](scripting.md#libraries-and-recipes) in italics, disabled scripts dimmed and
struck through, ● for unsaved changes, ⚠ for errors) and one `name.json` row
per [data file](scripting.md#imports-folders-and-data-files) (`{}` icon,
red when its JSON is invalid). Each folder lists its subfolders
(alphabetical), then its scripts (in stacking order), then its data files
(alphabetical); ⚙ **settings.yaml** stays at the top. Scripts without a
folder sit at the root, as before. Which folders are collapsed is remembered.
Click the **Wiretrick** header to collapse the whole tree.

Hovering the explorer shows the header buttons: **New Script…**, **New JSON
File…**, **New Folder…** and **Collapse Folders in Explorer**. A new item
goes into the selected folder (or the selected file's folder) and is named in
an inline box, like VS Code (Enter creates, Esc cancels). A new data file
starts as `{}` and opens in the Code view.

With the tree focused (⌘⇧E or a click): ↑/↓, Home/End move, ← collapses a
folder (or goes to its parent folder), → expands it (or goes to its first
item), Enter opens the file and focuses the Code view (on a folder: expand /
collapse), Space opens it and keeps focus in the tree, F2 renames, Delete
(⌘⌫ on macOS) deletes after a confirmation — a folder's warns that it deletes
its contents, with counts — and Esc returns to the Code view. Right-click a
row for **Open**, **Enable/Disable** (scripts), **New Script…**, **New JSON
File…**, **New Folder…** (in that folder), **Copy Path**, **Rename…** and
**Delete**; right-click the empty area for the New items at the root. Drag a
script, data file or folder onto a folder to move it there (onto the empty
area: to the root); hovering a collapsed folder while dragging expands it.

Select several items as in VS Code: ⌘-click (Ctrl-click) adds or removes a
row, Shift-click (or Shift+↑/↓) selects a range, ⌘A (Ctrl+A) selects every
shown row and Esc clears the selection. Drag any selected row to move them all
into a folder, or press Delete (or right-click → **Delete N Items**) to delete
them after one confirmation that counts everything going; right-click also
offers **Copy Paths**. Items inside a selected folder go with it. The
**Enabled** switch in the toolbar turns the open script on or off.

Double-click a file (or F2 on a file or folder) to rename it (Enter saves, Esc cancels).
The box shows the full file name, extension included (`My script.ts`,
`users.json`), with only the name before it selected; the `.ts` of a script is
optional when you type. The name is the path in the synced folder; a `/`
moves it into a folder (`mock/api mock` → `mock/api mock.ts`; renaming a
folder moves everything in it). Each segment may hold anything
except `< > : " \ | ? *`, a trailing dot or space, and Windows device names
like `CON`; a name that clashes with another script (data file, folder) is refused.
Moving a file doesn't rewrite the import specifiers that point at it.
Reverting an edit back to the saved text clears the unsaved-changes state —
no discard prompt on a no-op edit.

### Data files

A data file opens in the Code view with Monaco's JSON support (folding,
formatting, bracket matching). JSON syntax errors are squiggled and listed in
the Problems view under the data file, with their line. ⌘S saves it
(unsaved changes, save conflicts and changes from the synced folder or another
tab work like a script's); its importers are recompiled and hot-applied. In a
script, `import limits from "./mock/rate-limits.json"` (relative to the
script's folder) is typed from the data file's current text — hovers and
completions show its properties — and F12 on the import opens the data file.

## Problems, Log and Network views

The bottom panel holds three views. Drag its header (or a view title) to dock it — a
highlighted preview shows where it lands: **below the Code view**, **full height
beside the Code view**, or **under the explorer**. Drag its edge to resize; each
dock remembers its own size, and Esc cancels a drag.

The explorer moves too: drag its header (the **Explorer** title) to the
left or right edge of the window. ⌘J hides the panel wherever it is docked
(so does the × at the right of its header);
⌘B hides the explorer (and a panel docked under it). The two layout buttons
at the right of the toolbar do the same.

- **Problems view** — what's wrong with your scripts and data files *right now*, grouped by
  file path like VS Code's (`mock/api mock.ts`): TypeScript errors and warnings, compile errors,
  invalid `rules` handlers, the last runtime error (exception in a handler),
  route warnings (a handler its strategy can't run here, or the helper being
  down), `settings.yaml` errors and JSON syntax errors in data files. Unlike the Log, entries go away by
  themselves once fixed: TypeScript problems update live as you type (even
  before saving); compile, rules and route problems on save; a runtime error
  on save or with its ×. Every entry has a line and column: where the error
  was thrown, the URL pattern a rules error is about, or the `wt.*` call that
  registered the handler it names — and is squiggled there in the editor
  like TypeScript errors (its hover comes before the API docs; F8 reaches it). Click an entry (or
  Enter) to open the file at that line; ↑/↓ move, ←/→ collapse/expand a file; the box at the top filters by
  text. ⌘⇧M shows it. Its error/warning counts are at the far left of the
  status bar, and follow the scripts. Compile, TypeScript,
  rules errors and route warnings appear only here, not in the Log; a
  runtime error appears in both (the Log has every occurrence, with its URL).
- **Log view** — engine and script log lines with level and source filters.
  The errors and warnings it holds are counted in the status bar; they stay
  until the log is cleared (🗑), whether or not you've looked.
  A VS Code-style status bar along the bottom holds the counts for all
  three views (Problems errors · warnings at the far left, then Log errors ·
  warnings, Network modified · observed), even while the panel is closed;
  non-zero counts are coloured and the view open in the panel is underlined.
  Clicking an item opens the panel on that view (clicking the open one closes
  the panel). Turn the counts and status bar off in
  **Settings → Logging → Panel counts**. Script
  exceptions in handlers are logged at ERROR, and the script gets a ⚠
  indicator in the list and the popup — as it does for compile, TypeScript
  and rules errors, which go to the Problems view instead of the Log. The download button (↓) saves the
  full debug log — every engine decision with timestamps; attach it when
  reporting issues.
- **Network view** — a devtools-style request table: a [filter bar](#network-filter), per-type
  toggles, a tab picker (closed tabs stay listed, dimmed under *Closed tabs*,
  until the log is cleared), a script-activity filter, a script picker
  (only requests one script ran on — the *Wiretrick* column; the activity
  filter then judges that script alone),
  sortable/resizable columns (right-click the header to pick columns) and a
  waterfall. Requests a script handled are flagged with their outcome:
  - **Observed** — a handler (`onRequest`, `onResponseHeaders`, `onResponseBody`,
    `replaceResponse`, …) ran on the request but changed nothing (returned
    `undefined`, or the same body). Dashed, muted marker; each such run also
    logs a DEBUG line like `[Foo] onRequest → observed (no change) https://…`
    (an `onResponseBody` that returns exactly the body it received adds
    *— it returned the same body it received*).
  - **Modified** — a handler changed it: body, headers, status, a
    redirect/block or a synthetic response. Solid accent marker and a
    green waterfall bar; the action is logged at INFO as before.

  The filter menu shows each choice with the row marker it selects:
  **All**, **Observed** (ran but changed nothing — observed only), **Modified**,
  and **Touched** (anything a script observed or modified — the default). The footer counts
  the same two groups ("N observed · M modified", observed = observed only). The
  recorded modified / observed requests are also counted in a solid /
  outlined badge on its title (a request that goes from observed to modified
  moves to the modified count); they stay until the Network log is cleared, and
  are live before the Network view is first opened. Selecting a request shows its headers, request payload, the response
  body (modified and original, when Wiretrick handled it) and what each
  script did (observed entries muted).

  Full recording (every request, headers, timing, bodies) starts the first
  time the Network view is shown and stops when that Editor closes. Before
  and after, requests a script observed, modified or missed are still kept —
  no extra browser listeners, just the engine's own log lines — up to the
  newest 500, without bodies, headers or timing (status shows as unknown).
  Opening the view shows them; closing the Editor keeps only such rows.
  - **Missed** — a script's `onResponseBody` / `replaceResponse` route
    matched a request but the handler never ran on it (the
    [Missed warning](strategies.md#missed-warning)). It is logged as
    a WARN line and shown as a yellow *missed* entry in the request's
    details; it does not mark the row observed or modified.

### Network filter

The filter bar has two modes (the choice is remembered):

- **Basic** — a URL text box plus chips. Typing suggests fields and values
  (↑/↓ show the highlighted one in the box, Esc puts back what you typed,
  Tab to accept); Enter turns typed `field:value` terms into chips.
  **+ Filter** walks field → operator → value (with suggestions, ↑/↓ and
  Enter from the value box); click a
  chip's operator to negate it, × to remove it. Picking another value for
  method, status, type, is, tab or script merges into the existing chip
  (either value matches). Chips are joined by AND/OR connectors (click one to
  switch it) and `( … )` groups, so any Advanced query shows here too. Chips
  select like text: click, drag, Shift+click, Shift+←/→, Ctrl+A, then
  Backspace/Delete, copy or cut. Ctrl+Z undoes any change, chips included
  (Ctrl+Shift+Z or Ctrl+Y redoes).
- **Advanced** — a query like a GitHub search, with autocomplete (Ctrl+Space,
  Tab/Enter to accept) and an inline error; while the query has an error the
  last valid one keeps filtering. Switching to Basic asks first only if the
  query has an error.

| Syntax | Meaning |
| --- | --- |
| `word` | URL contains word (case-insensitive); space = AND |
| `field:value` | field contains (or, for method/type, equals) value |
| `field:a,b` | either value |
| `-term`, `NOT term` | exclude |
| `a OR b`, `( … )` | either side; group |
| `"two words"` | quote spaces, commas, parentheses |
| `=value`, `val*`, `/re/` | exact, whole-value wildcard, regex |
| `>`, `>=`, `<`, `<=` | compare status, size (`kb`, `mb`), time (`ms`, `s`) |
| `4xx`, `400..499` | status class or range |

Fields: `url`, `host`, `path`, `method`, `status`, `type`, `mime`,
`req-header`/`res-header` (`name` present, `name=value` contains,
`name=/re/`), `req-body`/`res-body` (only recorded bodies are searched),
`tab` (title or id), `script`, `size`, `time`, and
`is:` `touched`/`observed`/`modified`/`missed`/`failed`/`pending`/`cached`. The **?**
button lists them with clickable examples, e.g.
`status:>=400`, `is:modified -type:img`, `method:POST,PUT host:api`,
`res-header:content-type=json`, `size:>100kb OR time:>1s`.

The tab and script pickers and type toggles still work alongside the query.

## Synced folder

Click **Folder…** and pick a folder (e.g. `~/Wiretricks`) — that becomes your
synced folder. Its subfolders mirror the explorer's folders (empty ones too),
`.ts` files are scripts and `.json` files are
[data files](scripting.md#imports-folders-and-data-files), at their relative
paths. Dot entries (`.git`, `.vscode`, `.wiretrick-backup`, …),
`node_modules`, `.d.ts` files and config JSON (`package.json`,
`package-lock.json`, `tsconfig*.json`, `jsconfig.json`, the root
`settings.schema.json`) are left alone. Connecting runs a two-way initial
sync: files without a script or data file are imported, scripts and data
files without a file are written out, and where both exist but differ the
newer one wins (file modified time vs. the last save) and the other copy is
kept in `.wiretrick-backup/` at the same relative path — the Editor lists
these before connecting so you can cancel. The same reconcile runs on every
reconnect and browser restart; there, only the side that actually changed
since the last sync wins, so a backup is made only when both changed.
A slow drive (network share, cloud folder) that reports an earlier Wiretrick
write back late isn't mistaken for an outside edit; the newer text is
written again.
`wt-api.d.ts`, `tsconfig.json` and `settings.schema.json` are written alongside. Edit in VS Code (or any editor) with full
TypeScript completions; saves hot apply instantly.

Those three are managed files: they're refreshed on every browser start
and extension update, so new APIs and settings reach an already-synced folder.
Don't edit them; your changes are overwritten. `settings.yaml` is yours: an
update only adds documentation for settings it doesn't mention yet.

Sync is two-way and watches the folder for **creates, renames/moves and
deletes** too: a new `.ts` file becomes a script, deleting a file removes its
script, renaming or moving a file renames the script (its `settings.yaml`
section moves with it); the same goes for `.json` files and data files, and
for subfolders and folders. If a file and its script both change before a sync, the file wins
and the script's version goes to `.wiretrick-backup/`. Saving in the Editor
over a script that changed elsewhere shows a diff to overwrite or take theirs. The folder choice is remembered —
the Editor reconnects automatically on open (one click to re-grant after a
browser restart, per Chrome's File System Access rules — click the toolbar
notice or the button).

The folder button next to **Save** shows the sync state: no badge (off), a
green dot (connected), a triangle moving up **▲** (writing a change made in the
extension to the folder) or down **▼** (picking up a change from it), and a yellow **!** (disconnected — needs
a re-grant). A change picked up from the folder is never sent back: updating
`settings.yaml` and its schema to match (e.g. commenting out the section of a
script whose file was deleted) is part of the **▼**. Clicking it reconnects when disconnected; otherwise it opens
**Settings → Synced folder**.

## Appearance

Settings (⚙ in the explorer header, or ⌘,) is split into Appearance,
Synced folder, Import / Export, Strategy, Local helper, Logging,
Advanced and About — pick one on the left to jump to it.

**Settings → Appearance → Theme** picks *System* (follows the OS), *Dark*
or *Light*. It applies to the Editor (Code view included) and the popup.

## Strategy

**Settings → Strategy → Default strategy** picks the
[strategy](strategies.md) every handler uses unless its route sets
`strategy` — `helper` on Chromium and `extension` on Firefox out of the
box. Strategies the current browser can't use are disabled in the picker,
and a table lists each one's pros and cons; **Compatibility** links to
[the full table](strategies.md#compatibility). It is the `defaultStrategy:` entry
in `settings.yaml`. There is no fallback: a handler whose strategy isn't
available doesn't run — the script gets a ⚠ and the Problems view a warning.

## About and diagnostics

**Settings → About** shows the installed version and the latest
[release](https://github.com/nimatrueway/wiretrick/releases) (checked on
GitHub when About opens, with a download link when there's an update), commit and build time,
the build (MV2/MV3), browser, OS, extension ID and the local helper's state.
**Copy** puts that on the clipboard as text — paste it into bug reports.

**Collect diagnostics…** (also *Wiretrick: Collect Diagnostics…* in the
Code view's F1 menu, and **collect diagnostics…** at the right of the panel
header while the Network view is open) downloads a Markdown report meant to be handed to a person
or an LLM: environment, scripts, settings.yaml, recent log and network
entries, and Editor state (theme, layout). It first asks for the optional
*management* permission to list your other extensions (they can interfere
with request interception); declining just leaves them out. Set Log level to
debug and open the Network view, reproduce the problem, then collect. Review
the file before sharing — scripts, settings and URLs are included;
cookies/authorization headers are redacted. **Copy report** copies the same
text.

## Import / export

**Settings → Export…** and **Import…** open a checklist: tick the scripts,
data files and folders (and *Settings (globals)*) to include. Export writes
one YAML bundle — each script with its code, enabled state and non-default
params, each data file with its path and text. Import reads a
bundle and lets you pick which of its items to take; each row says whether
it's **new** or **replaces existing** (a script of the same name is
overwritten rather than duplicated). If a picked script imports a library
or data file that isn't picked, the dialog warns and **Add them** ticks the
missing ones.
A plain `.ts`/`.js` file imports as a single script.

## `settings.yaml`

The explorer always has a ⚙ **settings.yaml** entry (no folder needed; no
toggle, not deletable). It is generated from storage: global settings plus
every script's params and `enabled` state. Saving it in the Code view applies it
(syntax errors show in the status and change nothing). Popup/list
changes patch the matching entries. With a synced folder connected the same
file is mirrored to `settings.yaml` there and edits sync both ways.

The file starts with a `# yaml-language-server: $schema=./settings.schema.json`
modeline and the folder sync writes that schema next to it. The schema is
generated from your scripts (each script name, its declared params with their
types, enum choices, bounds, defaults and descriptions) and rewritten whenever
a script changes. Install the
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
(`redhat.vscode-yaml`) in VS Code to get the same completion, hover and
validation as the Editor.

Formatting is preserved: an existing, parsable file is patched in place (only
the changed value is rewritten; comments, blank lines, spacing and section
order stay). A value returned to its default is rewritten as a live entry; new
scripts/keys are inserted into the existing file. The file is generated from
scratch only when missing or unparsable.

Every option has its description above it; options at their default are
commented out, only non-default values are live entries. `enabled` is live only
when `false`. Params are keyed by script name; a library is listed only
when it declares params (without `enabled` — it never runs on its own).

```yaml
# yaml-language-server: $schema=./settings.schema.json
settings:
  # Minimum log level shown in the panel: debug | info | warn | error
  # logLevel: info
  # …
  # Interception strategy for every handler whose route doesn't set `strategy`.
  # …one pros/cons line per strategy…
  # helper | page | extension | debugger | rules
  # defaultStrategy: helper

params:
  Debug header:
    # Run this script
    enabled: false
    # Value of the x-debug header
    # default: warn
    level: trace
```
