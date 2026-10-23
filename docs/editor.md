# The Editor

[← README](../README.md) · [Glossary](../GLOSSARY.md)

The Editor is Wiretrick's full-page UI. Its **Code view** embeds **Monaco** (the VS Code editor) with full TypeScript
IntelliSense for the `wt` API — completions, hover docs, and diagnostics work
out of the box. Shortcuts follow VS Code (⌘ = Ctrl on Windows/Linux; F1
lists the Code view commands, and the **?** dialog's **Shortcuts** tab has a
searchable list of all of them):

| Shortcut | Action |
| --- | --- |
| ⌘S | Save and hot apply the script |
| ⌘P | Quick-open a script or settings.yaml (cursor position is remembered per file) |
| ⌘⇧E | Focus the explorer |
| ⌘B | Show/hide the explorer |
| ⌘J or ⌘` | Show/hide the Problems/Log/Network views |
| ⌘⇧M | Show the Problems view (again: hide it) |
| ⌥Z | Toggle word wrap |
| ⌘, | Open Settings |
| ⌘/, ⌘F, ⌘D | Comment, find, select next occurrence (Monaco) |
| F12 | Go to definition — also into the `wt` API typings |
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

If the stored script changed since you opened it (synced folder, another tab),
⌘S shows a **save conflict** diff instead of saving. It takes the keyboard:
**O** overwrite with mine, **T** take theirs, **K** or Esc keep editing (for
a deleted script: **R** recreate, **D** discard my text). Saves in quick
succession run one after another, so they never conflict with each other.

The **Save** button shows the save state itself: **● Save** (unsaved
changes), a spinner while saving, and a dimmed **✓ Saved** when there's
nothing to save. Next to it, the folder button shows
[folder sync](#synced-folder) at a glance, and the VS Code button opens the
synced folder in VS Code (it shows the VS Code Insiders icon when
**Settings → Open button** is VS Code Insiders).

## Explorer

The explorer on the left looks and works like VS Code's explorer: one
`Name.ts` row per script ([libraries](scripting.md#libraries-and-recipes) in italics, disabled scripts dimmed and
struck through, ● for unsaved changes, ⚠ for errors). Click the **Wiretrick**
header to collapse it. With the list focused (⌘⇧E or a click): ↑/↓,
Home/End move, Enter opens the script and focuses the Code view, Space opens it
and keeps focus in the list, F2 renames, Delete (⌘⌫ on macOS) deletes after a
confirmation, Esc returns to the Code view. Right-click a row for **Open**,
**Enable/Disable**, **Rename…** and **Delete**. The **Enabled** switch in the
toolbar turns the open script on or off.

Double-click a script (or F2) to rename it (Enter saves, Esc cancels).
The name is the file name in the synced folder (`My script.ts`), so anything
works except `< > : " / \ | ? *`, a trailing dot or space, and Windows device
names like `CON`; a name that clashes with another script is refused.
Reverting an edit back to the saved text clears the unsaved-changes state —
no discard prompt on a no-op edit.

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

- **Problems view** — what's wrong with your scripts *right now*, grouped by
  file like VS Code's: TypeScript errors and warnings, compile errors,
  invalid `rules` handlers, the last runtime error (exception in a handler),
  route warnings (a handler its strategy can't run here, or the helper being
  down) and `settings.yaml` errors. Unlike the Log, entries go away by
  themselves once fixed: TypeScript problems update live as you type (even
  before saving); compile, rules and route problems on save; a runtime error
  on save or with its ×. Every entry has a line: where the error was thrown,
  or the `wt.*` call that registered the handler it names. Click an entry (or
  Enter) to open the script at that line; ↑/↓ move, ←/→ collapse/expand a file; the box at the top filters by
  text. ⌘⇧M shows it. Its error/warning counts are on its title and at the
  far left of the status bar, and follow the scripts. Compile, TypeScript,
  rules errors and route warnings appear only here, not in the Log; a
  runtime error appears in both (the Log has every occurrence, with its URL).
- **Log view** — engine and script log lines with level and source filters.
  The errors and warnings it holds are counted in red/yellow badges on its
  title; they stay until the log is cleared (🗑), whether or not you've looked.
  A VS Code-style status bar along the bottom shows the same counts for all
  three views (Problems at the far left, then Log errors · warnings, Network
  modified · observed) even while the panel is closed; clicking one opens the
  panel on that view. Turn this off (badges and status bar, all views) in
  **Settings → Logging → Panel counts**. Script
  exceptions in handlers are logged at ERROR, and the script gets a ⚠
  indicator in the list and the popup — as it does for compile, TypeScript
  and rules errors, which go to the Problems view instead of the Log. The download button (↓) saves the
  full debug log — every engine decision with timestamps; attach it when
  reporting issues.
- **Network view** — a devtools-style request table: filter text, per-type
  toggles, a tab picker (closed tabs stay listed, dimmed under *Closed tabs*,
  until the log is cleared), a script-activity filter,
  sortable/resizable columns (right-click the header to pick columns) and a
  waterfall. Requests a script handled are flagged with their outcome:
  - **Observed** — a handler (`onRequest`, `onResponseHeaders`, `onResponseBody`,
    `replaceResponse`, …) ran on the request but changed nothing (returned
    `undefined`, or the same body). Dashed, muted marker; each such run also
    logs a DEBUG line like `[Foo] onRequest → observed (no change) https://…`.
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

## Synced folder

Click **Folder…** and pick a folder (e.g. `~/Wiretricks`) — that becomes your
synced folder. Connecting runs a two-way initial sync: `.ts` files without a
script are imported, scripts without a file are written out, and where both
exist but differ the newer one wins (file modified time vs. the script's last
save) and the other copy is kept in `.wiretrick-backup/` — the Editor lists
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
script, renaming a file renames the script (its `settings.yaml` section moves
with it). If a file and its script both change before a sync, the file wins
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
Code view's F1 menu) downloads a Markdown report meant to be handed to a person
or an LLM: environment, scripts, settings.yaml, recent log and network
entries, and Editor state (theme, layout). It first asks for the optional
*management* permission to list your other extensions (they can interfere
with request interception); declining just leaves them out. Set Log level to
debug and open the Network view, reproduce the problem, then collect. Review
the file before sharing — scripts, settings and URLs are included;
cookies/authorization headers are redacted. **Copy report** copies the same
text.

## Import / export

**Settings → Export…** and **Import…** open a checklist: tick the scripts
(and *Settings (globals)*) to include. Export writes one YAML bundle — each
script with its code, enabled state and non-default params. Import reads a
bundle and lets you pick which of its items to take; each row says whether
it's **new** or **replaces existing** (a script of the same name is
overwritten rather than duplicated). If a picked script imports a library
that isn't picked, the dialog warns and **Add them** ticks the missing ones.
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
