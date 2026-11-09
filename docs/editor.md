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
| ⌘J or ⌘` | Show/hide the Problems/Log/Network/Preview views |
| ⌥⇧P (or ⌘⇧M) | Show the Problems view and focus its filter (again: hide the panel) |
| ⌥⇧L | Show the Log and focus its filter (again: hide the panel) |
| ⌥⇧N | Show the Network view and focus its filter (again: hide the panel) |
| ⌥⇧V | Show the [Preview](#preview) of the open script's overlay and focus its URL (again: hide the panel) |
| ⌥⇧K | Clear the Log and Network |
| ⌥Z | Toggle word wrap |
| ⌘, | Open Settings |
| ⌘/, ⌘F, ⌘D | Comment, find, select next occurrence (Monaco) |
| F8 / ⇧F8 | Go to the next / previous problem in the script (TypeScript, compile, rules, runtime, route) |
| F12 | Go to definition — also into the `wt` API typings; on a JSON import it opens the data file |
| Alt+← / Alt+→ (⌃- / ⌃⇧- on macOS) | Go back / forward after a definition jump or a hover type link |

In a hover, the `wt` API types in the signature (`RouteOptions`, `RequestCtx`, …,
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
The button needs the synced folder's absolute path in **Settings → Synced
folder → Folder path**: the browser's folder picker never reveals it, so
paste it in. The setting says how to copy it on your OS (Finder: ⌥⌘C;
File Explorer: Ctrl+Shift+C; Linux file managers: Ctrl+L), and quotes or a
`file://` URI in what you paste are cleaned up. Right after you pick a
folder (or press the button without a path), Settings opens at Folder path,
flashes it and shows a ⚠ until the path is filled in and ends in the picked
folder's name.

## Explorer

