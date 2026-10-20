# The manager

[← README](../README.md)

The manager page embeds **Monaco** (the VS Code editor) with full TypeScript
IntelliSense for the `wt` API — completions, hover docs, and diagnostics work
out of the box. Cmd/Ctrl+S saves and hot-applies the script; ⌘P quick-opens
scripts/settings.yaml (cursor position is remembered per file and restored
when you switch back), ⌘, opens Settings, ⌘/ comments, ⌘F finds, ⌘D selects
the next occurrence. The 🐞 button in the toolbar opens `chrome://extensions`
— click **background page** under *Inspect views* to debug the engine (MV2
has no API to open DevTools for the live background page programmatically).
Reverting an edit back to the saved text (or the name to the stored one)
clears the unsaved-changes state — no discard prompt on a no-op edit.

## Log and Network panels

The bottom panel (drag its edge to resize; it can also dock to the right)
has two tabs:

- **Log** — engine and script log lines with level and source filters. Script
  errors (exceptions in handlers, failed compiles) are logged at ERROR, and
  the script gets a ⚠ indicator in the list and the popup. TypeScript errors
  in a saved script also show up there. The **⬇ download** button saves the
  full debug log — every engine decision with timestamps; attach it when
  reporting issues.
- **Network** — a devtools-style request table: filter text, per-type
  toggles, a tab picker, "Intercepted only", sortable/resizable columns
  (right-click the header to pick columns) and a waterfall. Selecting a
  request shows its headers, request payload, the response body (modified
  and original, when Wiretrick handled it) and what each script did.

## Dedicated scripts folder

Click **Folder…** and pick a folder (e.g. `~/Wiretricks`) — that becomes your
scripts home: every script is written there as a `.ts` file along with
`wt-api.d.ts` and `jsconfig.json`. Edit in VS Code (or any editor) with full
TypeScript completions; saves hot-reload into the engine instantly.

Sync is two-way and watches the folder for **creates, renames/moves and
deletes** too: a new `.ts` file becomes a script, deleting a file removes its
script, renaming a file renames the script. The folder choice is remembered —
the manager reconnects automatically on open (one click to re-grant after a
browser restart, per Chrome's File System Access rules).

## `settings.yaml`

The script list always has a ⚙ **settings.yaml** entry (no folder needed; no
toggle, not deletable). It is generated from storage: global settings plus
every script's params and `enabled` state. Saving it in the editor applies it
(syntax errors show in the editor status and change nothing). Popup/list
changes patch the matching entries. With a scripts folder connected the same
file is mirrored to `settings.yaml` there and edits sync both ways.

The file starts with a `# yaml-language-server: $schema=./settings.schema.json`
modeline and the folder sync writes that schema next to it, so VS Code's YAML
extension validates the file as you edit it.

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
