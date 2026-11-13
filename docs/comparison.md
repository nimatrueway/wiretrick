# Feature comparison & prior art

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

TangiTweak sits at the intersection of **HTTP override extensions**, **userscript managers**, and **local intercepting proxies**: everything is written in TypeScript/TSX, combining network-level interception, page/DOM scripting, and isolated React + `valtio` UI overlays in one tool.

Below is a survey of existing browser tools, extensions, and desktop proxies in this space — ordered by popularity within each group — followed by a side-by-side feature matrix.

---

## Browser tools & extensions (ordered by popularity)

| Tool | Approximate reach | License / pricing | Focus & status |
| --- | --- | --- | --- |
| **[Chrome DevTools Local Overrides](https://developer.chrome.com/docs/devtools/overrides)** | Built into Chromium | Free (built-in) | Maps URLs and response headers to local files on disk. Zero install, but **only active while DevTools is open** on the tab and offers static file overrides rather than programmatic logic or page UIs. |
| **[Tampermonkey](https://www.tampermonkey.net/)** | ~12M Chrome users | Proprietary (free on Chrome/Firefox/Edge; paid on Safari) | The most popular `.user.js` userscript manager. Huge community script ecosystem and Safari support, focused on DOM/page JS injection rather than network/document interception. |
| **[Violentmonkey](https://violentmonkey.github.io/)** | ~1M Chrome users · ~12k+ ★ | Open source (MIT) | Lightweight, fully open-source `.user.js` userscript manager for Chromium and Firefox. |
| **[ModHeader](https://modheader.com/)** | ~900k Chrome / ~1.6M peak installs | Proprietary freemium | Request/response header profile switcher. *(Removed from the Chrome and Edge stores in July 2026.)* |
| **[Requestly](https://requestly.com/)** | ~300k+ Chrome users (+ desktop app) | Open-core freemium | Point-and-click rule builder for redirects, headers, API mocks, delays, and script injection; cloud workspaces and advanced capabilities on paid plans. |
| **[Header Editor](https://github.com/SYSTools/HeaderEditor)** | ~200k+ Chrome & Firefox users | Open source (GPL-2.0) | Lightweight rule UI for headers and redirects (`declarativeNetRequest` on Chrome MV3; full `webRequest` hooks on Firefox MV2). |
| **[Resource Override](https://github.com/kylepaulsen/ResourceOverride)** | ~200k+ peak Chrome users · ~500 ★ | Open source (MIT) | Classic URL → file / inline text / header rule list. *(Unmaintained and MV2-only; no longer runs on stable Chrome.)* |
| **[Greasemonkey](https://www.greasespot.net/)** | ~180k+ Firefox users | Open source (MIT) | The original `.user.js` userscript manager (Firefox-only). |
| **[tweak](https://tweak-extension.com/)** | ~70k–80k Chrome users | Proprietary freemium | In-browser `fetch`/XHR mock rules, request payload matching, and header overrides; custom JS scripting and live response body modification require the paid tier. |
| **[Inssman](https://github.com/vvmgev/Inssman)** | ~5k Chrome users · ~130 ★ | Open source (MIT) | Free MV3 GUI rule builder for redirects, blocks, headers, query parameters, and mocked API responses. |
| **[TangiTweak](https://github.com/tangistudio/TangiTweak)** | Early alpha | Open source (MIT) | Programmable TypeScript/TSX editor unifying five network interception strategies, `onSite` / `onPage` DOM hooks, isolated React + `valtio` page overlays, typed UI params, and two-way folder sync. |

---

## Desktop intercepting proxies (ordered by popularity)

Desktop proxies run outside the browser as local TLS man-in-the-middle servers. Unlike browser extensions, they can also inspect **mobile apps (iOS/Android), backend services, and CLI tools**, at the cost of running an external desktop app and managing system/browser proxy routing and root certificates.

| Tool | Approximate reach | License / pricing | Highlights |
| --- | --- | --- | --- |
| **[mitmproxy](https://mitmproxy.org/)** | ~45k ★ | Open source (MIT) | Terminal, CLI (`mitmdump`), and web (`mitmweb`) TLS proxy programmable with **Python** addons (HTTP/1, HTTP/2, HTTP/3, WebSockets). |
| **[Whistle](https://github.com/avwo/whistle)** | ~14k+ ★ | Open source (MIT) | Cross-platform Node.js web debugging proxy configured via concise hosts-like text rules and Node plugins. |
| **[HTTP Toolkit](https://httptoolkit.com/)** | ~13k+ ★ | Open-core freemium | One-click browser, Android, Docker, and CLI interception with traffic inspection and mock rules (automated rule scripting in Pro). |
| **[Charles Proxy](https://www.charlesproxy.com/)** | Industry standard (macOS/Win/Linux) | Commercial (perpetual license) | Mature GUI proxy with Map Local, Map Remote, Rewrite rules, bandwidth throttling, and breakpoints (no JS scripting). |
| **[Fiddler Classic / Everywhere](https://www.telerik.com/fiddler)** | Industry standard (Win / cross-platform) | Free (Classic on Windows) / Commercial (Everywhere) | Full HTTP/HTTPS inspector with AutoResponder rules and programmatic `FiddlerScript` (JScript.NET). |
| **[Proxyman](https://proxyman.com/)** | Popular on macOS (+ Win/Linux/iOS) | Commercial freemium | Native GUI proxy with Map Local/Remote, WebSocket editing, and built-in **JavaScript** `onRequest` / `onResponse` scripting. |

---

## Feature comparison matrix

| Capability | TangiTweak | Tampermonkey / Violentmonkey | Requestly / tweak / Inssman | Chrome DevTools Overrides | mitmproxy / Proxyman / Charles |
| --- | :---: | :---: | :---: | :---: | :---: |
| **100% free & open source** | **Yes (MIT)** | Violentmonkey (MIT) · Tampermonkey (No) | Inssman (MIT) · Requestly/tweak (Freemium) | Yes (built-in) | mitmproxy (MIT) · Proxyman/Charles (Paid) |
| **Chrome (MV3) + Firefox** | **Yes** | **Yes** (+ Safari on TM) | Yes | Chromium only | OS-wide (any browser) |
| **Works with DevTools closed** | **Yes** | **Yes** | **Yes** | No | **Yes** |
| **No-code GUI rule tables** | No (code-only) | No | **Yes** | **Yes** (file mapping) | **Yes** (Charles/Proxyman) |
| **Runs `.user.js` ecosystem** | No (`tt.*` API) | **Yes** | No | No | No |
| **Redirect, block & edit headers** | **Yes** | No | **Yes** | Response headers only | **Yes** |
| **Mock or transform `fetch` / XHR bodies** | **Yes** | Manual monkey-patching | **Yes** (transform paid in tweak) | Static local files only | **Yes** |
| **Rewrite HTML documents, `<script>` & workers without Chrome's debugger bar** | **Yes** (via optional `tangitweak-helper`) | No | Desktop app required on Chrome | Only while DevTools is open | **Yes** |
| **Programmatic body/header logic** | **TypeScript / TSX** | JavaScript (page-level) | JS rules (paid in tweak/Requestly tiers) | No | Python (`mitmproxy`) · JS (`Proxyman`) |
| **Embedded Monaco TS editor + IntelliSense** | **Yes** | Monaco JS (no network API types) | Basic code box | DevTools Sources | External / built-in JS/Python |
| **Multi-file bundles, relative imports & data files (`.json`, `.md`, `.svg`, images)** | **Yes** | `@require` / `@resource` URLs | No | Local folder tree | Python/JS modules |
| **Two-way local folder sync (edit in VS Code / Cursor with generated types)** | **Yes** | Single-file external editor sync | Local file map (desktop) | **Yes** | Script files on disk (`mitmproxy`) |
| **Page DOM & site-world hooks (`onPage` / `onSite`)** | **Yes** (with `ctx.patch` hot teardown) | **Yes** | Basic JS injection | No | No (must rewrite HTML) |
| **Isolated Shadow/iframe React + `valtio` page overlays (`onOverlay`)** | **Yes** (built-in) | Manual DOM + `@require` | No | No | No |
| **Typed UI settings (`tt.params` + `settings.json`)** | **Yes** (with nested sections) | `GM_config` libraries | Environment variables (paid) | No | Script env vars |
| **In-place hot reload without reloading the tab** | **Yes** | No (requires reload) | Rule toggle on next request | Next request | Next request |
| **In-extension Network diff (`Modified` vs `Original` body) + LLM diagnostics** | **Yes** | No | Basic logger | DevTools Network | **Yes** (full proxy inspector; no LLM bundle) |
| **Intercepts non-browser traffic (iOS, Android, CLI, backend)** | No (browser only) | No | Desktop app only | No | **Yes** |

---

## Which tool should you pick?

- **Pick Chrome DevTools Overrides** if you just want to edit one static JS/CSS/JSON response on a tab you already have DevTools open on, with nothing to install.
- **Pick Inssman, Requestly, or tweak** if you want a **point-and-click form UI** for static redirects, header rules, or canned mock JSON without writing TypeScript.
- **Pick Tampermonkey or Violentmonkey** if you want to install existing community **`.user.js` scripts** from Greasy Fork / GitHub, or if you need **Safari** support.
- **Pick mitmproxy, Proxyman, Charles, or HTTP Toolkit** if you need to inspect or rewrite traffic from **native desktop apps, iOS/Android devices, Docker containers, or CLI tools** outside the browser.
- **Pick TangiTweak** when rules outgrow forms and userscripts need real network power: writing typed **TypeScript/TSX** tools that intercept APIs and bundles, share live `valtio` state with custom **React overlays** on the page, expose clean settings in the popup, and sync two-way with a folder in your own editor.
