# Installing and sharing scripts

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

You share scripts as a **package**, which is one of two things:

- **A script.** One `.ts` or `.tsx` file, plus every file it imports by a
  relative path (`./lib`, `../shared/util.ts`, `./config.json`,
  `./icon.svg`), followed through those files too. Its `tt.metadata({ … })`
  call says what it is.
- **A bundle.** A folder whose `metadata.json` lists several scripts. They
  install, update and roll back together, along with what they import.

Either way, the routes say what it can do.

## Metadata

A script describes itself with `tt.metadata`, called once at top level. The
install page reads it when it compiles the script, before anything is
installed:

```ts
tt.metadata({
    name: "GitHub dark mode",
    version: "1.2.0",
    description: "Forces the dark theme on github.com",
    icon: "./icon.svg",
    author: "me",
    license: "MIT",
    homepage: "https://github.com/me/scripts",
    updateURL: "https://github.com/me/scripts/blob/main/dark.tangitweak.ts",
    connect: ["api.github.com"],
});
tt.onPage({ url: "*://github.com/*" }, () => { … });
```

Every field is optional. `description` is also the script's tooltip in the Editor and the popup.
`icon` sets a custom icon shown in the Explorer and the popup: pass a relative file path (`.svg`, `.png`, `.webp`, `.jpg`, `.gif`, `.ico`, `.avif`), a `data:` or `https://` URL, or inline `<svg>` markup.
`version` is compared part by part (`1.10.0` is newer than `1.9`).
`connect` lists the hosts the script's `tt.fetch` calls reach. An update that
adds one waits for your approval.
`updateURL` is where updates come from, instead of where the package was
installed from. It takes any URL the install page reads, as listed in the table under
[Install a package](#install-a-package): a script, `metadata.json` or `.zip` URL, a GitHub
file or folder, a gist, or a gist's raw file. See [Updates](#updates).

A bundle's `metadata.json` has the same fields plus `scripts`, the bundle's
scripts relative to its folder:

```json
{
    "name": "PR tools",
    "version": "2.0.0",
    "description": "Review helpers for GitHub pull requests",
    "connect": ["api.github.com"],
    "scripts": ["pr-tools.ts", "review/diff.ts"]
}
```

The Editor checks `metadata.json` against its schema and completes its
fields; in `scripts` it completes the `.ts`/`.tsx` files in the folder (and
its subfolders) that aren't listed yet, and an entry naming no script there
is an error (in the file and in Problems). A bundle's scripts can still call `tt.metadata`: their
`description` stays their own tooltip, and their `connect` hosts add to the
bundle's. Files outside the bundle's folder can't be imported.

## Install a package

- **Open its URL.** A tab that opens a URL ending in `.tangitweak.ts` (or
  `.tangitweak.tsx`), or any supported package/bundle URL ending in
  `#tangitweak:install` (for example
  `https://github.com/me/my-bundle#tangitweak:install` in a GitHub `README.md`),
  goes to TangiTweak's install page. That covers a link on
  a site, a GitHub repository or folder, a raw GitHub or gist file, a URL you type, or a local `file://`
  path. For local files, turn on **Allow access to file URLs** for
  TangiTweak in the browser's extension settings. Without `#tangitweak:install`, GitHub's own page for a file
  (`github.com/…/blob/…`) stays as it is. Add `#tt-raw` to any URL to just
  view the file. The suffix only marks share links: the script runs
  whatever it's named.
- **From the Explorer.** The **Install Script…** button (a document with a down arrow), or
  right-click the empty area → **Install Script…**, opens the install dialog
  in the Editor. There you can paste a URL, choose a folder or choose a
  `.zip`.
- **Drag and drop.** Drop a link, a script file (`.ts`), a `metadata.json`, a
  folder or a `.zip` onto the install dialog or the install page. Dropping one
  onto the Explorer opens the dialog with it. A dropped folder's
  `node_modules` and `.git` are skipped.

The install dialog and page accept:

| Source | Example | Updates from |
| --- | --- | --- |
| A GitHub file | `https://github.com/me/scripts/blob/main/dark.ts`, `https://raw.githubusercontent.com/me/scripts/main/kit/metadata.json` | the branch or tag (each update is pinned to a commit) |
| A GitHub folder | `https://github.com/me/scripts/tree/main/kit`, `https://github.com/me/dark-mode` | the same |
| A gist | `https://gist.github.com/me/0123abcd` | the gist's latest revision |
| A gist's file | `https://gist.githubusercontent.com/me/0123abcd/raw/dark.tangitweak.ts` | the same |
| Any other URL of a script or `metadata.json` | `https://example.com/tools/dark.tangitweak.ts`, `file:///home/me/kit/metadata.json` | the same URL; imports are read next to it |
| A `.zip` URL | `https://example.com/kit.zip`, a release asset, `https://github.com/me/kit/archive/refs/heads/main.zip` | the same URL |
| A folder | **Choose a folder…** | its `updateURL`, if any |
| A `.zip` file | **Choose a .zip…** | its `updateURL`, if any |

Each package's `updateURL` overrides the **Updates from** column.

A zip of a single folder counts as that folder. A folder, gist or zip installs its `metadata.json`. Without one, it installs
its single `*.tangitweak.ts` file, or else its single script. When a local
folder or zip holds several scripts at its top level and no `metadata.json`,
the page asks which one to install. A zip URL needs a `metadata.json` or a
single script at its top level. A package holds at most 200 files and
5 MB.

Before anything is written, the page shows:

- the metadata: name, version, description, author, license and homepage,
  where it updates from when `updateURL` names another place, and a bundle's scripts;
- **what it can do**, riskiest first:
  - running on every site;
  - the `debugger` strategy;
  - running code in the site's JavaScript world (`tt.onSite`);
  - the `helper` strategy;
  - the sites it runs on;
  - the other strategies;
  - overlays;
  - the hosts it fetches from (`connect`);
  - the [unpkg packages](scripting.md#packages-from-unpkg) it imports;
- warnings: a compile error (it can't be installed), imports it couldn't
  find, and bare imports (below);
- the files, each one expandable.

**Install** writes the files and turns the scripts on. **Install turned
off** writes them with the scripts off. **Keep it up to date** (on by default
for URL installs) turns on auto-update.

If a script or bundle with the same name (or source) already exists in the
Explorer, the review shows the installed vs. incoming version and a line-by-line
diff of every changed, added, or removed file, and asks whether to **Upgrade**
it in place (preserving your settings and parameter values, with **Roll Back**
available afterwards) or **Install as “… (2)”** alongside it.

## Where it goes

A script that imports nothing lands at the root of the Explorer under its
file name (`dark.ts`, or `dark (2).ts` when the name is taken). Anything
bigger gets a folder (`dark/`, or `dark (2)/`). A bundle's folder is named
after its `name`; a script's after its file. The files keep their paths in
the package:

```text
PR tools/
├── metadata.json
├── pr-tools.ts
├── review/
│   └── diff.ts
└── lib/
    └── github.ts
```

They are ordinary scripts and data files: open, edit, enable, rename and move
them as usual. The Explorer shows a package's folder with a box icon, and an
installed script that imports nothing with 📦. Hover either for the source,
version and update state.

Imports that don't start with `./` or `../` (bare imports like `"utils"`)
aren't part of the package. They resolve against your own scripts from the
Explorer's root, as they do for any script, and the install page warns about
each one. A package meant for others should import its own files by
relative paths.

## Updates

A package installed from a URL with auto-update on is checked once a day. It
is also checked when the browser starts, if the last check is more than a
day old. Right-click the package's folder or script → **Check for Updates**
checks it now. A `file://` package is read again whenever the Editor's window
gains focus. A bundle updates as one: all its scripts, or none.

When the installed version's metadata has an `updateURL`, updates come from
there instead of from where the package was installed from. A package
installed from a folder or zip updates only this way. Without an
`updateURL`, it doesn't update. If the files at the new place match the installed ones,
nothing changes.

An update applies by itself only when all of these hold:

- it can't do more than the installed version: no new sites, strategies,
  `tt.onSite` code, overlays, `connect` hosts or unpkg packages;
- you haven't edited, renamed or deleted any of the package's files;
- its `version` doesn't go down;
- it doesn't change where updates come from (its `updateURL`);
- it compiles.

Otherwise it waits for review. The Explorer shows ⬆ on the package (click
it, or right-click → **Review Update…**) and the Log says why. The review
(a dialog in the Editor) lists what the update adds and why it waited, and shows each changed
file as a diff. **Update** applies it. **Skip this version** keeps the
installed one, and later checks don't offer that revision again. An update
that doesn't compile is never applied; the package's tooltip says why.

Updating keeps each file's identity, so parameter values and enabled state
stay. Files the new version no longer has are deleted. Files you edited are
replaced by the update's, so review the diff before you apply it.

Right-click a package's folder or script for:

- **Review Update…**, when one waits;
- **Check for Updates**;
- **Turn Auto-Update On/Off**;
- **Roll Back to …**, which restores the version before the last update and
  turns auto-update off (turn it back on to take updates again);
- **Open Source Page**, for URL packages;
- **Forget Package (Keep Files)**, which stops tracking it; the files stay
  as ordinary scripts. Deleting the package's scripts forgets it too.

## Sharing scripts

- **One script:** put it anywhere with a URL (a gist, a GitHub repository,
  any web server) and share that URL. Name it `name.tangitweak.ts` so that
  opening the link installs it.
- **A script with files it imports:** put them in a folder and share the
  script's URL, or the folder's `github.com/…/tree/…` URL.
- **Several scripts that go together:** put them in a folder with a
  `metadata.json` that lists them. Share the `metadata.json` URL or the
  folder's URL; whoever installs it gets all of them and their updates
  together.

A zip of the folder works for people installing from local files.

**Make Package…** (right-click a script or a folder in the Explorer) lays a
package out for you:

- **On a script that imports nothing**, it adds `name` and `version` (and
  `connect`, for the hosts of `tt.fetch` calls with a literal URL) to its
  `tt.metadata` call, or adds the call.
- **On a script that imports files**, it makes a bundle. The script and every
  file it imports by a relative path move into a folder named after it, and
  a `metadata.json` lists the script. Their layout under the script's folder
  is kept. A file that other scripts still use is copied instead of moved.
  The imports are rewritten for the new places. A script already alone in its
  folder with what it imports stays where it is.
- **On a folder**, it adds a `metadata.json` that lists the folder's scripts
  that no other file there imports.

The confirmation lists every move and copy. It warns about imports by bare
name (they resolve from the installer's root, not the package), imports that
point at no file, and, for a folder, files it imports from outside. A folder
holding a `metadata.json` shows as a package (a box icon).

**Export Package…** (right-click a package's folder or a script) downloads the
package as saved. A script that imports nothing downloads as its `.ts` file.
Anything more downloads as a `.zip` of a folder. Either installs with
**Install Script…**.

A [synced folder](editor.md#synced-folder) holds your scripts as files, so a
package folder there can be committed to a repository as is.
