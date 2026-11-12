# Privacy policy

Last updated: 2026-11-11

TangiTweak is a developer tool that runs scripts you write or install to read
and change your browser's network requests and responses. This page explains
what it accesses, where that data goes, and why.

## Summary

- TangiTweak has no server. It collects no analytics, telemetry, crash reports
  or usage data, and sends nothing to the developer.
- Your scripts, their settings and their stored data stay in your browser's
  extension storage, or in a folder on your computer if you turn on folder
  sync.
- TangiTweak doesn't sell or share data, and doesn't use it for advertising,
  credit decisions or anything unrelated to running your scripts.

## What TangiTweak accesses

To do its job, TangiTweak can see the requests and responses of the sites your
scripts target: URLs, headers, bodies, cookies sent in headers, and page
content. It only acts on what your enabled scripts ask for. This data is
handled on your device, by your scripts, and is not sent anywhere unless a
script you run sends it (see below).

The Log and Network views keep a short history of requests and of what your
scripts did, in memory and in the browser's session storage, so you can
debug. It's cleared when the browser closes.

## Where data is stored

- **Extension storage** (`chrome.storage.local` and `chrome.storage.session`):
  scripts, data files, parameter values, settings, installed packages and the
  state scripts save with `tt.globalStore`, `tt.pageStore` and `tt.siteStore`.
  It stays on your device and is removed when you uninstall TangiTweak.
- **Folder sync** (optional): if you connect a folder, scripts and settings are
  written there.
- **Diagnostics** (optional): **Collect diagnostics** builds a Markdown report
  and saves it as a file on your device. It can include recent log lines,
  request URLs and, if you allow the "management" permission when asked, the
  names, versions and permissions of your other installed extensions. Nothing
  is uploaded; you choose whether to share the file.

## Network requests TangiTweak makes

TangiTweak itself only contacts other servers when you ask it to:

| When | Where | Why |
| --- | --- | --- |
| You install or update a script or package from a URL | the URL you gave, `github.com`, `api.github.com`, `raw.githubusercontent.com`, gists | download the script and the files it imports |
| A script imports an npm package | `unpkg.com` | download the package |
| You open Settings → About | `api.github.com` | check for a newer TangiTweak release |
| You install the local helper | `raw.githubusercontent.com`, GitHub releases (run by you in a terminal) | download the helper |
| Your system proxy uses a PAC file and the local helper is on | your PAC file's URL | keep your proxy setup for traffic the helper forwards |

These requests send no cookies or personal data from TangiTweak. The servers
see your IP address and the request, as with any download.

Scripts you write or install can make their own requests (`tt.fetch`, or code
they add to pages), and can change what pages send. Only run scripts you trust,
and review an installed script's code and permissions on the install page.

## The local helper (optional)

The local helper is a program you install yourself. It runs on your computer,
talks to TangiTweak over native messaging, and acts as a local proxy for the
requests your `helper` scripts target. It doesn't send data anywhere except
the sites those requests were going to (through your own proxy, if you have
one). In Chrome, TangiTweak asks for the "native messaging" and "browsing data"
permissions only when you click **Allow** in Settings → Local helper. Browsing
data is used only to clear cached copies of the pages the helper routes.

## Permissions

| Permission | Why |
| --- | --- |
| Access to all sites | scripts can target any site you choose |
| `debugger` | the `debugger` strategy reads and changes responses through Chrome's DevTools protocol, for tabs your scripts target |
| `webRequest`, `declarativeNetRequestWithHostAccess`, `webNavigation` | watch and change requests, and know which page a request belongs to |
| `proxy` | route your helper scripts' traffic through the local helper, keeping your proxy for the rest |
| `tabs` | open the Editor and link requests to tabs |
| `storage`, `unlimitedStorage` | save your scripts, settings and script data |
| `offscreen`, `alarms` | run script code in the background, and keep folder sync running |
| `userScripts` (optional) | run your `tt.onPage` code in an isolated world, and your `tt.onSite` code in the site's |
| `nativeMessaging`, `browsingData` (optional) | the local helper, see above |
| `management` (optional) | list your other extensions in a diagnostics report |

## Google API data

The use of information received from Google APIs will adhere to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the Limited Use requirements.

## Changes and contact

Changes to this policy are listed in the [changelog](../CHANGELOG.md).
Questions: open an issue at
<https://github.com/tangistudio/TangiTweak/issues>.
