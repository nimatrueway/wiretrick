# Wiretrick

Wiretrick lets a user rewrite browser requests and responses with small
TypeScript scripts. This glossary fixes the words we use for its concepts in
docs, UI text, issues and conversation.

## Scripts

**Script**:
A TypeScript file the user writes that registers handlers. Its name is its path in the explorer, folders included (`mock/api mock`).
_Avoid_: rule, override, userscript

**Library**:
A script that registers no handlers with its current param values; it only runs when another script imports it.
_Avoid_: utility, lib, helper

**Data file**:
A JSON file (`.json`) in the explorer that scripts import; it never runs.
_Avoid_: fixture, asset, JSON script

**Folder**:
A folder in the explorer grouping scripts and data files; folders nest, can be empty, and mirror subfolders of the synced folder.
_Avoid_: directory, group, namespace

**Recipe**:
A function exported by a library that registers handlers on behalf of the script that calls it.
_Avoid_: macro, preset

**Handler**:
One registration in a script (`wt.onRequest`, `wt.onResponseHeaders`, `wt.onResponseBody`, `wt.replaceResponse` or `wt.onDocument`) pairing a route with a function.
_Avoid_: hook, rule, interceptor, listener, onDom

**Body handler**:
A `wt.onResponseBody` or `wt.replaceResponse` handler: one that works on a response body.
_Avoid_: response handler, modifyResponse

**Route**:
The first argument of a handler, saying which requests it applies to: one or more URL patterns, optionally narrowed by excludes, methods and resource types (`resourceTypes`), plus an optional strategy.
_Avoid_: match, filter, rule

**URL pattern**:
A URLPattern string inside a route.
_Avoid_: pattern (bare), glob, match pattern, URL filter

**Param**:
A user-adjustable value a script declares, edited in the popup, the Editor or `settings.yaml`.
_Avoid_: option, setting, config, variable

**Enabled**:
The user's on/off switch for a script; a library has none.
_Avoid_: active, on, running

**Final result**:
An `onRequest` result that ends the request's handler chain: `replaceResponse`, `redirect` or `block`.
_Avoid_: terminal result, short-circuit, cancel, respond

**Replacement**:
A whole new response that Wiretrick serves instead of the real one (from a `wt.replaceResponse` handler or an `onRequest` `replaceResponse` result).
_Avoid_: mock, override, fake response, respond

