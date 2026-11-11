# Faster TypeScript compile and hot reload: research notes

Status: research only, no code changed. Written 2026-11. Line numbers refer to the tree at the time of writing.

## TL;DR

**Are we using web workers now?** Only for the Editor's type checking. Monaco's TypeScript language service runs in its own worker (`lib/monaco/vs/language/typescript/tsWorker.js`, loaded through `MonacoEnvironment.getWorkerUrl` in `src/ui/monacoSetup.ts:100-103`). Everything on the save path runs on main threads:
- MV3: the TS to JS transpile and the top-level runs happen in the sandbox iframe (`src/background/sandbox.ts`) inside the offscreen document. The service worker only orchestrates.
- MV2 and Firefox: they run in the background page.
- Pages: the hook, bridge, isolated world and overlay run already-transpiled code with `new Function`.

**Can we compile in parallel?** Technically yes, but it is the wrong lever. The transpile step (Sucrase) costs about 0.08 ms for a typical script, and about 4 to 12 ms for a 60 to 120 KB file (table below). A save is slow for other reasons:
- Every script's top level runs several times.
- Dependant recompiles are sequential RPC round trips, and each one resends every script's source.
- Every frame of every tab re-transpiles its bundle.
- There is no transpile cache anywhere.

Removing that redundancy beats any parallelism. Workers also hit platform limits:
- MV3 service workers cannot create `Worker`s.
- The offscreen document can create them, but its CSP forbids `eval`, so a worker there could only transpile, not run user code.
- Whether the sandbox iframe can spawn workers is unverified.

**WebAssembly?** Not worth it for transpiling today:
- WASM transpilers are faster on large files. oxc-wasm and swc strip-only are about 2.5x faster than Sucrase on 120 KB.
- They are slower on the small scripts users actually write: 1.7 to 2.3 ms vs 1.1 ms for all 14 samples.
- Each pays 40 to 110 ms to instantiate in every context (SW, offscreen, sandbox, MV2 background).
- Each adds 3 to 18 MB of binary.
- Most change output line numbers, which our stack traces and route `line`s rely on.
- Most do not emit the CommonJS shape that `scriptFunction` expects.

TypeScript 7 (Go) has an experimental WASM build in the 7.1 nightlies (52.8 MB). It is not usable from Monaco yet.