The explorer on the left looks and works like VS Code's explorer: a tree of
[folders](scripting.md#imports-folders-and-data-files) (chevron, indent
guides), one `Name.ts` (or `Name.tsx`, ⚛ icon) row per script ([libraries](scripting.md#libraries-and-recipes) in italics, disabled scripts dimmed and
struck through, ● for unsaved changes, ⚠ for errors) and one `name.json` row
per [data file](scripting.md#imports-folders-and-data-files) (`{}` icon,
red when its JSON is invalid; ◈ for an `.svg`). Each folder lists its subfolders
(alphabetical), then its scripts (in stacking order), then its data files
(alphabetical); ⚙ **settings.yaml** stays at the top. Scripts without a
folder sit at the root, as before. Which folders are collapsed is remembered.
Click the **Wiretrick** header to collapse the whole tree.

Hovering the explorer shows the header buttons: **New Script…**, **New JSON
File…**, **New Folder…**, **Install Script…** (opens the [install
dialog](packages.md#install-a-script); you can also drop a link, a file, a folder
or a `.zip` on the explorer) and **Collapse Folders in Explorer**. A new item
goes into the selected folder (or the selected file's folder) and is named in
an inline box, like VS Code (Enter creates, Esc cancels). A new data file
is `.json` (starting as `{}`) unless you type `.svg` (an empty `<svg>`) and
opens in the Code view.

With the tree focused (⌘⇧E or a click): ↑/↓, Home/End move, ← collapses a
folder (or goes to its parent folder), → expands it (or goes to its first
item), Enter opens the file and focuses the Code view (on a folder: expand /
collapse), Space opens it and keeps focus in the tree, F2 renames, Delete
(⌘⌫ on macOS) deletes after a confirmation — a folder's warns that it deletes
its contents, with counts — and Esc returns to the Code view. Right-click a
row for **Open**, **Enable/Disable** (scripts), **Make Package…** and
**Export Package…** (scripts, folders and package folders — see [Sharing
scripts](packages.md#sharing-scripts)), **New Script…**, **New JSON
File…**, **New Folder…** (in that folder), **Copy Path**, **Rename…** and
**Delete**; right-click the empty area for the New items at the root. Drag a
script, data file or folder onto a folder to move it there (onto the empty
area: to the root); hovering a collapsed folder while dragging expands it.
A package's folder — [installed](packages.md), or one holding a
`metadata.json`, as **Make Package…** leaves it — has a box icon instead
of a folder. An installed one-file package's script shows 📦; an installed
package shows ⬆ when an update waits for review (click it to review); its
right-click menu adds **Review Update…**, **Check for Updates**, **Turn
Auto-Update On/Off**, **Roll Back to …**, **Open Source Page** and **Forget
Package (Keep Files)**.

Select several items as in VS Code: ⌘-click (Ctrl-click) adds or removes a
row, Shift-click (or Shift+↑/↓) selects a range, ⌘A (Ctrl+A) selects every
shown row and Esc clears the selection. Drag any selected row to move them all
into a folder, or press Delete (or right-click → **Delete N Items**) to delete
them after one confirmation that counts everything going; right-click also
offers **Copy Paths**. Items inside a selected folder go with it. The
**Enabled** switch in the toolbar turns the open script on or off.

Double-click a file (or F2 on a file or folder) to rename it (Enter saves, Esc cancels).
The box shows the full file name, extension included (`My script.ts`,
`users.json`), with only the name before it selected (`.wiretrick.ts` too); the `.ts` of a script is
optional when you type, while `.tsx` makes it a [`.tsx` script](scripting.md#built-in-valtio-and-react). The name is the path in the synced folder; a `/`
moves it into a folder (`mock/api mock` → `mock/api mock.ts`; renaming a
folder moves everything in it). Each segment may hold anything
except `< > : " \ | ? *`, a trailing dot or space, and Windows device names
like `CON`; a name that clashes with another script (data file, folder) is refused.
Moving a file doesn't rewrite the import specifiers that point at it, but
after a move (or a delete) the moved scripts and every script importing them,
directly or through other scripts, are type-checked again, so a broken import
shows up in Problems right away.
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
An `.svg` data file opens as XML; importing it gives its markup, typed `string`.

## Problems, Log, Network and Preview views

The bottom panel holds four views. Drag its header (or a view title) to dock it — a
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
  Enter) to open the file at that line; ↑/↓ move, ←/→ collapse/expand a file; the filter box in
  the panel header filters by text. ⌥⇧P (or ⌘⇧M) shows it. Its error/warning counts are at the far left of the
  status bar, and follow the scripts. Compile, TypeScript,
  rules errors and route warnings appear only here, not in the Log; a
  runtime error appears in both (the Log has every occurrence, with its URL).
  A runtime error from script code that runs on a page says where it ran first:
  `overlay › host` (its [overlay](scripting.md#overlays--wtonoverlay)),
  `isolated › host` (its `onPage` code) or `page › host` (its `onSite`
  code). A handle call in `onSite` code (`SiteCannotCallError`) is such an
  error, with a quick fix (Ctrl+. / ⌘.) that moves the handler to
  `wt.onPage`; a route with the removed `js`, `dom` or `unsafe` option gets
  one to `wt.onSite` / `wt.onOverlay`.
  On Chrome, `onPage` code while
  [user scripts are off](scripting.md#user-scripts-on-chrome) is an error
  whose `chrome://extensions` link opens Wiretrick's details page; the
  Editor also shows a one-time banner with a **Grant permission** (or
  **Open extension details**) button.
- **Log view** — engine and script log lines with a [filter bar](#log-filter)
  like the Network view's and a minimum-level menu. Lines from script code
  that runs on a page are tagged with where it ran (`overlay ›`,
  `isolated ›` or `page ›` — the page's own world, which includes `page`-strategy
  handlers — and the page's host). Each view's filter sits
  in the same place, the panel header next to the tabs, with its clear icon
  after it.
  URIs in log lines are links, whatever the scheme: `https:`, `chrome:`,
  `file:` or `data:` ones open in a new tab (⌘/Ctrl- or middle-click: in the
  background), and others such as `vscode:` or `mailto:` go to the app that
  handles them.
  New lines scroll into view; like VS Code, scrolling up pauses that until
  you scroll back to the end, and the 🔒 scroll-lock button stops it
  outright until clicked again.
  The errors and warnings it holds are counted in the status bar; they stay
  until the log is cleared (clear icon), whether or not you've looked.
  A VS Code-style status bar along the bottom holds the counts for all
  three views (Problems errors · warnings at the far left, then Log errors ·
  warnings, Network modified · observed), even while the panel is closed;
  non-zero counts are coloured and the view open in the panel is underlined.
  Clicking an item opens the panel on that view (clicking the open one closes
  the panel). Turn the counts and status bar off in
  **Settings → Logging → Panel counts**. Script
  exceptions in handlers are logged at ERROR, and the script gets a ⚠
  indicator in the list and the popup — as it does for compile, TypeScript
  and rules errors, which go to the Problems view instead of the Log. The
  panel header's actions sit in the same place on Log, Network and
  Problems: **Clear** (Log and Network) empties both the Log and Network, and **Download diagnostics**
  saves the [diagnostics report](#about-and-diagnostics) (the log, the full
  debug log, network requests, scripts and settings) — attach it when
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
    `undefined` / `null`). Dashed, muted marker; each such run also
    logs a DEBUG line like `[Foo] onRequest → observed (no change) https://…`.
    An `onResponseBody` that returns a body — even the one it received —
    counts as modified.
    Page-side code counts as observed too: a page's document request names
    each script whose `onPage` ran or whose overlay was shown on it
    (`onPage ran`, `overlay shown`), and a fetch the overlay made as the
    page names its script (`fetched by its overlay`).
  - **Modified** — a handler changed it: body, headers, status, a
    redirect/block or a synthetic response. Solid accent marker and a
    green waterfall bar; the action is logged at INFO as before.

  The filter starts as an `is:touched` chip (anything a script observed or
  modified); remove it to see every request, or use `is:observed` (ran but
  changed nothing), `is:modified`, `type:`, `script:` or `tab:` instead —
  the filter bar is the only filter. The footer counts
  the same two groups ("N observed · M modified", observed = observed only). The
  recorded modified / observed requests are also counted in a solid /
  outlined badge on its title (a request that goes from observed to modified
  moves to the modified count); they stay until the Network log is cleared, and
  are live before the Network view is first opened. Selecting a request shows its headers, request payload, the response
  body (modified and original, when Wiretrick handled it) and what each
  script did (observed entries muted). **Copy** above a payload or response
  body puts it on the clipboard (pretty-printed JSON, as shown). Each body is
  kept up to 2 MB (2048 kB) by default; a longer one is cut and says so — raise the
  cap in **Settings → Network → Body capture** (16–16384 kB, `bodyCap:` in
  `settings.yaml`). It applies to requests captured afterwards.
  Select several rows with Shift-click (a range), Ctrl/⌘-click (one more) or
  Ctrl/⌘+A, and right-click for **Open in new tab** and **Copy** → **Copy
  URL**, **Copy as cURL** (bash), **Copy as fetch** or **Copy as HAR**,
  devtools-style; with several rows selected these act on all of them (HAR:
  one HAR 1.2 log with headers, cookies, timings and the recorded bodies;
  like the cURL and fetch copies it isn't sanitized). Ctrl/⌘+C copies the
  selected URLs. With the table focused, ↑/↓, PageUp/PageDown and Home/End
  move the selection (Shift extends it); the details pane, when open,
  follows it, and Enter opens it.

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
- **Preview view** — the open script's [overlay](scripting.md#overlays--wtonoverlay),
  live, over a placeholder page; see [Preview](#preview).

### Preview

The **Preview** tab (⌥⇧V) runs the overlay (`wt.onOverlay`) of the script
open in the Code view in a frame inside the Editor, without opening its
page, so you can work on the GUI before going to the site; a script that's
turned off previews too. It runs the saved script and updates it in place
on every save, as on a page ([hot reload](scripting.md#hot-reload--runs-and-ctx)).

- **Real stores.** The preview's `wt.globalStore`s are live copies of the
  background's, like a page's overlay: flipping a switch in the preview
  turns a mock on or off for the pages in your tabs, and their overlays
  follow. Its `wt.siteStore`s belong to the checkerboard "page": they
  start from `initial` and last while the preview does.
- **URL.** The field in the panel header is the URL the overlay gets as
  `ctx.url`, and the base for its relative `fetch` URLs. It starts at a URL
  made from the script's first overlay route (`*://app.example.com/*`
  → `https://app.example.com/`) and is remembered per script; Enter applies
  it, Esc puts back the current one. Only the handlers whose route matches
  it run, as on a page; **no handler matches** shows when none does.
- **Fetches.** There's no page behind the preview, so the overlay's `fetch`
  (and `wt.fetch`, `from: "page"`) goes from the extension background
  instead — host permissions, no CORS, the browser's cookies — and the
  header shows **fetch runs from the background** once it has. Your
  scripts' handlers see these requests like `wt.fetch`'s.
- **No page.** `onSite` and `onPage` code don't run in the preview: the
  overlay's calls into them reject with `there's no page in the Editor
  preview`.
- **Viewport.** The menu next to the URL sizes the frame: the panel's size
  (*Fit*), or a laptop, tablet or phone size. ↻ reloads the preview.
- Logs and errors go to the script's Log with `overlay › preview`.
- On Firefox, the Editor must be open in a tab (not a popup window) for
  the preview to connect.

### Network filter

The filter box sits in the panel header. It has two modes, switched with
the `{ }` button inside it (the choice is remembered):

- **Basic** — a URL text box plus chips. Typing suggests fields and values
  (↑/↓ show the highlighted one in the box, Esc puts back what you typed,
  Tab to accept); Enter turns typed `field:value` terms into chips.
  Ctrl+Space shows the suggestions for the word at the caret, or, with
  nothing to suggest, opens the **+ Filter** field list right there.
  **+ Filter** walks field → operator → value (the field list takes ↑/↓,
  a letter to jump, Enter or Tab to pick; then suggestions, ↑/↓ and
  Enter from the value box; on text fields like url, Alt+↑/↓ switch the
  operator — plain ↑/↓ too when there's no suggestion list; Tab adds the filter, like **Add**); click a
  chip's operator to negate it, × to remove it. Picking another value for
  method, status, type, is, tab or script merges into the existing chip
  (either value matches). Chips are joined by AND/OR connectors (click one to
  switch it) and `( … )` groups, so any Advanced query shows here too. Typing
  `OR ` or `AND ` after a filter turns it into a connector, `(` (or `-(` for
  NOT) opens a group that what you type next goes into, and `)` closes it;
  Backspace at the start of the box takes them back one by one. Chips
  select like text: click, drag, Shift+click, Shift+←/→, Ctrl+A, then
  Backspace/Delete, copy or cut. ←/→ move the caret past each chip, so it
  stops on either side of it: type there and Enter (or move away) puts
  the new filters in that spot, and Backspace/Delete remove the chip next
  to the caret. Enter, Space or a double-click on a selected chip turns it
  back into text to edit in place (Enter keeps the edit, Esc drops it).
  `(` / `-(` and `)` work there too, as in text: type `(` before a chip
  and the group runs to the end until you type `)` further on (or the
  other way round); Backspace/Delete next to a parenthesis removes just
  that one, so you can move it. `OR ` / `AND ` typed there set the
  connector on the caret's left (or, at the end of a group, the one that
  joins what you type next); Backspace turns an OR back into AND.
  Shift+←/→, Shift+click and dragging out of the text box select from
  wherever the caret is. Suggestions open under the word being completed;
  status codes show their meaning (404 Not Found, 4xx Client error).
  Ctrl+Z undoes any change, chips included (Ctrl+Shift+Z or Ctrl+Y redoes).
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

### Log filter

The Log's filter bar works the same way — Basic chips or an Advanced query,
same syntax and **?** help — over log lines. A bare word (or `"phrase"`,
`/re/`) searches the message, and matches are highlighted. Fields: `message`,
`source` (script name or component, e.g. `pipeline`, `page`), `level`
(`debug`, `info`, `warn`, `error`, or a comparison like `>=warn`), and
`is:` `observed` (a handler ran without changing the request) / `link`
(has a link). E.g. `level:>=warn -source:page`, `/timeout|refused/`,
`is:observed source:myScript`. The level menu beside it still applies, so
pick **Debug+** there to see `level:debug` lines.

## Synced folder

Click **Folder…** and pick a folder (e.g. `~/Wiretricks`) — that becomes your
synced folder. Its subfolders mirror the explorer's folders (empty ones too),
`.ts` and `.tsx` files are scripts and `.json` and `.svg` files are
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
TypeScript completions; saves hot apply instantly. The typings of
[package imports](scripting.md#packages-from-unpkg) go to
`.wiretrick/types/`, which Wiretrick owns: it rewrites and prunes them as
scripts change. The built-ins' (`valtio`, `react`, `react-dom`) go to
`.wiretrick/types/builtin/`, so their imports resolve there too.

Those three are managed files: they're refreshed on every browser start
and extension update, so new APIs and settings reach an already-synced folder.
Don't edit them; your changes are overwritten. `settings.yaml` is yours: an
update only adds documentation for settings it doesn't mention yet.

Sync is two-way and watches the folder for **creates, renames/moves and
deletes** too: a new `.ts`/`.tsx` file becomes a script, deleting a file removes its
script, renaming or moving a file renames the script (its `settings.yaml`
section moves with it); the same goes for `.json`/`.svg` files and data files, and
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
Network, Advanced and About — pick one on the left to jump to it.

**Settings → Appearance → Theme** picks *System* (follows the OS), *Dark*
or *Light*. It applies to the Editor (Code view included) and the popup.

## Strategies

[Strategies](strategies.md) explains every strategy, with a table of their
pros and cons and [which browsers run which](strategies.md#compatibility). There is no default
strategy: every network handler names its own
(`wt.onRequest({ url, strategy: "helper" }, fn)`). There is no fallback
either: a handler whose strategy isn't available doesn't run — the script
gets a ⚠ and the Problems view a warning.

## About and diagnostics

**Settings → About** shows the installed version and the latest
[release](https://github.com/nimatrueway/wiretrick/releases) (checked on
GitHub when About opens, with a download link when there's an update), commit and build time,
the build (MV2/MV3), browser, OS, extension ID and the local helper's state.
**Copy** puts that on the clipboard as text — paste it into bug reports.
**Help…** opens the samples and keyboard shortcuts (the
editor toolbar's **?**).

**Welcome page.** With no scripts yet, the Editor opens on a welcome page
that lists every sample. **Try it** adds the sample (turned on), waits until
it's running and opens its page in a new tab, already changed; **Open** just
adds it. None of the samples need the local helper. Reopen the page any time
from **?** → **Welcome** (top right of the Help dialog); ✕ closes it.

**Collect diagnostics…** (also *Wiretrick: Collect Diagnostics…* in the
Code view's F1 menu, and **Download diagnostics** at the right of the
Log, Network and Problems panel header) downloads a Markdown report meant to be handed to a person
or an LLM: environment, the Problems view's current problems, scripts,
settings.yaml, recent log and network
entries, and Editor state (theme, layout). It first opens a picker, like
[Export…](#import--export)'s: every section and every script (under
*Scripts*), all ticked — untick what shouldn't go in; the report says what
was left out. With *Other installed extensions* ticked, **Download** asks for
the optional *management* permission to list them (they can interfere
with request interception); declining just leaves them out. Set Log level to
debug and open the Network view, reproduce the problem, then collect. Review
the file before sharing — scripts, settings and URLs are included;
cookies/authorization headers are redacted. **Copy report** copies the same
text.

## Import / export

**Settings → Export…** downloads a zip (`wiretrick-export.zip`) laid out
like the [synced folder](#synced-folder): scripts as `.ts`/`.tsx`
files and data files at their paths, empty folders as folders, and
`settings.yaml` at the root with the global settings and the exported
scripts' `enabled` state and params. **Import…** takes such a zip — or a
zip of a synced scripts folder (its `wt-api.d.ts`, `tsconfig.json` and
`settings.schema.json` are skipped).

Both open the files as a tree, all ticked: tick or untick files, or a whole
folder (its box shows when only some of its files are ticked). The filter
box narrows the tree to paths containing what you type, and **Select
all**/**None** act on what it shows. On import each row says whether it's
**new** or **replaces existing** (a script at the same path is overwritten
rather than duplicated). Untick `settings.yaml` to leave settings, params
and `enabled` state alone. If a picked script imports a library or data
file that isn't picked, the dialog warns and **Add them** ticks the missing
ones.

Importing a new version of a package (a zip from **Export Package…**, whose
files are all in one folder, or any folder in the zip with a
`metadata.json`) also lists the files you have in that folder that the new
version doesn't, struck through and marked **deleted**. They're ticked, so
importing deletes them. Untick any you want to keep.
A plain `.ts`/`.tsx`/`.js` file imports as a single script.

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
  # Content-Types onResponseBody gets as text (globs; `*` = anything). …
  # textTypes:
  #   - text/*
  #   - …
  # Network view: kB of each request/response body kept (16..16384)
  # bodyCap: 2048

params:
  Debug header:
    # Run this script
    enabled: false
    # Value of the x-debug header
    # default: warn
    level: trace
```

`textTypes` has no control in Settings: edit it here. It lists the
Content-Types `onResponseBody` gets as text and replaces the defaults
([binary bodies](scripting.md#binary-bodies)).
