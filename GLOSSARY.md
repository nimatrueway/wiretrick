# Wiretrick

Wiretrick lets a user rewrite browser requests and responses with small
TypeScript scripts. This glossary fixes the words we use for its concepts in
docs, UI text, issues and conversation.

## Scripts

**Script**:
A TypeScript file the user writes that registers handlers.
_Avoid_: rule, override, userscript

**Utility**:
A script that registers no handlers with its current param values; it only runs when another script imports it.
_Avoid_: library, lib, helper

**Recipe**:
A function exported by a utility that registers handlers on behalf of the script that calls it.
_Avoid_: macro, preset

**Handler**:
One registration in a script (`wt.onRequest`, `wt.onResponseHeaders`, `wt.modifyResponse`, `wt.replaceResponse` or `wt.onDom`) pairing a route with a function.
_Avoid_: hook, rule, interceptor, listener

**Body handler**:
A `wt.modifyResponse` or `wt.replaceResponse` handler: one that works on a response body.
_Avoid_: response handler

**Route**:
The first argument of a handler, saying which requests it applies to: one or more patterns, optionally narrowed by excludes, methods and resource types, plus an optional strategy.
_Avoid_: match, filter, rule

**Pattern**:
A URLPattern string inside a route.
_Avoid_: glob, match pattern, URL filter

**Param**:
A user-adjustable value a script declares, edited in the popup, the manager or `settings.yaml`.
_Avoid_: option, setting, config, variable

**Enabled**:
The user's on/off switch for a script; a utility has none.
_Avoid_: active, on, running

**Terminal result**:
An `onRequest` outcome that ends the request's handler chain: respond, redirect or cancel.
_Avoid_: final result, short-circuit

**Replacement**:
A whole new response that Wiretrick serves instead of the real one (from `replaceResponse` or `respond`).
_Avoid_: mock, override, fake response

**Stacking**:
How several handlers matching the same request combine, in explorer order.
_Avoid_: chaining, priority, precedence

## Interception

**Strategy**:
The browser mechanism a handler intercepts through: `process`, `hook`, `webrequest` or `cdp`. Each handler uses exactly one.
_Avoid_: tier, mode, backend, method

**Default strategy**:
The strategy a handler uses when its route doesn't name one, chosen in Settings.
_Avoid_: global strategy, fallback

**Available**:
Said of a strategy that can run in the current browser and build right now; a handler on an unavailable strategy doesn't run.
_Avoid_: supported, enabled, active

**Local helper**:
The small program (`wiretrick-helper`) the user installs on their machine that powers the `process` strategy.
_Avoid_: proxy, native app, daemon, process helper

**Helper CA**:
The certificate authority the local helper creates on the user's machine, which the user trusts so the helper can read HTTPS traffic.
_Avoid_: root cert, MITM cert

**Proxy routing**:
Wiretrick sending only the hosts its `process` handlers need through the local helper.
_Avoid_: PAC, proxy mode

**User proxy setting**:
The user's own browser or system proxy configuration, which keeps applying to everything else.
_Avoid_: proxy settings, system proxy (unless it really is the system one)

**Debugger banner**:
The "being debugged" bar Chrome shows while the `cdp` strategy is attached to a tab.
_Avoid_: yellow bar, infobar

**Page load**:
The request for a tab's top-level document (resource type `main_frame`).
_Avoid_: main page, main URL, navigation

## Outcomes

**Intervention**:
What one script did to one request: tapped, modified or missed.
_Avoid_: action, hit, event

**Tapped**:
A handler ran on a request but changed nothing.
_Avoid_: seen, matched, no-op

**Modified**:
A handler changed a request or its response.
_Avoid_: rewritten, intercepted, touched

**Missed**:
A body handler's route matched a request, but the handler never ran on it.
_Avoid_: skipped, failed, not intercepted

## Builds

**MV3 build**:
The Manifest V3 package, for current Chrome, Edge and Brave.
_Avoid_: Chrome build

**MV2 build**:
The Manifest V2 package, for Firefox and Chromium browsers that still run Manifest V2.
_Avoid_: legacy build, Chrome MV2 (say "the MV2 build on Chromium")

## Manager and UI

**Manager**:
The extension's full-page UI: explorer, editor, panel and settings.
_Avoid_: editor, dashboard, options page

**Editor**:
The code pane inside the manager.
_Avoid_: manager, IDE

**Explorer**:
The manager's list of scripts and `settings.yaml`.
_Avoid_: script list, sidebar, file tree

**Panel**:
The manager's dockable area holding the Log and Network tabs.
_Avoid_: bottom panel, console, devtools

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

**Scripts folder**:
A folder the user picks that Wiretrick keeps in two-way sync with the scripts.
_Avoid_: workspace, sync folder, dedicated folder

**Folder sync**:
The two-way mirroring between scripts and the scripts folder.
_Avoid_: export, backup

**Generated files**:
`wt-api.d.ts`, `tsconfig.json` and `settings.schema.json`: files Wiretrick writes into the scripts folder and rewrites on every start, not meant to be edited.
_Avoid_: owned files, support files, typings

**Diagnostics report**:
The Markdown file the manager produces for a bug report.
_Avoid_: debug dump, log export

**Samples**:
The ready-made starter scripts offered in the manager's help dialog.
_Avoid_: examples, templates