**WebGPU?** No. Parsing and transforming source is branchy, sequential work over strings. GPU compute (WGSL) has no strings, no recursion and no JS. The only GPU compiler research is a feasibility study on a purpose-built toy language. See [What not to do](#what-not-to-do).

**Top recommendations, in order:**
1. Instrument the path from save to page with timings.
2. Add a transpile cache keyed on the source.
3. Stop re-running every script's top level after a save: batch the dependant recompiles into one sandbox call, and make the sandbox cache incremental.
4. Build the hook bundle once per reload, not once per frame.
5. Turn on Monaco `setEagerModelSync(true)` for the "briefly flagged" symptom.

## Current pipeline: from save to running on the page

### 1. Save (Editor to background)

`saveScript` (`src/background/engine/scriptStore.ts:89`) queues through `whileBusy`, so saves are serialized. `saveScriptNow` (`:93-171`) then:
1. Reads scripts and order (`storageGet`), loads param values (`loadAllParamValues`), and runs `ensurePackages`, which may download.
2. Calls `compileForStorage` for the saved script (`:112`). This runs its top level to collect meta: handlers, routes and params.
3. Finds importers (`:137-149`): scripts that import it by name (old and new name), plus scripts that share a package URL.
4. Calls `recompileMeta(byId, importers, ...)` (`:151`, defined at `:185-199`). This is a **sequential** `for ... await compileForStorage(...)` over every dependant.
5. Writes with `storageSet`, then calls `notify()`.

`recompileMeta` is also used by:
- `refreshStaleMeta` (`:214`): at startup, for every script after a version change
- `deleteScript` (`:234`)
- `commitDataFiles` (`:321`)
- `renameFolder` (`:435`)
- `deleteFolder` (`:464`)
- the param-value write path (`:552-579`, recompile at `:566`)

### 2. `compileForStorage` (`src/background/compileHost.ts:228-265`)

- Calls `ensurePackages` twice (`:241-242`).
- **MV2 and Firefox** (`:243-250`): runs `compileWithLibs` in the background page.
- **MV3** (`:252-264`): `ensureOffscreen` (`:130-168`) → `sandboxCallWithData` (`:88-94`) → `sandboxCall` (`:59-82`).
  - Each call is two hops: `chrome.runtime.sendMessage` to `src/background/offscreen.ts`, then `postMessage` to the sandbox iframe.
  - The sandbox dispatches `compileOne` (`src/background/sandbox.ts:393`, implemented at `:284-296`).
  - The request carries the **source of every other script** (`scripts: plain(byId)`).
  - Data files and packages are resent only when the sandbox reports a signature mismatch (`compileHost.ts:88-94`).

### 3. `compileWithLibs` and `compileScript` (`src/shared/compile.ts`)

- `compileWithLibs` (`:456-470`) builds a **new** `makeModuleResolver` (`:344-447`) per call, so each call starts with an empty module cache.
- Each imported library is transpiled with `toRunnableJs(lib.code)` (`:414`), and its top level runs.
- `compileScript` (`:150-189`):
  1. Transpiles the target (`transpiler(code)`, `:158`).
  2. Rewrites registration calls (`keyPlaceCalls`, `:734`).
  3. Builds the function with `new Function` (`scriptFunction`, `src/shared/scriptFn.ts:11-14`).
  4. Runs the top level.
- The transpiler is Sucrase (`src/shared/transpile.ts:21-32`). It always tries the TSX transform first and falls back to plain TS on a parse error. **There is no cache.**

### 4. Reload after storage changes (`src/background/engine/pipeline.ts`)

`notify()` fans out to several listeners:
- `pipeline.ts:1058` (`reload`)
- `background.ts:259` (cache refresh)
- `background.ts:319` (`updateAllTabs`)
- `packages.ts:450` (prune)
- `folderSync.ts:1291`

`reload` (`:994`) is neither debounced nor coalesced. Every `notify` triggers a full `reloadNow` (`:1002-1056`); `reloadSeq` (`:1003`) only discards stale results. `reloadNow`:

1. Reloads text types, data files, packages, `listScripts`, param values and `prepareStores` (`:1004-1009`).
2. Runs `analyzeScripts` for **all** scripts (`:1018`, implemented at `compileHost.ts:270-327`):
   - **MV3:** the session-storage analyze cache (`compileHost.ts:278-289`, `:326-355`) is all-or-nothing on `updatedAt`, so it always misses after a save.
     - One sandbox `analyze` call then runs `ensureCompiled` (`sandbox.ts:199-262`).
     - The code changed, so the sandbox signature (`compileSignature`) changes, and `ensureCompiled` calls `cache.clear()` and **re-runs every script's top level**.
     - That includes the saved script and its dependants, which `saveScriptNow` just compiled.
   - **MV2:** there is no analyze cache at all (`compileHost.ts:290+`). Every call builds a resolver and re-runs every script.
3. Runs each strategy's `.reload`. In MV2 each strategy calls `compileMv2` (`src/background/engine/strategies/strategyScripts.ts:52-80`), which builds another resolver and re-transpiles and re-runs the scripts it owns:
   - `debuggerStrategy:110`
   - `extensionStrategy:66`
   - `helperStrategy:204`
   - `pageStrategy:44`
   - `rulesStrategy`
4. Runs `syncUserScripts` (MV3 user scripts), `pushBundleUpdate` over L2 ports (`:1045`, `bridgePorts.ts:66`), and sends a `bundleUpdate` message to **every tab** (`:1048-1055`).

### 5. Each frame fetches its bundle

On `bundleUpdate`, each frame's bridge (`src/hook/bridge.ts:676`) sends `getHookBundle`. `hookBundle` (`pipeline.ts:580-678`, handler at `:869-891`) runs **for every frame of every tab**. Each run:
- Calls `listScripts`, `loadAllParamValues` and `analyzeScripts` (`:600`). This hits the MV3 cache after step 4; in MV2 it is another full recompile.
- Runs `toRunnableJs`, a new Sucrase pass with no cache, on:
  - the overlay code (`:626`)
  - each matching script (`:630`)
  - every imported lib (`:657`)
- Overlay links call `hookBundle` again (`:680-684`).

### 6. Page side

- The hook, bridge and isolated world run the transpiled JS via `scriptFunction` (`src/hook/hook.ts:276,310`; `bridge.ts:524,530`; `src/hook/isolated.ts:247,252`). Nothing is transpiled here.
- The overlay calls `compileScript` without a transpiler (`src/overlay/overlayRuntime.ts:193,209`), so only `keyPlaceCalls` runs.
- Only `pipeline.ts:26` and `sandbox.ts:33` import `shared/transpile`.

### What one save costs today (MV3)

In the table, N is the number of scripts, D the saved script's dependants, L the libs it imports, and F the frames across open tabs.

| Step | Transpiles | Top-level runs | RPC round trips |
| --- | --- | --- | --- |
| `compileForStorage(saved)` | 1 + L | 1 + L | 1 (SW→offscreen→sandbox), carrying all N sources |
| `recompileMeta` (sequential) | D × (1 + its libs) | D × (1 + its libs) | D, each carrying all N sources |
| `reloadNow` → `analyzeScripts` | N, plus libs again through the resolver | N, plus libs | 1 |
| MV2 only: strategies' `compileMv2` | owned scripts again, per strategy | same | 0 |
| `getHookBundle` × F frames | F × (matching scripts + libs) | 0 in MV3, N per frame in MV2 | F (tab→SW) |

Example: one-line edit to a library that 10 scripts import, with 3 tabs open:
- That library is transpiled 25 or more times.
- Every script's top level runs at least twice.

## Benchmarks

### Method

**Environment**
- Intel i9-9880H (8 cores, 16 threads), Linux, Node v26.13.0 (V8).
- The machine was shared and noisy (load average 2.7 to 5).
- This is Node, not Chrome or Firefox. Absolute browser numbers will differ, but the ratios between pure-JS and WASM tools should roughly hold. esbuild-wasm is an exception (see below).

**Versions**
- sucrase 3.35.1 (the repo's version)
- esbuild and esbuild-wasm 0.28.2
- @swc/core, @swc/wasm and @swc/wasm-typescript 1.16.22
- oxc-transform 0.158.0 and @oxc-transform/binding-wasm32-wasi 0.158.0
- ts-blank-space 0.9.0
- typescript 5.9.3 (`transpileModule`)

**Procedure**
- Each (tool, input) pair ran in a fresh process.
- "cold" is import, plus WASM instantiate, plus the first transform. "2nd" is the second call.
- "warm" is the median of up to 200 timed calls (or 3 s), taken after up to 300 warm-up calls (or 3 s).
- Options were set as close as possible to what `scriptFunction` needs: TS with automatic-runtime JSX, CommonJS output, and an ESNext target (no downlevelling).
- One harness difference from the repo: `.ts` inputs went straight to Sucrase's non-JSX transform. The repo tries the TSX transform first.
- "sucrase-noimports" drops the `imports` transform, to show what the CommonJS rewrite costs.
- Scratch scripts lived outside the source tree and were deleted afterwards.

**Inputs** (all from the repo)

| Input | Size |
| --- | --- |
| All 14 `SAMPLES` from `src/ui/samples.ts`, one call each | 13.7 KB, 288 lines in total |
| The overlay sample | 41-line TSX |
| `src/overlay/overlayRuntime.ts` | 16 KB |
| `src/hook/bridge.ts` | 60 KB |
| `src/ui/network/NetFilterBar.tsx` | 62 KB TSX |
| `src/ui/editor.ts` | 123 KB |

### Results (milliseconds, lower is better)

Each cell is the warm median per call, with the cold start in parentheses where it was recorded. "n/a" means the tool cannot handle JSX. "lines kept?" asks whether output line numbers match the source.

| Tool | 14 samples | overlay TSX | 16 KB TS | 60 KB TS | 62 KB TSX | 123 KB TS | lines kept? | CJS out? | JSX? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **sucrase** (current) | **1.12** (58) | **0.18** (48) | **1.36** (57) | **4.46** (72) | **12.0** (87) | **11.1** (93) | yes | yes | yes |
| sucrase-noimports | 1.06 | 0.16 | 1.20 | 3.98 | 11.5 | 9.84 | yes | no | yes |
| esbuild (native) | 8.14 (61) | 0.65 | 2.00 | 4.49 | 5.01 | 8.52 | no (1151→889) | yes | yes |
| esbuild-wasm | 22.2 (280) | 1.78 (190) | 5.98 | 19.0 | 21.1 | 38.3 (273) | no | yes | yes |
| swc (native) | 1.49 (11) | 0.21 | 1.10 | 3.68 | 4.52 | 7.75 | no (1151→1249) | yes | yes |
| swc-wasm (@swc/wasm) | 2.26 (93) | 0.36 (80) | 1.69 | 5.12 | 6.36 | 10.2 (112) | no | yes | yes |
| swc strip-only (@swc/wasm-typescript, as in Node's amaro) | n/a | n/a | 0.70 (39) | 2.14 (42) | n/a | 4.50 (51) | yes | no | no |
| oxc (native) | 0.56 (8) | 0.07 | 0.41 | 1.31 | 1.56 | 2.81 | no (1151→1223) | no | yes |
| oxc-wasm (wasm32-wasi) | 1.72 (82) | 0.20 (74) | 0.72 | 2.08 | 2.36 | 4.20 (90) | no | no | yes |
| ts-blank-space | n/a | n/a | 1.53 (221) | 4.81 (236) | n/a | 11.4 (262) | yes | no | no |
| typescript `transpileModule` | 10.8 (300) | 1.59 (252) | 9.11 (309) | 30.4 (349) | 43.2 (365) | 78.4 (441) | no | yes | yes |

Native (non-WASM) builds cannot run in a browser. They are listed only to show the ceiling.

**Other measurements** (same machine, Node, milliseconds):

| What | 16 KB | 60 KB | 123 KB |
| --- | --- | --- | --- |
| `new Function(js)` on Sucrase output (V8 pre-parse only, no execution) | 0.31 | 1.29 | 3.08 |
| SHA-1 of the source (upper bound on cache-key cost) | 0.03 | 0.08 | 0.15 |

**Sizes:**

| Artifact | Size |
| --- | --- |
| esbuild.wasm | 14 MB |
| @swc/wasm `wasm_bg.wasm` | 18 MB |
| oxc `transform.wasm32-wasi.wasm` | 3.3 MB |
| @swc/wasm-typescript | 4.05 MB, as one **JS** file with inlined wasm, so it counts toward AMO's 5 MB text-file limit |
| TypeScript 7.1 dev `tsc.wasm` | 52.8 MB |
| our current `dist-mv3/sandbox.js` (includes Sucrase) | 636 KB |
| our `dist-mv3/lib/monaco/vs/language/typescript/tsWorker.js` | 5,131,404 bytes, already within about 110 KB of the 5 MiB cap that `scripts/build.mjs:299-338` (`pruneTsWorkerLibs`) enforces |

### What the numbers say

- For the scripts users write (the samples), **Sucrase is already at or near the best option that runs in a browser**:
  - Warm, all 14 samples take 1.12 ms with Sucrase, 1.72 ms with oxc-wasm and 2.26 ms with swc-wasm.
  - Every WASM option also adds 40 to 110 ms of cold start each time a context starts (SW, offscreen, sandbox, MV2 background).
  - The WASM tools only win on 60 to 120 KB inputs, by about 2 to 2.6 times.
- Sucrase is the only tool that preserves lines, emits CommonJS **and** handles JSX. We depend on all three:
  - `scriptFunction` puts `"use strict"` on line 1 so that stack offsets work (`src/shared/scriptFn.ts:12`).
  - Routes record their registration `line`.
  - Scripts get `require`, `module` and `exports`.
- Calling `new Function` on the output costs about a third of the transpile, and the top level (user code plus `wt` registrations) runs on top of that. So the cost of a save depends mostly on **how many times** we transpile and run, not on how fast one transpile is.
- A cache lookup is cheap. A full SHA-1 of a 123 KB source takes 0.15 ms, against 11 ms to transpile it. A `Map` keyed on the source string is cheaper still, because V8 hashes a string once and caches the hash.
- esbuild-wasm looks especially bad here because in Node it runs in a child process with async IPC. In browsers it defaults to running in a Web Worker and has no synchronous API ([esbuild API docs](https://esbuild.github.io/api/#browser)). It would be async there too.
- The [Sucrase README](https://github.com/alangpierce/sucrase#readme) benchmark (Jest codebase, no warm-up) puts Sucrase ahead of swc and esbuild. Our warm, large-file numbers disagree, but on small inputs they agree.

## Options, ranked by expected win against effort and risk

### 1. Measure first (effort: small, risk: none)

Add `performance.now()` spans, logged through `dlogLevel("compile", "debug", ...)`, around:
- the phases of `saveScriptNow`
- each `compileForStorage` call, splitting SW-side wait from sandbox-side compile
- `ensureCompiled`
- the phases of `reloadNow`
- `hookBundle`

The numbers above come from Node. Real browser numbers for RPC hops and top-level runs should drive the next steps.

### 2. Transpile cache (effort: small, risk: low)

Memoize `transpiler(code)` plus `keyPlaceCalls`:
- Use a bounded `Map<string, string>` keyed on the source, in `toRunnableJs` (`compile.ts:136-143`) and at `compileScript` (`compile.ts:158`).
- One module-level cache per context (sandbox, SW, MV2 background) covers every call site:
  - `hookBundle`, once per frame (`pipeline.ts:626,630,657`)
  - every resolver's lib loads (`compile.ts:414`)
  - `compileMv2`, once per strategy
  - `compileOne`, once per dependant
- Key on the source text, not `updatedAt`, so identical code in different scripts also hits.
- Evict by LRU or a total-bytes cap (for example 8 MB) to bound memory in the offscreen doc.

Expected win: each distinct source is transpiled once per context lifetime. The SW's per-frame `getHookBundle` work drops to almost no CPU.

### 3. Stop re-running everything after a save (effort: medium, risk: medium)

This is the biggest structural waste.

- **Batch `recompileMeta` into one sandbox call.** Add a `compileMany` op that takes the target ids, sends the script set once and builds one resolver.
  - Libs then load and transpile once for all dependants, instead of D sequential round trips that each resend all sources.
  - Real parallelism (`Promise.all`) gains little, because the sandbox is single-threaded. Batching is where the win is.
  - In MV2 the same change means one resolver for the whole loop.
- **Make `ensureCompiled` incremental** (`sandbox.ts:199-262`).
  - Key each script's entry on its code hash, the param values of it and its libs, and its deps' code hashes.
  - When the signature changes, recompile only the changed scripts and their transitive dependants instead of calling `cache.clear()`.
  - Data-file and package changes can still clear everything.
- **Seed the analyze cache from the save.** `saveScriptNow` already has fresh meta for the saved script and its dependants, so `reloadNow`'s `analyzeScripts` could reuse it instead of a full sandbox `analyze`. In MV3, make `readAnalyzeCache` per-script rather than all-or-nothing (`compileHost.ts:278-289`).
- **Give MV2 and Firefox an in-memory analyze cache.** They have none today (`compileHost.ts:290+`). MV2 strategies should also reuse one compile per reload instead of each calling `compileMv2`.
- **Coalesce `reload`.** If a reload is already running, mark it dirty and run one more afterwards, rather than a full `reloadNow` per `notify` (`pipeline.ts:994-1001,1058`).

Risk: meta must stay correct when a lib's params or a data file change. The signature inputs already exist: `compileSignature`, `paramSig`, `dataFilesSig` and `packagesSig`.

### 4. Build the page bundle once per reload (effort: small to medium, risk: low)

- Cache the transpiled overlay, onPage and lib code from `hookBundle` (`pipeline.ts:580-678`) per reload generation (`reloadSeq`). Item 2 already covers most of this.
- `pushBundleUpdate` already sends a `codeHash` per script (`pipeline.ts:1045`), and the bridge already compares hashes (`bridge.ts:766-770`). The bridge could fetch only the scripts whose hash changed, instead of the whole bundle.

### 5. Shrink the RPC payload (effort: medium, risk: low)

- `sandboxCall` sends every script's source on each call.
- Instead, the sandbox could keep a `{id → code, hash}` table and receive only changed entries. This is the pattern `needDataFiles` already uses for data files and packages (`compileHost.ts:88-94`).
- `runtime.sendMessage` messages must be JSON-serializable ([Chrome messaging docs](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)), so the cost grows with the number of bytes sent.

### 6. Editor: the "briefly flagged" symptom (effort: small, risk: low)

- The root cause, which the comment at `src/ui/editor.ts:692-698` works around: Monaco's diagnostics adapter checks a model with only that model's URI synced to the worker.
- In Monaco 0.52.2 (our version), `typescriptDefaults.setEagerModelSync(true)` makes the worker sync **all** TS models when it starts or restarts. Sources:
  - The `editor.api.d.ts` doc comment: "Configure if all existing models should be eagerly sync'd to the worker on start or restart".
  - `_getClient` calling `withSyncedResources(getModels())` in [tsMode.ts at v0.52.2](https://github.com/microsoft/monaco-editor/blob/v0.52.2/src/language/typescript/tsMode.ts).
- `setEagerModelSync` is not set anywhere in `src/ui`. Set it in `loadMonaco` (`src/ui/monacoSetup.ts:114-121`), and keep `revalidateModel`'s `getTypeScriptWorker()(m.uri, ...all)`.
- It only covers models that exist when the worker starts, so verify the order in which the Editor creates models.
- Monaco's own re-check fires 500 ms after an edit (`tsMode.js`). Our extra passes wait 600 ms (`scheduleDiagnostics`) and 500 ms (`scheduleDependantRecheck`). Shortening them cuts latency but adds churn, so measure before tuning.
- More TS workers would not help: Monaco creates one TS worker per language mode, and the language service is single-threaded.
- Note for any Monaco upgrade:
  - 0.53 deprecated the AMD build that `loadMonaco` uses.
  - 0.55 moved `languages.typescript` to a top-level `typescript` namespace.
  - Source: the [Monaco changelog](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md).

### 7. Workers for compiling (effort: large, risk: high, win: small)

Only worth revisiting if item 1 shows long single transpiles on the main thread (for example, users pasting scripts of 100 KB or more). The constraints:

- **MV3 service worker:** cannot create workers. `Worker` is `[Exposed=(Window,DedicatedWorker,SharedWorker)]`, which excludes `ServiceWorker` ([WHATWG HTML](https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface)).
- **Offscreen document:** can spawn workers, since `WORKERS` is a valid reason ([chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)). But:
  - Extension pages get `script-src 'self'` with no `'unsafe-eval'` ([Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)). A worker there could transpile (Sucrase is plain JS) but could not run the top level.
  - Only one offscreen document can exist at a time, and we already use it.
- **Sandbox iframe:** has `'unsafe-eval'` and a unique origin ([Chrome sandbox docs](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)). It is **unverified** whether it can start a worker (from a blob or `data:` URL), and whether that worker would keep `'unsafe-eval'`. This needs a spike.
- **Running top levels in a worker:** would need the `wt` API surface (the storage, fetch and log reverse channels, `reverseCall` and `liveApis` in `sandbox.ts:105-120,190-197`) proxied into the worker. That is a large change.
- **Firefox:** uses background pages (event pages), not service workers ([MDN background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)). Workers are available there, and our MV2 CSP already allows `worker-src 'self' blob:` (`manifest.json:53`).
- **Transfer cost:** strings are copied by structured clone. A per-script transpile takes about 0.1 to 1 ms, which is comparable to a message round trip. A pool only pays off for big files.

### 8. Swap Sucrase for a WASM transpiler (effort: medium to large, risk: high, win: none or negative for typical scripts)

Not recommended now:
- **Cold start:** 40 to 110 ms to instantiate in each context, and our contexts restart often (SW wake-ups, offscreen doc recreation).
- **Speed:** slower or equal on small scripts.
- **Line numbers:** esbuild, swc, oxc and `transpileModule` all change them, which breaks stack mapping and route `line`s.
- **Module format:** oxc and swc strip-only emit ESM, so we would need our own CommonJS rewrite.
- **CSP in MV3:**
  - WASM in MV3 extension pages needs `'wasm-unsafe-eval'` in `content_security_policy.extension_pages`.
  - The MV3 manifest sets no CSP today (`scripts/build.mjs:126-155`), so WebAssembly is disabled there ([Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)).
  - The sandbox already allows WASM, because `'unsafe-eval'` also permits wasm compilation ([CSP3 §4.5.1](https://w3c.github.io/webappsec-csp/#can-compile-wasm-bytes)).
- **CSP in Firefox:** MV2 currently allows WASM without `'wasm-unsafe-eval'` for backward compatibility. MDN says this isn't guaranteed and recommends declaring it ([MDN content_security_policy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)).
- **AMO review:** AMO requires reviewable source and reproducible build steps for machine-generated code such as WASM ([source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/), [add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)).
- **AMO file size:** the linter's 5 MB parse limit applies to text files ([addons-linter const.js](https://github.com/mozilla/addons-linter/blob/master/src/const.js), [linter.js](https://github.com/mozilla/addons-linter/blob/master/src/linter.js)). A separate `.wasm` file is likely fine. A JS file with inlined wasm (`@swc/wasm-typescript`, 4.05 MB) would be close to the limit.

If a fast path for big files is ever wanted, the least-bad candidate is a hybrid, but it is two passes, so measure it first:
1. swc strip-only for non-JSX files. It preserves lines and is the engine behind Node's type stripping ([amaro README](https://github.com/nodejs/amaro#readme)).
2. Sucrase's `imports`-only transform for CommonJS.

### 9. TypeScript 7 (native Go port) for the Editor (watch, do not adopt yet)

- **Status:**
  - TypeScript 7.0 shipped in July 2026 as a Go port, about 10 times faster, with shared-memory parallelism ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
  - It "does not ship with an API". A new API is expected in 7.1 (same post).
- **WASM build:**
  - A WASM build is milestoned for 7.1 ([TypeScript#63813](https://github.com/microsoft/TypeScript/issues/63813)).
  - An **experimental** `wasip1` `tsc.wasm` that can run in browsers landed in [TypeScript#64174](https://github.com/microsoft/TypeScript/pull/64174), marked "no warranty". It is published as `@typescript/typescript-wasip1-wasm` (7.1 dev builds), and its `tsc.wasm` is 52.8 MB.
- **Monaco:**
  - Monaco's TS support is built on the TS 5.x JS language service API, while TS7's language service speaks LSP.
  - A TypeScript team member notes that Monaco "can now do LSP" ([comment in #63813](https://github.com/microsoft/TypeScript/issues/63813)).
  - Moving the Editor would mean replacing Monaco's TS worker with an LSP client.
- **Size:** about 10 times our largest file. If inlined it exceeds AMO's 5 MB per-file limit; as a separate `.wasm` it relies on the binary exemption holding.
- **Speed in the browser:** Go-compiled WASM has limited threading in browsers, so the native "10x" will not carry over directly.

Revisit once 7.1 is stable and Monaco documents an LSP path.

## What not to do

- **WebGPU for compiling.**
  - Transpiling is lexing, recursive-descent parsing and tree rewriting: data-dependent branches over variable-length strings. That is the opposite of the data-parallel model GPU compute targets ([WebGPU spec](https://www.w3.org/TR/webgpu/)).
  - WGSL has no strings and disallows recursion ([WGSL spec](https://www.w3.org/TR/WGSL/)).
  - The only end-to-end GPU compiler work is a feasibility study for a purpose-built simple language, and it needed every phase redesigned for parallelism ([Voetter, Huijben, Rietveld 2022](https://dl.acm.org/doi/10.1145/3528416.3530249), [Pareas](https://github.com/Snektron/pareas)).
  - Uploading a few KB of source to a GPU would cost more than Sucrase needs to finish.
  - WebGPU also has [limited availability](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) across browsers. Chrome only added it to extension service workers in Chrome 124 ([Chrome blog](https://developer.chrome.com/blog/new-in-webgpu-124)).
- **Switching to esbuild-wasm.**
  - It was the slowest WASM option measured: 22 ms for the samples, against 1.1 ms for Sucrase.
  - It took 190 to 280 ms to start cold, and its binary is 14 MB.
- **`ts.transpileModule` or ts-blank-space in the save path.**
  - `transpileModule` is 7 to 10 times slower than Sucrase and changes line counts.
  - ts-blank-space depends on the full TypeScript parser (an 8.7 MB `typescript.js`) and does neither JSX nor CommonJS.
- **More Monaco TS workers.** There is one language service per mode, and extra workers would not fix the sync-order symptom.
- **`Promise.all` over sandbox calls as "parallel compile".**
  - The sandbox has one thread, so this only interleaves RPC latency.
  - It also races the shared `cacheSig` state in `sandbox.ts`.
  - Batch instead (item 3).

## Sources

- Chrome extension CSP: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- Chrome offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome sandboxed eval: https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval
- Chrome message passing: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- WHATWG HTML, `Worker` exposure: https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface
- CSP Level 3, WebAssembly integration: https://w3c.github.io/webappsec-csp/#can-compile-wasm-bytes
- MDN `content_security_policy` (WebExtensions): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy
- MDN `background` (WebExtensions): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
- AMO source code submission: https://extensionworkshop.com/documentation/publish/source-code-submission/
- AMO add-on policies: https://extensionworkshop.com/documentation/publish/add-on-policies/
- addons-linter file size limit: https://github.com/mozilla/addons-linter/blob/master/src/const.js and https://github.com/mozilla/addons-linter/blob/master/src/linter.js
- Sucrase README: https://github.com/alangpierce/sucrase#readme
- esbuild in the browser: https://esbuild.github.io/api/#browser
- amaro (Node type stripping via SWC): https://github.com/nodejs/amaro#readme
- ts-blank-space: https://github.com/bloomberg/ts-blank-space#readme
- TypeScript 7.0 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- TypeScript WASM build issue: https://github.com/microsoft/TypeScript/issues/63813
- TypeScript wasip1 PR: https://github.com/microsoft/TypeScript/pull/64174
- Monaco TS mode at v0.52.2 (`setEagerModelSync`): https://github.com/microsoft/monaco-editor/blob/v0.52.2/src/language/typescript/tsMode.ts
- Monaco changelog: https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md
- WebGPU spec: https://www.w3.org/TR/webgpu/
- WGSL spec: https://www.w3.org/TR/WGSL/
- MDN WebGPU API: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- WebGPU in extension service workers (Chrome 124): https://developer.chrome.com/blog/new-in-webgpu-124
- Compilation on the GPU? A Feasibility Study (2022): https://dl.acm.org/doi/10.1145/3528416.3530249 and https://github.com/Snektron/pareas
