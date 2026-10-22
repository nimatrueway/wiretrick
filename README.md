<p align="center"><img src="icons/icon.svg" width="96" alt="Wiretrick icon"></p>

<h1 align="center">Wiretrick</h1>

Rewrite any request or response in your browser with a few lines of
TypeScript. Wiretrick is a ground-up rewrite of
[Resource Override](https://github.com/kylepaulsen/ResourceOverride) where the
whole interface is a **script editor**: each handler in a script names the
URLs it handles and what to do — redirect, cancel, edit headers, transform or
replace bodies, or patch the DOM.

![Wiretrick manager](docs/shots/manager.png)

## Features

- **Scripts, not rule lists** — Monaco editor with IntelliSense, type checking,
  per-script enable toggles and adjustable parameters.
- **Every kind of interception** — page fetch/XHR, documents, `<script>`,
  images and workers, through four [strategies](docs/strategies.md): one
  default in Settings, overridable per handler. `hook` is the lightest but
  only sees fetch/XHR (REST) calls; use `process`, `webrequest` or `cdp` for
  robust interception.
- **No debugger banner needed** — the optional [local helper](docs/process-helper.md)
  intercepts at network level on Chrome without the "being debugged" bar.
- **Built-in devtools** — Log and Network panels show what every script did,
  including original vs. modified bodies.
- **Folder sync** — keep scripts as plain files in a folder of your choice.
- **Chrome (MV3), MV2 Chromium and Firefox.**

## Install

1. Download from [Releases](https://github.com/nimatrueway/wiretrick/releases):
   `wiretrick-mv3-vX.Y.Z.zip` for current Chrome / Edge / Brave,
   `wiretrick-firefox-vX.Y.Z.xpi` for Firefox, or
   `wiretrick-mv2-vX.Y.Z.zip` for MV2-capable Chromium.
2. Chromium: unzip, open `chrome://extensions`, enable **Developer mode** and
   **Load unpacked** the folder. Firefox: drag the `.xpi` onto Firefox (see
   [docs/install.md](docs/install.md#firefox) if it's unsigned).
3. Pin the icon — its badge counts the scripts active on the current tab.

Signed `.crx` packages, building from source and the optional helper:
see [docs/install.md](docs/install.md).

## Quick start

Open the manager (popup → **Manage all**), click **+ New** and paste:

```ts
// Try it: open https://jsonplaceholder.typicode.com/todos/1
wt.modifyResponse("*://jsonplaceholder.typicode.com/todos/*", (ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const json = JSON.parse(text);
    json.title = "Transformed by Wiretrick";
    return JSON.stringify(json, null, 2);
});
```

Or click **?** → **Samples** for one-click starters against real public sites.

![Wiretrick samples dialog](docs/shots/samples.png)

## Documentation

| | |
|---|---|
| [Installing](docs/install.md) | release zips, signed crx, building from source |
| [Writing scripts](docs/scripting.md) | the `wt` API, routes, parameters, utilities, `onDom`, stacking, async handlers |
| [Interception strategies](docs/strategies.md) | `hook` / `cdp` / `webrequest` / `process`, the default and per-handler choice, [which tiers keep the URL when replacing a response](docs/strategies.md#how-each-tier-serves-a-replacement), the “never ran” warning, browser compatibility |
| [Local helper](docs/process-helper.md) | the `process` strategy: install, how it works, security notes |
| [The manager](docs/manager.md) | editor, Log & Network panels, folder sync, `settings.yaml` |
| [Development](docs/development.md) | build, tests, releases, how the MV3 build works |

## License

[MIT](LICENSE)
