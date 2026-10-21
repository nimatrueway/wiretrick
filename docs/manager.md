# The manager

[← README](../README.md)

The manager page embeds **Monaco** (the VS Code editor) with full TypeScript
IntelliSense for the `wt` API — completions, hover docs, and diagnostics work
out of the box. Cmd/Ctrl+S saves and hot-applies the script; ⌘P quick-opens
scripts/settings.yaml (cursor position is remembered per file and restored
when you switch back), ⌘, opens Settings, ⌘/ comments, ⌘F finds, ⌘D selects
the next occurrence. To debug the engine itself, open `chrome://extensions`
and click the service worker / background page under *Inspect views*.
Double-click a script in the list to rename it (Enter saves, Esc cancels).
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

The script list moves too: drag its header (the **Wiretrick** title) to the
left or right edge of the window.

- **Log** — engine and script log lines with level and source filters. Script
  errors (exceptions in handlers, failed compiles) are logged at ERROR, and
  the script gets a ⚠ indicator in the list and the popup. TypeScript errors
  in a saved script also show up there. The download button (↓) saves the
  full debug log — every engine decision with timestamps; attach it when
  reporting issues.
- **Network** — a devtools-style request table: filter text, per-type
  toggles, a tab picker (closed tabs stay listed, dimmed under *Closed tabs*,
  until the log is cleared), "Intercepted only", sortable/resizable columns
  (right-click the header to pick columns) and a waterfall. Selecting a
  request shows its headers, request payload, the response body (modified
  and original, when Wiretrick handled it) and what each script did.

## Dedicated scripts folder

Click **Folder…** and pick a folder (e.g. `~/Wiretricks`) — that becomes your
scripts home. Connecting runs a two-way initial sync: `.ts` files without a
script are imported, scripts without a file are written out, and where both
exist but differ the newer one wins (file modified time vs. the script's last
save). The same reconcile runs on every reconnect and browser restart.
`wt-api.d.ts` and `tsconfig.json` are written alongside. Edit in VS Code (or any editor) with full
TypeScript completions; saves hot-reload into the engine instantly.

Sync is two-way and watches the folder for **creates, renames/moves and
deletes** too: a new `.ts` file becomes a script, deleting a file removes its
script, renaming a file renames the script. The folder choice is remembered —
the manager reconnects automatically on open (one click to re-grant after a
browser restart, per Chrome's File System Access rules — click the toolbar
notice or the button).

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
