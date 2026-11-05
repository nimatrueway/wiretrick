# Installing and sharing scripts

A script you share is a **package**: its entry file (`*.wiretrick.ts` or
`*.wiretrick.tsx`) plus every file it imports by a relative path (`./lib`,
`../shared/util.ts`, `./config.json`, `./icon.svg`), followed through those
files too. A script that imports nothing is a one-file package. There's no
manifest: the entry's header says what it is, and its routes say what it can do.

## Install a script

- **Open its URL.** Any tab that opens a URL ending in `.wiretrick.ts`
  (or `.wiretrick.tsx`) goes to Wiretrick's install page: a link on a site,
  a raw GitHub or gist file, a URL you type, or a local `file://` path (for
  local files, turn on **Allow access to file URLs** for Wiretrick in the
  browser's extension settings). GitHub's own page for a file
  (`github.com/…/blob/…`) stays as it is; add `#wt-raw` to any URL to just
  view the file.
- **From the Explorer.** The Explorer's **Install Script…** button (or
  right-click the empty area → **Install Script…**) opens the install page,
  where you can paste a URL, choose a folder or choose a `.zip`.

The install page accepts:

| Source | Example | Updates from |
| --- | --- | --- |
| A GitHub file | `https://github.com/me/scripts/blob/main/dark/dark.wiretrick.ts`, `https://raw.githubusercontent.com/me/scripts/main/dark/dark.wiretrick.ts` | the branch or tag (each update is pinned to a commit) |
| A GitHub folder holding one entry | `https://github.com/me/scripts/tree/main/dark`, `https://github.com/me/dark-mode` | the same |
| A gist | `https://gist.github.com/me/0123abcd` (its one `*.wiretrick.ts` file) | the gist's latest revision |
| Any other URL of the entry | `https://example.com/tools/dark.wiretrick.ts`, `file:///home/me/scripts/dark.wiretrick.ts` | the same URL; its imports are read next to it |
| A folder | **Choose a folder…** | — |
| A `.zip` | **Choose a .zip…** (a zip of one folder works too) | — |

When a folder or zip holds several entries at its top level, the page asks
which one to install. A package holds at most 200 files and 5 MB.

Before anything is written, the page shows:

- the header: name, version, description, author, license and homepage;
- **what it can do**, riskiest first: running on every site, running overlay
  code in the site's world (`unsafe: true`), the `debugger` strategy, running
  code in the site's JavaScript world, the `helper` strategy, the sites it
  runs on, the other strategies, overlays, the hosts it fetches from
  (`@connect`) and the [unpkg packages](scripting.md#packages-from-unpkg) it
  imports;
- warnings: a compile error (it can't be installed), imports it couldn't find,
  and bare imports (below);
- the files, each one expandable.

**Install** writes the files and turns the entry on; **Install turned off**
writes them with the entry off. **Keep it up to date** (on by default for URL
installs) turns on auto-update.

## Where it goes

A one-file package lands at the root of the Explorer as the entry
(`dark.wiretrick.ts`; `dark (2).wiretrick.ts` when the name is taken). A
package with more files gets a folder named after its entry (`dark/`, or
`dark (2)/`), holding the files at their paths in the package:

```text
dark/
├── dark.wiretrick.ts
├── lib/
│   └── colors.ts
└── palette.json
```

They are ordinary scripts and data files: open, edit, enable, rename and move
them as usual. The Explorer shows the package's folder with a box icon (a
one-file package's entry with 📦); hover it for the source, version and
update state.

Imports that don't start with `./` or `../` (bare imports like `"utils"`)
aren't part of the package: they resolve against your own scripts from the
Explorer's root, as they do for any script, and the install page warns about
each one. A package meant for others should import its own files by relative
paths.

## The header

The entry's leading `/** … */` block describes the package. The install page
reads it without running any code:

```ts
/**
 * @name GitHub dark mode
 * @version 1.2.0
 * @description Forces the dark theme on github.com
 * @author me
 * @license MIT
 * @homepage https://github.com/me/scripts
 * @connect api.github.com
 */
wt.onPage({ url: "*://github.com/*" }, () => { … });
```

All tags are optional. `@version` is compared part by part (`1.10.0` is newer
than `1.9`). `@connect` names the hosts the script's `wt.fetch` calls reach
(repeat it, or list several separated by spaces); an update that adds one
waits for your approval. `@description` is also the script's description
when it has no `wt.about`.

## Updates

A package installed from a URL with auto-update on is checked once a day
(and when the browser starts, if the last check is more than a day old).
Right-click the package's folder or entry → **Check for Updates** checks it
now. A `file://` package is read again whenever the Editor's window gains
focus. Packages installed from a folder or zip don't update.

An update applies by itself only when all of these hold:

- it can't do more than the installed version: no new sites, strategies,
  page-world code, overlays, `unsafe: true`, `@connect` hosts or unpkg
  packages;
- you haven't edited, renamed or deleted any of the package's files;
- its `@version` doesn't go down;
- it compiles.

Otherwise it waits for review: the Explorer shows ⬆ on the package (click it,
or right-click → **Review Update…**) and the Log says why. The review page
lists what the update adds and the reasons it waited, and shows each changed
file as a diff. **Update** applies it; **Skip this version** keeps the
installed one, and later checks don't offer that revision again. An update
that doesn't compile is never applied; the package's tooltip says why.

Updating keeps each file's identity: parameter values and enabled state
stay. Files the new version no longer has are deleted. Files
you edited are replaced by the update's, so review the diff before you
apply it.

Right-click a package's folder or entry for:

- **Review Update…** — when one waits;
- **Check for Updates**;
- **Turn Auto-Update On/Off**;
- **Roll Back to …** — restores the version before the last update and
  turns auto-update off (turn it back on to take updates again);
- **Open Source Page** — for URL packages;
- **Forget Package (Keep Files)** — stops tracking it; the files stay as
  ordinary scripts. Deleting the entry forgets the package too.

## Sharing a script

- **One file:** put `name.wiretrick.ts` anywhere with a URL — a gist, a
  GitHub repository, any web server — and share that URL.
- **Several files:** put the entry and the files it imports in a folder
  (in a GitHub repository, its own folder or the repository's root) and share
  the entry's URL, or the folder's `github.com/…/tree/…` URL. A zip of the
  folder works for people installing from local files.

**Make Package…** (right-click an entry script in the Explorer) lays one out
for you: it moves the entry and every file it imports by a relative path into
a folder named after the entry — keeping their layout under the entry's
folder, copying a file other scripts still use instead of moving it — rewrites
the imports for the new places and adds a header (`@name`, `@version 1.0.0`,
`@description`, and `@connect` for the hosts of `wt.fetch` calls with a
literal URL). The confirmation lists every move and copy, and warns about
imports by bare name (they resolve from the installer's root, not the
package) and imports that point at no file. An entry already alone in its
folder with everything it imports only gets the header. A folder holding one
entry with a header `@name` shows as a package (a box icon).

**Export Package…** (right-click a package's folder or an entry script)
downloads the entry and every file it imports by a relative path, as saved: a
one-file package as its `.wiretrick.ts`, more as a `.zip` of a folder named
after the entry — either installs with **Install Script…**.

A [synced folder](editor.md#synced-folder) holds your scripts as files, so a
package folder there can be committed to a repository as is.
