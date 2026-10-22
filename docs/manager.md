# The manager

[← README](../README.md)

The manager page embeds **Monaco** (the VS Code editor) with full TypeScript
IntelliSense for the `wt` API — completions, hover docs, and diagnostics work
out of the box. Shortcuts follow VS Code (⌘ = Ctrl on Windows/Linux; F1
lists the editor commands, and the **?** dialog's **Shortcuts** tab has a
searchable list of all of them):

| Shortcut | Action |
| --- | --- |
| ⌘S | Save and hot-apply the script |
| ⌘P | Quick-open a script or settings.yaml (cursor position is remembered per file) |
| ⌘⇧E | Focus the explorer (script list) |
| ⌘B | Show/hide the explorer |
| ⌘J or ⌘` | Show/hide the Log/Network panel |
| ⌥Z | Toggle word wrap |
| ⌘, | Open Settings |
| ⌘/, ⌘F, ⌘D | Comment, find, select next occurrence (Monaco) |

Explorer layout, panel visibility and word wrap are remembered. To debug the
engine itself, open `chrome://extensions` and click the service worker /
background page under *Inspect views*.

## Explorer

The script list on the left looks and works like VS Code's explorer: one
`Name.ts` row per script (libraries in italics, disabled scripts dimmed and
struck through, ● for unsaved changes, ⚠ for errors). Click the **Wiretrick**
header to collapse it. With the list focused (⌘⇧E or a click): ↑/↓,
Home/End move, Enter opens the script and focuses the editor, Space opens it
and keeps focus in the list, F2 renames, Delete (⌘⌫ on macOS) deletes after a
confirmation, Esc returns to the editor. Right-click a row for **Open**,
**Enable/Disable**, **Rename…** and **Delete**. The **Enabled** switch in the
editor toolbar turns the open script on or off.

Double-click a script (or F2) to rename it (Enter saves, Esc cancels).
The name is the file name in the scripts folder (`My script.ts`), so anything
works except `< > : " / \ | ? *`, a trailing dot or space, and Windows device
names like `CON`; a name that clashes with another script is refused. Older
underscore files (`My_script.ts`) are renamed to the exact name on connect.
Reverting an edit back to the saved text clears the unsaved-changes state —
no discard prompt on a no-op edit.

## Log and Network panels

The panel has two tabs. Drag its header (or a tab title) to dock it — a
highlighted preview shows where it lands: **below the editor**, **full height
beside the editor**, or **under the script list**. Drag its edge to resize; each
dock remembers its own size, and Esc cancels a drag.

The script list moves too: drag its header (the **Explorer** title) to the
left or right edge of the window. ⌘J hides the panel wherever it is docked;
⌘B hides the explorer (and a panel docked under it). The two layout buttons
at the right of the editor toolbar do the same.

- **Log** — engine and script log lines with level and source filters. While
  the Log tab is out of view (Network tab open, panel hidden, or the manager
  in the background), new errors and warnings are counted in red/yellow
  badges on its title; looking at it clears them. Turn this off (for both
  tabs) in **Settings → Logging → Tab badges**. Script
  errors (exceptions in handlers, failed compiles) are logged at ERROR, and
  the script gets a ⚠ indicator in the list and the popup. TypeScript errors
  in a saved script also show up there. The download button (↓) saves the
  full debug log — every engine decision with timestamps; attach it when
  reporting issues.
