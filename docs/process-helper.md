# Local helper (strategy `"process"`)

[← README](../README.md) · [Glossary](../GLOSSARY.md)

`wiretrick-helper` is a small (~3 MB) Rust program for Linux, macOS and
Windows. Chrome starts it through **native messaging** when an enabled
script has a handler on the `process` strategy (the Chromium default — see
[strategies](strategies.md)), and it exits when no such handler is left (or
Chrome closes):

1. It listens on `127.0.0.1:<random port>` as an HTTP/HTTPS proxy. HTTPS is
   terminated with per-host certificates from its own local CA, minted once
   and cached.
2. The extension installs a `chrome.proxy` PAC script that sends **only the
   hosts in the routes of `process` handlers** to the helper. Everything else
   goes exactly where your proxy setting sent it before (direct, fixed
   servers, your PAC, auto-detect, or the system proxy).
3. The helper pauses matching requests and responses and asks the extension.
   It tests each URL against the same route
   [URLPatterns](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)
   as the extension (`<all_urls>` matches everything), and checks the
   routes' `exclude` and `methods` itself, so those requests never reach
   the extension. `types` is checked extension-side, after the pause. TLS
   to a host no pattern's hostname/port can match is tunneled untouched.
   Your handlers run in the background page (MV2) or the sandbox (MV3), the
   same code paths as the other strategies. The extension answers continue,
   fulfill, redirect or fail. Requests nobody listens to are not paused, and
   bodies are buffered only for `modifyResponse` handlers.
4. The helper's own upstream connection follows your proxy setting too. It
   asks the extension per host, so your PAC/fixed proxies are honored even
   for intercepted traffic.

## Install

Once per machine. Settings → Local helper shows this command
with your extension id filled in, plus a **Copy install command** button. It
downloads the right binary from the latest GitHub release, checks it against
the release's `SHA256SUMS`, and runs `wiretrick-helper install`:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/nimatrueway/wiretrick/master/helper/install.sh | sh -s -- --extension-id <extension id> --trust-ca
```

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nimatrueway/wiretrick/master/helper/install.ps1))) -ExtensionId <extension id> -TrustCa
```

Then click Retry in Settings → Local helper (or reload the extension).
`WIRETRICK_HELPER_VERSION=v1.2.3` pins a release. With a binary you already
have, run `wiretrick-helper install --extension-id <extension id> --trust-ca`.
The installer copies the helper to `<config dir>/bin` and registers it there.

`--trust-ca` adds the helper's CA to the user's trust store: the login
keychain on macOS, CurrentUser\Root on Windows, and the NSS db
(`~/.pki/nssdb`, needs `certutil`) on Linux. Restart Chrome afterwards. Other
commands: `trust-ca`, `untrust-ca`, `uninstall`, and `--help`. Release builds
are attached to each GitHub release. To build from source, run
`npm run build:helper` (Rust ≥ 1.85).

## Upgrading

The browser updates the extension but not the helper. The helper is
versioned on its own and the extension declares the oldest helper it works
with, so most extension updates need no helper upgrade. When one is needed,
Wiretrick logs an error with the install command
and Settings → Local helper shows it with a **Copy install command** button.
Re-run the command, then click **Retry** to restart the helper on the new
binary.

## Things to know

- The CA's private key stays in the helper's config dir
  (`$XDG_CONFIG_HOME/wiretrick-helper`, `~/Library/Application Support/wiretrick-helper`,
  or `%APPDATA%\wiretrick-helper`). It is generated on your machine and never
  leaves it. Anyone who can read it can impersonate sites to this browser
  profile, so treat it like a password. `untrust-ca` removes trust.
- Sites that pin certificates or require client certificates (mTLS) fail
  through the helper. Leave them out of `process` routes (use another
  `strategy` on that handler).
- When another extension or an enterprise policy controls the proxy setting,
  the strategy stays unavailable (shown in Settings). Handlers on `process` then don't
  run — there is no fallback; the Log warns and the script gets a ⚠. Pick
  another default strategy in Settings → Interception, or set `strategy`
  on the route.
- Firefox doesn't need it: `webrequest` already gives the same reach there.
- Responses rewritten by the helper are served `no-store`. The browser cache
  for literal hosts in `process` routes is cleared when the routed set changes, so
  stale cached copies don't skip your handlers.
- Overhead: requests to unmatched hosts don't touch the helper at all. Matched
  hosts add one loopback hop. With a `modifyResponse` handler, the e2e suite
  measures about 10 ms per navigation.
