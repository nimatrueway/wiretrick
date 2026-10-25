/**
 * MV3 sandbox page — the ONLY extension context where MV3 allows eval.
 * (MV3's extension-pages CSP forbids `new Function` everywhere: service
 * worker, offscreen document, options/popup pages. The manifest's
 * "sandbox" key exempts the pages listed there, so user scripts compile
 * and execute HERE and nowhere else in the MV3 build.)
 *
 * Lives in a hidden iframe inside the offscreen document; talks to the
 * service worker through that host page (sandboxed pages have no
 * chrome.* APIs — plain postMessage both ways):
 *
 *   SW ⇄ (chrome.runtime) ⇄ offscreen.ts ⇄ (postMessage) ⇄ sandbox.ts
 *
 * Ops:
 *   analyze — compile scripts, return serializable meta/paramDefs/deps
 *             (reload, popup ⚙ dialog, hook bundle assembly)
 *   compileOne — save-time meta compile of one script, imports resolved
 *             against the given stored scripts (saveScript metadata);
 *             leaves the analyze/run cache alone
 *   pac     — evaluate the user's proxy decision (helper strategy upstream)
 *   rules   — run each `rules`-strategy handler once with a tripwire ctx
 *             and translate it to declarativeNetRequest rule specs
 *   run     — execute the body ops (requestDecision / transform / replace /
 *             responseHeaders) with the same semantics as PageStrategy's
 *             MV2 in-SW execution, mirroring its log lines
 *
 * Reverse calls (wt.storage.* and script logging) travel the other way
 * with the same reqId pattern.
 */