- **Network** — a devtools-style request table: filter text, per-type
  toggles, a tab picker (closed tabs stay listed, dimmed under *Closed tabs*,
  until the log is cleared), a script-activity filter,
  sortable/resizable columns (right-click the header to pick columns) and a
  waterfall. Requests a script handled are flagged in two ways:
  - **Tapped** — a handler (`onRequest`, `onResponseHeaders`, `modifyResponse`,
    `replaceResponse`, …) ran on the request but changed nothing (returned
    `undefined`, or the same body). Dashed, muted marker; each such run also
    logs a DEBUG line like `[Foo] onRequest → tapped (no change) https://…`.
  - **Modified** — a handler changed it: body, headers, status, a
    redirect/cancel or a synthetic response. Solid accent marker and a
    green waterfall bar; the action is logged at INFO as before.

  The filter menu shows each choice with the row marker it selects:
  **All**, **Tapped** (ran but changed nothing — tapped only), **Modified**,
  and **Tapped / Modified** (anything a script touched). The footer counts
  the same two groups ("N tapped · M modified", tapped = tapped only). While
  the Network tab is out of view, requests that become modified / tapped are
  counted in a solid / outlined badge on its title (a request that goes from
  tapped to modified moves to the modified count); looking at it clears
  them. Selecting a request shows its headers, request payload, the response
  body (modified and original, when Wiretrick handled it) and what each
  script did (tapped entries muted).
  - **Missed** — a script with `modifyResponse` / `replaceResponse` matched
    a request but no tier ever ran the handler (see
    [“never ran” warning](strategies.md#never-ran-warning)). It is logged as
    a WARN line and shown as a yellow *missed* entry in the request's
    details; it does not mark the row tapped or modified.

## Dedicated scripts folder

Click **Folder…** and pick a folder (e.g. `~/Wiretricks`) — that becomes your
scripts home. Connecting runs a two-way initial sync: `.ts` files without a
script are imported, scripts without a file are written out, and where both
exist but differ the newer one wins (file modified time vs. the script's last
save) and the other copy is kept in `.wiretrick-backup/` — the manager lists
these before connecting so you can cancel. The same reconcile runs on every
reconnect and browser restart; there, only the side that actually changed
since the last sync wins, so a backup is made only when both changed.
`wt-api.d.ts` and `tsconfig.json` are written alongside. Edit in VS Code (or any editor) with full
TypeScript completions; saves hot-reload into the engine instantly.

Sync is two-way and watches the folder for **creates, renames/moves and
deletes** too: a new `.ts` file becomes a script, deleting a file removes its
script, renaming a file renames the script (its `settings.yaml` section moves
with it). If a file and its script both change before a sync, the file wins
and the script's version goes to `.wiretrick-backup/`. Saving in the manager
over a script that changed elsewhere shows a diff to overwrite or take theirs. The folder choice is remembered —
the manager reconnects automatically on open (one click to re-grant after a
browser restart, per Chrome's File System Access rules — click the toolbar
notice or the button).

## Appearance

Settings (⚙ in the explorer header, or ⌘,) is split into Appearance,
Scripts folder, Import / Export, Local helper, Logging, Advanced and About —
pick one on the left to jump to it.

**Settings → Appearance → Theme** picks *System* (follows the OS), *Dark*
or *Light*. It applies to the manager, the editor and the popup.

## About and diagnostics

**Settings → About** shows the installed version and the latest
[release](https://github.com/nimatrueway/wiretrick/releases) (checked on
GitHub when About opens, with a download link when there's an update), commit and build time,
the build (MV2/MV3), browser, OS, extension ID and the local helper's state.
**Copy** puts that on the clipboard as text — paste it into bug reports.

**Collect diagnostics…** (also *Wiretrick: Collect Diagnostics…* in the
editor's F1 menu) downloads a Markdown report meant to be handed to a person
or an LLM: environment, scripts, settings.yaml, recent log and network
entries, and manager state (theme, layout). It first asks for the optional
*management* permission to list your other extensions (they can interfere
with request interception); declining just leaves them out. Set Log level to
debug and open the Network tab, reproduce the problem, then collect. Review
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

The script list always has a ⚙ **settings.yaml** entry (no folder needed; no
toggle, not deletable). It is generated from storage: global settings plus
every script's params and `enabled` state. Saving it in the editor applies it
(syntax errors show in the editor status and change nothing). Popup/list
changes patch the matching entries. With a scripts folder connected the same
file is mirrored to `settings.yaml` there and edits sync both ways.

The file starts with a `# yaml-language-server: $schema=./settings.schema.json`
modeline and the folder sync writes that schema next to it. The schema is
generated from your scripts (each script name, its declared params with their
types, enum choices, bounds, defaults and descriptions) and rewritten whenever
a script changes. Install the
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
(`redhat.vscode-yaml`) in VS Code to get the same completion, hover and
validation as the manager.

Formatting is preserved: an existing, parsable file is patched in place (only
the changed value is rewritten; comments, blank lines, spacing and section
order stay). A value returned to its default is rewritten as a live entry; new
scripts/keys are inserted into the existing file. The file is generated from
scratch only when missing or unparsable.

Every option has its description above it; options at their default are
commented out, only non-default values are live entries. `enabled` is live only
when `false`. Params are keyed by script name; libraries are omitted.

```yaml
# yaml-language-server: $schema=./settings.schema.json
settings:
  # Minimum log level shown in the panel: debug | info | warn | error
  # logLevel: info

params:
  Debug header:
    # Run this script
    enabled: false
    # Value of the x-debug header
    # default: warn
    level: trace
```
