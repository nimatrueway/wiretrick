# Wiretrick

Rewrite any request or response in your browser with a few lines of
TypeScript. Wiretrick is a ground-up rewrite of
[Resource Override](https://github.com/kylepaulsen/ResourceOverride) where the
whole interface is a **script editor**: each script declares the URLs it
matches and what to do — redirect, cancel, edit headers, transform or replace
bodies, or patch the DOM.

![Wiretrick manager](docs/shots/manager.png)

## Features

- **Scripts, not rule lists** — Monaco editor with IntelliSense, type checking,
  per-script enable toggles and adjustable parameters.
- **Every kind of interception** — page fetch/XHR, documents, `<script>`,
  images and workers, through four [strategies](docs/strategies.md) you can
  rank per script.
- **No debugger banner needed** — the optional [local helper](docs/process-helper.md)
  intercepts at network level on Chrome without the "being debugged" bar.
- **Built-in devtools** — Log and Network panels show what every script did,
  including original vs. modified bodies.
- **Folder sync** — keep scripts as plain files in a folder of your choice.
- **Chrome (MV3), MV2 Chromium and Firefox.**

## Install

1. Download a zip from [Releases](https://github.com/nimatrueway/wiretrick/releases):
   `wiretrick-mv3-vX.Y.Z.zip` for current Chrome / Edge / Brave, or
   `wiretrick-vX.Y.Z.zip` for Firefox and MV2-capable Chromium.
2. Unzip, open `chrome://extensions` (Firefox: `about:debugging#/runtime/this-firefox`),
   enable **Developer mode** and **Load unpacked** the folder.
3. Pin the icon — its badge counts the scripts active on the current tab.

Signed `.crx` packages, building from source and the optional helper:
see [docs/install.md](docs/install.md).

## Quick start

Open the manager (popup → **Manage all**), click **+ New** and paste:

```ts
// Try it: open https://jsonplaceholder.typicode.com/todos/1
wt.declareScript({
    match: ["*://jsonplaceholder.typicode.com/todos/*"],
});

wt.modifyResponse((ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const json = JSON.parse(text);
    json.title = "Transformed by Wiretrick";
    return JSON.stringify(json, null, 2);
});
```

Or click **Samples** for one-click starters against real public sites.

![Wiretrick samples dialog](docs/shots/samples.png)

## Documentation

| | |
|---|---|
| [Installing](docs/install.md) | release zips, signed crx, building from source |
| [Writing scripts](docs/scripting.md) | the `wt` API, parameters, libraries, `onDom`, stacking, async handlers |
| [Interception strategies](docs/strategies.md) | `hook` / `cdp` / `webrequest` / `process`, priority lists, browser compatibility |
| [Local helper](docs/process-helper.md) | the `process` strategy: install, how it works, security notes |
| [The manager](docs/manager.md) | editor, Log & Network panels, folder sync, `settings.yaml` |
| [Development](docs/development.md) | build, tests, releases, how the MV3 build works |

## License

[MIT](LICENSE)