import { compileScript, compileWithLibs, isFatalImportError, makeModuleResolver, makeStubModule, type CompiledScript, type DataFileSource } from "../shared/compile";
import { runOp, type BodyOp, type OpScript } from "../shared/bodyOps";
import { compileDecision } from "../shared/pac";
import "../shared/transpile";
import type { PackageModules } from "../shared/packageImports";
import { scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { probeScriptRules, type ScriptRules } from "../shared/rulesProbe";
import type { Strategy } from "../shared/route";

/**
 * Environment parity with the MV2 background page: sandboxed pages get NO
 * chrome.* APIs, but MV2 scripts compile in a page where chrome exists.
 * A script touching chrome before registering its handlers would die
 * inside its own try/catch and silently compile as a utility (𝑓) — so
 * the sandbox provides a minimal chrome/browser shim (metadata + in-memory
 * storage; reverse-channel ops like wt.storage still go over postMessage
 * via the wt shim, NOT this one).
 */
const EXT_ID = new URLSearchParams(location.search).get("extId") || "sandboxed-extension";
const chromeShim: any = {
    runtime: {
        id: EXT_ID,
        lastError: undefined,
        getManifest: () => ({ version: "0.9.16", manifest_version: 3, name: "Wiretrick" }),
        getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}`,
        sendMessage: (...a: any[]) => {
            const cb = a[a.length - 1];
            if (typeof cb === "function") cb(undefined);
        },
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onConnect: { addListener() {} },
    },
    storage: {
        local: {
            get: (k: any, cb?: any) => {
                const out: any = {};
                cb?.(out);
                return Promise.resolve(out);
            },
            set: (_o: any, cb?: any) => {
                cb?.();
                return Promise.resolve();
            },
        },
    },
    tabs: { create() {}, query() {} },
};
(window as any).chrome = chromeShim;
(window as any).browser = chromeShim; // firefox-style alias some scripts use

interface PlainScript {
    id: string;
    name: string;
    code: string;
    updatedAt: number;
    enabled: boolean;
}

interface AnalyzeResult {
    /** routes, description, active — routes may depend on param values */
    meta: any;
    paramDefs: Record<string, any>;
    error: string | null;
    deps: string[];
}

function post(msg: any): void {
    (window.parent as any).postMessage(msg, "*");
}

/** reverse call: storage / logging, answered by the service worker */
function reverseCall(payload: any): Promise<any> {
    return new Promise((resolve) => {
        const reqId = "rev_" + ++reverseSeq;
        const timer = setTimeout(() => {
            pendingReverse.delete(reqId);
            resolve(undefined);
        }, 10000);
        pendingReverse.set(reqId, (r: any) => {
            clearTimeout(timer);
            resolve(r);
        });
        post({ kind: "reverse", reqId, ...payload });
    });
}
let reverseSeq = 0;
const pendingReverse = new Map<string, (r: any) => void>();

function scriptLog(scriptId: string, level: ScriptLogLevel, msg: string): void {
    void reverseCall({ op: "log", scriptId, level, msg });
}

/** sandbox diagnostics → the SW's debug-log sink (src "[sandbox]") */
function sandboxLog(msg: string, level: "debug" | "info" | "warn" | "error" = "debug"): void {
    void reverseCall({ op: "log", scriptId: null, level, msg: `[sandbox] ${msg}` });
}

// ---- compile cache: metadata + live handlers, invalidated on any change ----

const cache = new Map<string, { s: PlainScript; compiled: CompiledScript; result: AnalyzeResult }>();
let cacheSig = "";

/** the data files and package modules scripts import, as last sent by the SW (only when their signature changes) */
let dataFiles: DataFileSource[] = [];
let packages: PackageModules = { aliases: {}, modules: {} };
let dataSig = "";

/** signature over the script set (incl. name, code hash) + param values + data files */
function compileSignature(scripts: PlainScript[], paramValues: Record<string, any>): string {
    const hash = (s: string): string => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
        return h.toString(36);
    };
    return JSON.stringify([scripts.map((s) => [s.id, s.name, s.updatedAt, s.enabled, hash(s.code)]), paramValues ?? {}, dataSig]);
}

/**
 * Compile every script with the overrides MV2 compiles with: REAL stored
 * param values (the wt shim resolves wt.params over them —
 * handlers that decide via params get the user's values, not defaults) and
 * a reverse-channel storage/log. Recompiles only when the script set or
 * the param values change (runs are per-request — reuse the handlers).
 */
function ensureCompiled(scripts: PlainScript[], paramValues: Record<string, any>): void {
    const sig = compileSignature(scripts, paramValues);
    if (sig === cacheSig && cache.size) return; // unchanged: keep the compiled handlers
    cacheSig = sig;
    cache.clear();
    // per-script overrides: storage is script-scoped (get(key)), routed
    // through the reverse channel to the SW
    const overridesForScript = (sid: string) => ({
        storage: {
            get: (key: string) => reverseCall({ op: "storageGet", scriptId: sid, key }).then((r: any) => r?.value),
            set: (key: string, value: any) => reverseCall({ op: "storageSet", scriptId: sid, key, value }).then(() => undefined),
        },
        paramValues: paramValues?.[sid],
    });
    const resolver = makeModuleResolver(
        scripts.map((s) => ({ id: s.id, name: s.name, code: s.code })),
        (lib) => overridesForScript(lib.id),
        { dataFiles, packages }
    );
    // unknown/missing imports resolve to silent stubs — a script whose
    // import fails must still run its body so its handlers register
    // (otherwise it silently stores as a utility: 𝑓 icon, never matches).
    // A data file or package that fails to import is the importer's compile error.
    let currentDeps: Set<string> | null = null;
    const resolveImport = (importer: string) => (spec: string): any => {
        const before = new Set(resolver.deps);
        try {
            const out = resolver.resolveFrom(importer)(spec);
            sandboxLog(`import "${spec}" → module resolved`, "debug");
            return out;
        } catch (e) {
            if (isFatalImportError(e)) throw e;
            sandboxLog(`import "${spec}" → STUB (no script with that name; its exports are inert in meta-only compiles)`, "debug");
            return makeStubModule();
        } finally {
            if (currentDeps) for (const d of resolver.deps) if (!before.has(d)) currentDeps.add(d);
        }
    };
    for (const s of scripts) {
        const deps = new Set<string>();
        currentDeps = deps;
        const compiledScript = compileScript(s.code, {
            importModule: resolveImport(s.name),
            paramValues: paramValues?.[s.id],
            storage: {
                get: (key: string) => reverseCall({ op: "storageGet", scriptId: s.id, key }).then((r: any) => r?.value),
                set: (key: string, value: any) => reverseCall({ op: "storageSet", scriptId: s.id, key, value }).then(() => undefined),
            },
            logSink: (level, source, text) => scriptLog(s.id, level, scriptLogLine(s.name, source, text)),
        });
        currentDeps = null;
        cache.set(s.id, {
            s,
            compiled: compiledScript,
            result: {
                meta: compiledScript.meta,
                paramDefs: compiledScript.paramDefs || {},
                error: compiledScript.error,
                deps: [...deps],
            },
        });
    }
}

function analyze(scripts: PlainScript[], paramValues: Record<string, any>): { results: Record<string, AnalyzeResult> } {
    // routes may be built from params (wt.onRequest(cfg.hosts.map(...)))
    ensureCompiled(scripts, paramValues ?? {});
    const results: Record<string, AnalyzeResult> = {};
    for (const [, c] of cache) {
        results[c.s.id] = c.result;
        const a = c.result;
        // identify by the CALLER's name (meta.name is a default here)
        const summary = `analyze "${c.s.name}" (${c.s.code.length}b) → active=${a.meta.active} routes=${a.meta.routes.length} match=${JSON.stringify(a.meta.match)} params=[${Object.keys(a.paramDefs).join(", ")}] deps=[${a.deps.join(", ")}]`;
        sandboxLog(a.error ? `${summary} ERROR ${a.error.split("\n")[0]}` : summary, a.error ? "error" : "debug");
        if (!a.error && !a.meta.active && /\bwt\.(onRequest|onResponseHeaders|replaceResponse|onResponseBody|onDocument)\b/.test(c.s.code)) {
            // mentions handlers but none registered at top level (guarded/late calls)
            sandboxLog(`"${c.s.name}" mentions wt.on…/modify…/replace… but registered no handler at top level — it compiles as a library (𝑓)`, "warn");
        }
    }
    return { results };
}

function compileOne(
    target: { id: string; name: string; code: string },
    scripts: { id: string; name: string; code: string }[],
    paramValues: Record<string, any>
): { result: AnalyzeResult } {
    const c = compileWithLibs(target, scripts || [], paramValues || {}, dataFiles, packages);
    const summary = `compileOne "${target.name}" → active=${c.meta.active} params=[${Object.keys(c.paramDefs || {}).join(", ")}] deps=[${c.deps.join(", ")}]`;
    sandboxLog(c.error ? `${summary} ERROR ${c.error.split("\n")[0]}` : summary, c.error ? "error" : "debug");
    return { result: { meta: c.meta, paramDefs: c.paramDefs || {}, error: c.error, deps: c.deps } };
}

// ---- body ops: shared chain semantics (src/shared/bodyOps.ts) ----

function run(scripts: PlainScript[], paramValues: Record<string, any>, op: BodyOp, args: any): Promise<any> {
    // handlers MUST compile with the real stored param values — the MV2
    // parity bug: without them every handler saw defaults and (correctly,
    // per its config) did nothing. Compiled once per (script-set, params)
    // here; matching scripts' cached handlers then run per request.
    ensureCompiled(scripts, paramValues ?? {});
    const list: OpScript[] = [];
    for (const [id, c] of cache) {
        const s = scripts.find((x) => x.id === id);
        if (!s || !s.enabled || !c.result.meta.active) continue;
        list.push({ id, name: s.name, handlers: c.compiled.handlers });
    }
    // tabId/requestId ride along so the SW attributes the line to the right tab and request
    const tabId = typeof args?.tabId === "number" ? args.tabId : -1;
    const requestId = typeof args?.requestId === "string" ? args.requestId : undefined;
    const log = (scriptId: string, level: ScriptLogLevel, msg: string, kind?: string) => void reverseCall({ op: "log", scriptId, level, msg, tabId, netKind: kind, requestId });
    return runOp(list, op, args, { log, debug: (m) => sandboxLog(m, "debug") });
}

// ---- rules strategy: run each rules handler once (src/shared/rulesProbe.ts) ----

async function rules(scripts: PlainScript[], paramValues: Record<string, any>, defaultStrategy: Strategy): Promise<{ results: Record<string, ScriptRules> }> {
    ensureCompiled(scripts, paramValues ?? {});
    const results: Record<string, ScriptRules> = {};
    for (const [id, c] of cache) {
        const s = scripts.find((x) => x.id === id);
        if (!s || !s.enabled || !c.result.meta.active || c.compiled.error) continue;
        const r = await probeScriptRules(c.compiled.handlers, defaultStrategy);
        if (r.rules.length || r.errors.length) results[id] = r;
    }
    return { results };
}

// ---- proxy decisions (helper strategy: evaluate the user's PAC/rules) ----

let pacCache: { source: string; fn: (url: string, host: string) => string } | null = null;

function pacDecision(source: string): (url: string, host: string) => string {
    if (pacCache?.source !== source) pacCache = { source, fn: compileDecision(source) };
    return pacCache.fn;
}

// ---- message pump ----

window.addEventListener("message", async (event) => {
    const data = event.data;
    // only the host page (the offscreen document embedding this iframe) talks to us
    if (!data || event.source !== window.parent) return;
    if (data.kind === "reverseResult") {
        pendingReverse.get(data.reqId)?.(data.result);
        pendingReverse.delete(data.reqId);
        return;
    }
    if (data.kind !== "sandboxCall") return;

    try {
        const { op, scripts, paramValues, runOp: bodyOp, args } = data.payload;
        let result: any;
        if (Array.isArray(data.payload.dataFiles)) {
            dataFiles = data.payload.dataFiles;
            packages = data.payload.packages || { aliases: {}, modules: {} };
            dataSig = data.payload.dataSig;
        }
        if (typeof data.payload.dataSig === "string" && data.payload.dataSig !== dataSig) result = { needDataFiles: true };
        else if (op === "ping") result = { pong: true };
        else if (op === "analyze") result = analyze(scripts, paramValues);
        else if (op === "compileOne") result = compileOne(data.payload.target, scripts, paramValues);
        else if (op === "run") result = await run(scripts, paramValues, bodyOp, args);
        else if (op === "rules") result = await rules(scripts, paramValues, data.payload.defaultStrategy);
        else if (op === "pac") result = { result: pacDecision(data.payload.source)(args.url, args.host) };
        else result = { error: `unknown op ${op}` };
        post({ kind: "sandboxResult", reqId: data.reqId, result });
    } catch (e: any) {
        post({ kind: "sandboxResult", reqId: data.reqId, result: { error: String(e?.message || e) } });
    }
});
