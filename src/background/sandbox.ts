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
 *             (saveScript metadata, popup ⚙ dialog, hook bundle assembly)
 *   pac     — evaluate the user's proxy decision (process tier upstream)
 *   run     — execute the body ops (requestDecision / transform / replace /
 *             responseHeaders) with the same semantics as ChromeBodyStrategy's
 *             MV2 in-SW execution, mirroring its log lines
 *
 * Reverse calls (wt.storage.* and script logging) travel the other way
 * with the same reqId pattern.
 */
import { compileScript, makeModuleResolver, makeStubModule, type CompiledScript } from "../shared/compile";
import { runOp, type BodyOp, type OpScript } from "../shared/bodyOps";
import { compileDecision } from "../shared/pac";
import "../shared/transpile";
import { scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";

/**
 * Environment parity with the MV2 background page: sandboxed pages get NO
 * chrome.* APIs, but MV2 scripts compile in a page where chrome exists.
 * A script touching chrome before wt.declareScript would die inside its
 * own try/catch and silently skip the declaration (𝑓 library icon) — so
 * the sandbox provides a minimal chrome/browser shim (metadata + in-memory
 * storage; reverse-channel ops like wt.storage still go over postMessage
 * via the wt shim, NOT this one).
 */
const EXT_ID = new URLSearchParams(location.search).get("extId") || "sandboxed-extension";
const chromeShim: any = {
    runtime: {
        id: EXT_ID,
        lastError: undefined,
        getManifest: () => ({ version: "0.1.0", manifest_version: 3, name: "Wiretrick" }),
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
    meta: any;
    paramDefs: Record<string, any>;
    error: string | null;
    declared: boolean;
    onDom: boolean;
    onDomWhen: string;
    deps: string[];
    /** handler counts — lets the SW's debugger tier pick what to pause */
    handlers: { onRequest: number; modifyResponse: number; replaceResponse: number; onResponseHeaders: number };
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

/** signature over the script set (incl. code hash) + param values */
function compileSignature(scripts: PlainScript[], paramValues: Record<string, any>): string {
    const hash = (s: string): string => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
        return h.toString(36);
    };
    return JSON.stringify([scripts.map((s) => [s.id, s.updatedAt, s.enabled, hash(s.code)]), paramValues ?? {}]);
}

/**
 * Compile every script with the overrides MV2 compiles with: REAL stored
 * param values (the wt shim resolves declareScript's params over them —
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
        (lib) => overridesForScript(lib.id)
    );
    // unknown/missing imports resolve to silent stubs — a script whose
    // import fails must still run its body so declareScript captures
    // (otherwise it silently stores as a library: 𝑓 icon, never matches)
    let currentDeps: Set<string> | null = null;
    const resolveImport = (spec: string): any => {
        const before = new Set(resolver.deps);
        try {
            const out = resolver.resolve(spec);
            sandboxLog(`import "${spec}" → module resolved`, "debug");
            return out;
        } catch {
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
            importModule: resolveImport,
            paramValues: paramValues?.[s.id],
            storage: {
                get: (key: string) => reverseCall({ op: "storageGet", scriptId: s.id, key }).then((r: any) => r?.value),
                set: (key: string, value: any) => reverseCall({ op: "storageSet", scriptId: s.id, key, value }).then(() => undefined),
            },
            logSink: (level, source, text) => scriptLog(s.id, level, scriptLogLine(s.name, source, text)),
        });
        currentDeps = null;
        const onDom = compiledScript.handlers.onDom[0] ?? null;
        cache.set(s.id, {
            s,
            compiled: compiledScript,
            result: {
                meta: compiledScript.meta,
                paramDefs: compiledScript.paramDefs || {},
                error: compiledScript.error,
                declared: compiledScript.meta.declared,
                onDom: !!onDom,
                onDomWhen: onDom ? onDom.when : "DOMContentLoaded",
                deps: [...deps],
                handlers: handlerCounts(compiledScript.handlers),
            },
        });
    }
}

function handlerCounts(h: any): AnalyzeResult["handlers"] {
    return {
        onRequest: h.onRequest?.length || 0,
        modifyResponse: h.modifyResponse?.length || 0,
        replaceResponse: h.replaceResponse?.length || 0,
        onResponseHeaders: h.onResponseHeaders?.length || 0,
    };
}

function analyze(scripts: PlainScript[]): { results: Record<string, AnalyzeResult> } {
    // metadata only: declared/match/paramDefs don't depend on stored values
    ensureCompiled(scripts, {});
    const results: Record<string, AnalyzeResult> = {};
    for (const [, c] of cache) {
        results[c.s.id] = c.result;
        const a = c.result;
        // identify by the CALLER's name (meta.name is declareScript's default)
        const summary = `analyze "${c.s.name}" (${c.s.code.length}b) → declared=${a.declared} match=${JSON.stringify(a.meta.match)} params=[${Object.keys(a.paramDefs).join(", ")}] deps=[${a.deps.join(", ")}]`;
        sandboxLog(a.error ? `${summary} ERROR ${a.error.split("\n")[0]}` : summary, a.error ? "error" : !a.declared ? "warn" : "debug");
        if (!a.error && !a.declared) {
            // the body ran clean but never declared — show the declareScript
            // source line (guarded/conditional calls are the usual cause)
            const line = c.s.code.split("\n").find((l) => l.includes("declareScript"));
            if (line) sandboxLog(`"${c.s.name}" declares via: ${line.trim().slice(0, 160)}`, "warn");
            else sandboxLog(`"${c.s.name}" contains no wt.declareScript call at all — it IS a library (𝑓)`, "warn");
            if (/\bchrome\b/.test(c.s.code) && !line) sandboxLog(`"${c.s.name}" references chrome.* — the sandbox shims a minimal chrome (metadata + storage); full extension APIs are unavailable here`, "warn");
        }
    }
    return { results };
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
        if (!s || !s.enabled || !c.result.declared) continue;
        list.push({ id, name: s.name, match: c.result.meta.match, phase: c.result.meta.phase, handlers: c.compiled.handlers });
    }
    // tabId rides along so the SW attributes the line to the right tab
    const tabId = typeof args?.tabId === "number" ? args.tabId : -1;
    const log = (scriptId: string, level: ScriptLogLevel, msg: string) => void reverseCall({ op: "log", scriptId, level, msg, tabId });
    return runOp(list, op, args, { log, debug: (m) => sandboxLog(m, "debug") });
}

// ---- proxy decisions (process tier: evaluate the user's PAC/rules) ----

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
        if (op === "ping") result = { pong: true };
        else if (op === "analyze") result = analyze(scripts);
        else if (op === "run") result = await run(scripts, paramValues, bodyOp, args);
        else if (op === "pac") result = { result: pacDecision(data.payload.source)(args.url, args.host) };
        else result = { error: `unknown op ${op}` };
        post({ kind: "sandboxResult", reqId: data.reqId, result });
    } catch (e: any) {
        post({ kind: "sandboxResult", reqId: data.reqId, result: { error: String(e?.message || e) } });
    }
});
