# Installing

[← README](../README.md) · [Glossary](../GLOSSARY.md)

## From a release (recommended)

1. Grab a zip from [Releases](https://github.com/nimatrueway/tangitweak/releases) and unzip it:
   `tangitweak-mv3-vX.Y.Z.zip` for current Chrome / Edge / Brave, or
   `tangitweak-mv2-vX.Y.Z.zip` (its `dist` folder) for MV2-capable Chromium.
   Firefox uses the `.xpi` instead — see [Firefox](#firefox).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right), click **Load unpacked**, and select the unzipped folder.
4. Pin the 🧩 icon — the badge shows how many scripts are active on the current tab: a network handler matched one of its requests, or `onPage` code ran on it (a script saved while the page is open counts once its code runs there — an `onPage` script that only runs at `document_start` waits for the next load). The popup marks them with a green dot. The badge turns red when one of them has an error and amber for a warning; hover the icon for the list, and see **Problems** in the Editor. While a saved script is compiled and hot-reloaded, the icon fades and shows a spinner.

## Firefox

Each release ships `tangitweak-firefox-vX.Y.Z.xpi` (add-on id
`tangitweak@nimatrueway`). When the release was signed through AMO, drag the
file onto Firefox to install it. An unsigned `.xpi` (the release notes say
which) installs permanently only on Developer Edition, Nightly or ESR with
`xpinstall.signatures.required` set to `false` in `about:config`; on regular
Firefox load it via `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on…** (removed on restart).

Maintainers: signing runs when the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`
repository secrets hold AMO API credentials
(<https://addons.mozilla.org/developers/addon/api/key/>); it signs as an
unlisted (self-distributed) add-on.

## Signed `.crx`

Each release also ships signed `tangitweak-mv3-vX.Y.Z.crx` / `tangitweak-mv2-vX.Y.Z.crx`
packages with a fixed extension id (`jcoealmhehnajkglhfchcnjdpkhnkdei`). Chrome
keeps a `.crx` from outside the Web Store enabled only when it's allowed by
enterprise policy (`ExtensionInstallAllowlist` / `ExtensionInstallForcelist`,
pointing at that id) or on Linux via drag-and-drop onto `chrome://extensions`
in Developer mode; otherwise use the zip.

## From source

```bash
git clone https://github.com/nimatrueway/tangitweak.git
cd tangitweak
npm install && npm run build
# then: chrome://extensions → Developer mode → Load unpacked → dist/
```

> `dist/` needs an MV2-capable Chromium (ungoogled-chromium or any Chromium ≤ ~126) or
> Firefox. Modern stable Chrome removed MV2 — load `dist-mv3/` there instead
> (see [Compatibility](strategies.md#compatibility)).

**Releases are automated** — pushing a `vX.Y.Z` tag runs the GitHub Action

## Optional: local helper

The [`helper` strategy](local-helper.md) needs a small native helper.
Settings → Local helper shows a one-line install command with your extension
id filled in; see [local-helper.md](local-helper.md#install).
