# Installing

[← README](../README.md)

## From a release (recommended)

1. Grab a zip from [Releases](https://github.com/nimatrueway/wiretrick/releases) and unzip it:
   `wiretrick-mv3-vX.Y.Z.zip` for current Chrome / Edge / Brave, or
   `wiretrick-vX.Y.Z.zip` (its `dist` folder) for Firefox and MV2-capable Chromium.
2. Open `chrome://extensions` (or `about:debugging#/runtime/this-firefox` on Firefox).
3. Enable **Developer mode** (top-right), click **Load unpacked**, and select the unzipped folder.
4. Pin the 🧩 icon — the badge shows how many scripts are active on the current tab.

## Signed `.crx`

Each release also ships signed `wiretrick-mv3-vX.Y.Z.crx` / `wiretrick-vX.Y.Z.crx`
packages with a fixed extension id (`jcoealmhehnajkglhfchcnjdpkhnkdei`). Chrome
keeps a `.crx` from outside the Web Store enabled only when it's allowed by
enterprise policy (`ExtensionInstallAllowlist` / `ExtensionInstallForcelist`,
pointing at that id) or on Linux via drag-and-drop onto `chrome://extensions`
in Developer mode; otherwise use the zip.

## From source

```bash
git clone https://github.com/nimatrueway/wiretrick.git
cd wiretrick
npm install && npm run build
# then: chrome://extensions → Developer mode → Load unpacked → dist/
```

> `dist/` needs an MV2-capable Chromium (ungoogled-chromium or any Chromium ≤ ~126) or
> Firefox. Modern stable Chrome removed MV2 — load `dist-mv3/` there instead
> (see [Compatibility](strategies.md#compatibility)).

**Releases are automated** — pushing a `vX.Y.Z` tag runs the GitHub Action

## Optional: local helper

The [`process` strategy](process-helper.md) needs a small native helper.
Settings → Local helper shows a one-line install command with your extension
id filled in; see [process-helper.md](process-helper.md#install).