**Stacking**:
How several handlers matching the same request combine, in explorer order (each folder's subfolders first, then its scripts).
_Avoid_: chaining, priority, precedence

**Hot apply**:
A saved script, data file, param or setting change taking effect right away, without reloading the extension or the browser.
_Avoid_: hot reload, live reload, restart

**Compile error**:
A syntax error or other failure to load a script; the script doesn't run until it's fixed.
_Avoid_: build error, script crash

**Type error**:
A TypeScript type error in a script; the script still runs, since types are dropped when it loads.
_Avoid_: compile error (for type-only errors), lint error

**Rules error**:
A handler on the `rules` strategy whose result can't become a browser rule (for example it reads the request); that handler doesn't run, the rest of the script does.
_Avoid_: DNR error, rule failure

**Runtime error**:
A handler of a script throwing or failing while it runs; it's shown until the script is saved again or the user dismisses it.
_Avoid_: crash, exception (in UI text)

**Route warning**:
A route whose handler can never run with its strategy in the current browser, or whose strategy isn't available right now.
_Avoid_: strategy error, unsupported route

**Problem**:
Something currently wrong with a script or `settings.yaml`: a compile error, type error, rules error, runtime error or route warning. It goes away by itself once it's fixed; a missed warning is not a problem, it's about one request.
_Avoid_: issue, diagnostic, error log

## Interception

**Strategy**:
The browser mechanism a handler intercepts through: `helper`, `page`, `extension` (the extension handles each request), `debugger` or `rules`. Each handler uses exactly one.
_Avoid_: tier, mode, backend, method, interception (as a section name), `process`, `hook`, `webrequest`, `webRequest`, `cdp`, `dnr`, `declarative`

**Default strategy**:
The strategy a handler uses when its route doesn't name one, chosen in Settings (`defaultStrategy` in `settings.yaml`).
_Avoid_: global strategy, fallback

**Available**:
Said of a strategy that can run in the current browser and build right now; a handler on an unavailable strategy doesn't run.
_Avoid_: supported, enabled, active

**Local helper**:
The small program (`wiretrick-helper`) the user installs on their machine that powers the `helper` strategy.
_Avoid_: proxy, native app, daemon, process helper

**Helper certificate**:
The certificate authority the local helper creates on the user's machine, which the user trusts so the helper can read HTTPS traffic.
_Avoid_: helper CA, root cert, MITM cert

**Helper routing**:
Wiretrick sending only the hosts its `helper` handlers need through the local helper.
_Avoid_: proxy routing, PAC, proxy mode

**User proxy setting**:
The user's own browser or system proxy configuration, which keeps applying to everything else.
_Avoid_: proxy settings, system proxy (unless it really is the system one)

**Debugger banner**:
The "being debugged" bar Chrome shows while the `debugger` strategy is attached to a tab.
_Avoid_: yellow bar, infobar

**Page load**:
The request for a tab's top-level document (resource type `main_frame`).
_Avoid_: main page, main URL, navigation

## Outcomes

**Outcome**:
What one script did to one request: observed, modified or missed.
_Avoid_: intervention, action, hit, event

**Observed**:
A handler ran on a request but changed nothing.
_Avoid_: tapped, seen, matched, no-op

**Modified**:
A handler changed a request or its response.
_Avoid_: rewritten, intercepted

**Touched**:
A request some script observed or modified; the Network view's filter for them.
_Avoid_: tapped / modified, intercepted

**Missed**:
A body handler's route matched a request, but the handler never ran on it.
_Avoid_: skipped, failed, not intercepted

**Missed warning**:
The warning logged for a missed request, naming the likely reason.
_Avoid_: "never ran" warning

## Builds

**MV3 build**:
The Manifest V3 package, for current Chrome, Edge and Brave.
_Avoid_: Chrome build

**MV2 build**:
The Manifest V2 package, for Firefox and Chromium browsers that still run Manifest V2.
_Avoid_: legacy build, Chrome MV2 (say "the MV2 build on Chromium")

## Editor and UI

**Editor**:
The extension's full-page UI: explorer, Code view, panel and settings.
_Avoid_: manager, dashboard, options page

**Code view**:
The code pane inside the Editor.
_Avoid_: editor, IDE

**Explorer**:
The Editor's list of folders, scripts, data files and `settings.yaml`.
_Avoid_: script list, sidebar, file tree

**Panel**:
The Editor's dockable area holding the Problems view, the Log view and the Network view.
_Avoid_: bottom panel, console, devtools

**Problems view**:
The panel view listing the current problems, grouped by script.
_Avoid_: issues panel, problems tab, diagnostics

**Log view**:
The panel view listing engine and script log lines.
_Avoid_: LOG, log panel, log tab, console

**Network view**:
The panel view listing the requests of a tab and what each script did to them.
_Avoid_: network panel, network tab

**Panel counts**:
The counts shown on each panel view's title and in the status bar: errors and warnings among the current problems (they drop as problems are fixed), errors and warnings in the Log view, and observed and modified requests in the Network view (both kept until that view is cleared).
_Avoid_: unread counts, tab badges

**Popup**:
The toolbar icon's dropdown listing the scripts for the current tab, with their switches and params.
_Avoid_: menu, quick panel

**Badge**:
The number on the toolbar icon: how many enabled scripts have a route matching the current tab's page or any request it made.
_Avoid_: counter, indicator

**Settings**:
Wiretrick's global options (as opposed to a script's params).
_Avoid_: preferences, config, params

**settings.yaml**:
The user-owned file holding settings, every script's params and enabled state.
_Avoid_: config file, settings file

**Synced folder**:
A folder the user picks that Wiretrick keeps in two-way sync with the scripts, data files and folders; its subfolders mirror the explorer's folders.
_Avoid_: scripts folder, workspace, dedicated folder

**Folder sync**:
The two-way mirroring between the explorer (scripts, data files, folders) and the synced folder.
_Avoid_: export, backup

**Managed files**:
`wt-api.d.ts`, `tsconfig.json` and `settings.schema.json`: files Wiretrick writes into the synced folder and rewrites on every start, not meant to be edited.
_Avoid_: generated files, owned files, support files, typings

**Diagnostics report**:
The Markdown file the Editor produces for a bug report.
_Avoid_: debug dump, log export

**Samples**:
The ready-made starter scripts offered in the Editor's help dialog.
_Avoid_: examples, templates
