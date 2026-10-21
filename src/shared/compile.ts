/**
 * Compiles a Wiretrick source into { meta, handlers }.
 * Runs identically in the background (MV3: the sandbox page) and the page
 * hook — each provides its own minimal `wt` API shim and re-evaluates
 * handler sources with `new Function`.
 */
import { defaultMeta, type ResMeta } from "./metaParser";
import { resolveParamValues } from "./scriptDef";
import { formatLogArgs, makeScriptConsole, type ScriptLogLevel } from "./scriptLog";
import { scriptFunction } from "./scriptFn";

export type HandlerFn = (...args: any[]) => any;

/** When an onDom handler should fire (2nd argument of wt.onDom). */
export type DomWhen = "document_start" | "document_end" | "document_idle" | "DOMContentLoaded";

/** Options for the onDom hook (2nd argument of wt.onDom). */
export interface DomOptions {
    /** see Wiretrick.DomOptions.when in src/types/wt-api.d.ts (the user-facing docs) */
    when?: DomWhen;
}

/**
 * Registrations STACK within a script: multiple wt.onRequest(...) calls
 * all run, in registration order (same semantics as across scripts).
 */
export interface ScriptHandlers {
    onRequest: HandlerFn[];
    onResponseHeaders: HandlerFn[];
    replaceResponse: HandlerFn[];
    modifyResponse: HandlerFn[];
    /** run at DOM-ready in the page — DOM/title manipulation */
    onDom: { fn: HandlerFn; when: DomWhen }[];
}

export interface CompiledScript {
    meta: ResMeta;
    handlers: ScriptHandlers;
    error: string | null;
    /** original full source */
    code: string;
    /** parameter definitions collected from wt.declareScript (if any) */
    paramDefs?: Record<string, import("./scriptDef").ParamDef>;
    /** the module's exports (library scripts: importable by others) */
    exports?: any;
}

export interface HandlerSources {
    onRequest: string[] | null;
    onResponseHeaders: string[] | null;
    replaceResponse: string[] | null;
    modifyResponse: string[] | null;
    /** JSON: [{ when, src }] */
    onDom: string | null;
}

/** true if the value looks like a Promise (thenable). */
export function isThenable(v: any): v is Promise<any> {
    return !!v && typeof v.then === "function";
}

/** true if the function was declared `async` (returns a Promise by construction). */
export function isAsyncFn(fn: any): boolean {
    return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

export interface ResApiOverrides {
    storage?: { get(key: string): Promise<any>; set(key: string, value: any): Promise<void> };
    /** receives the script's wt.log and console.* output (source: "wt.log", "console.warn", …) */
    logSink?: (level: ScriptLogLevel, source: string, text: string) => void;
    /** stored parameter values, merged over declareScript defaults */
    paramValues?: Record<string, any>;
    /** resolves ES import specifiers ("./utils", "utils") to module exports */
    importModule?: (spec: string) => any;
}

/** Standard overrides for a stored script: storage wired by id, log → sink. */
export function makeScriptOverrides(
    scriptId: string,
    storage: { get(scriptId: string, key: string): Promise<any>; set(scriptId: string, key: string, v: any): Promise<void> },
    logSink: (scriptId: string, level: ScriptLogLevel, source: string, text: string) => void,
    paramValues?: Record<string, any>,
    importModule?: (spec: string) => any
): ResApiOverrides {
    return {
        storage: {
            get: (key: string) => storage.get(scriptId, key),
            set: (key: string, value: any) => storage.set(scriptId, key, value),
        },
        logSink: (level, source, text) => logSink(scriptId, level, source, text),
        paramValues,
        importModule,
    };
}

type Transpiler = (code: string) => string;
let transpiler: Transpiler | null = null;

/** Register the TS stripper (done by the background via shared/transpile). */
export function setTranspiler(fn: Transpiler): void {
    transpiler = fn;
}

/**
 * Scripts may be written in TypeScript. Where a transpiler was registered
 * (background), types are stripped with formatting preserved; contexts
 * without one (the page hook) receive already-transpiled code.
 */
export function toRunnableJs(code: string): string {
    if (!transpiler) return code;
    try {
        return transpiler(code);
    } catch {
        return code;
    }
}

/**
 * Compile from full source (background storage path). The ONLY way to
 * activate a script is wt.declareScript — a source without it compiles
 * as a library module (handlers inert, exports importable).
 */
export function compileScript(code: string, overrides?: ResApiOverrides): CompiledScript {
    const meta = defaultMeta();
    try {
        const js = toRunnableJs(code);
        const moduleObj = { exports: {} as any };
        // eslint-disable-next-line no-new-func
        const fn = scriptFunction(js);
        const store = createCollector();
        const declare = createDeclareShim(meta, overrides?.paramValues);
        const shim = makeCollectorShim(store, overrides);
        shim.declareScript = declare.run;
        const requireShim = overrides?.importModule
            ? overrides.importModule
            : (spec: string) => {
                  throw new Error(`cannot import "${spec}" here — imports resolve in the background/hook contexts`);
              };
        fn(shim, makeForwardingConsole(overrides?.logSink), requireShim, moduleObj, moduleObj.exports);
        return { meta, handlers: store, error: null, code, paramDefs: declare.defs, exports: moduleObj.exports };
    } catch (e: any) {
        return { meta, handlers: emptyHandlers(), error: e && e.stack ? e.stack : String(e), code };
    }
}

/**
 * Module stub for meta-only compiles (scriptStore.saveScript): imports
 * resolve to a callable/gettable proxy so top-level code that references
 * library exports doesn't throw before declareScript runs.
 */
export function makeStubModule(): any {
    const stub: any = new Proxy(function () {}, {
        get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
        apply: () => stub,
    });
    return stub;
}

/**
 * Module registry over the stored scripts: ES `import ... from "./utils"`
 * resolves against script names (case-insensitive, "./x", "x.ts" all match
 * the script named "x"). Libs compile lazily and memoize; circular imports
 * get the partially-initialized exports.
 */
export function makeModuleResolver(
    scripts: { id: string; name: string; code: string }[],
    overridesFor: (s: { id: string; name: string; code: string }) => ResApiOverrides
): { resolve: (spec: string) => any; deps: Set<string> } {
    const cache = new Map<string, any>();
    const compiling = new Set<string>();
    const deps = new Set<string>();
    const norm = (spec: string) =>
        spec
            .replace(/^\.\//, "")
            .replace(/\.(ts|js)$/, "")
            .toLowerCase();
    const byKey = new Map<string, { id: string; name: string; code: string }>();
    for (const s of scripts) {
        const key = s.name.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
        if (!byKey.has(key)) byKey.set(key, s);
        const plain = s.name.toLowerCase();
        if (!byKey.has(plain)) byKey.set(plain, s);
    }
    const resolve = (spec: string): any => {
        const key = norm(spec);
        if (cache.has(key)) return cache.get(key);
        const lib = byKey.get(key);
        if (!lib) throw new Error(`unknown module "${spec}" — no script named "${spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "")}"`);
        deps.add(lib.name);
        if (compiling.has(key)) return cache.get(key); // cycle: partial exports
        compiling.add(key);
        const moduleObj = { exports: {} as any };
        cache.set(key, moduleObj.exports); // early, for cycles
        const js = toRunnableJs(lib.code);
        // eslint-disable-next-line no-new-func
        scriptFunction(js)(
            makeCollectorShim(createCollector(), overridesFor(lib)),
            makeForwardingConsole(overridesFor(lib).logSink),
            resolve,
            moduleObj,
            moduleObj.exports
        );
        compiling.delete(key);
        cache.set(key, moduleObj.exports);
        return moduleObj.exports;
    };
    return { resolve, deps };
}

/**
 * Wrap a module resolver so unknown/missing imports resolve to a silent
 * stub instead of throwing. Used by the MV3 sandbox analyze path (and
 * anywhere meta capture must not depend on the import graph): a script
 * whose `import` fails must still run its body so wt.declareScript
 * captures match/params — otherwise it silently stores as a library.
 */
export function resolveWithStubFallback(resolve: (spec: string) => any): (spec: string) => any {
    return (spec) => {
        try {
            return resolve(spec);
        } catch {
            return makeStubModule();
        }
    };
}

/** Rebuild handlers from serialized sources (hook path). */
export function compileFromSources(meta: ResMeta, sources: HandlerSources): CompiledScript {
    const store = createCollector();
    const rebuild = (src: string): HandlerFn => {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${src});`)();
    };
    for (const key of ["onRequest", "onResponseHeaders", "replaceResponse", "modifyResponse"] as const) {
        const srcs = sources[key];
        if (srcs) for (const src of srcs) {
            try { store[key].push(rebuild(src)); } catch { /* absent */ }
        }
    }
    if (sources.onDom) {
        try {
            const list = JSON.parse(sources.onDom) as { when: DomWhen; src: string }[];
            for (const d of list) {
                try { store.onDom.push({ fn: rebuild(d.src), when: d.when }); } catch {}
            }
        } catch {}
    }
    return { meta, handlers: store, error: null, code: "" };
}

/** Serialize compiled handlers so they can be shipped to the hook context. */
export function serializeHandlers(s: CompiledScript): HandlerSources {
    const arr = (fns: HandlerFn[]) => (fns.length ? fns.map((f) => f.toString()) : null);
    return {
        onRequest: arr(s.handlers.onRequest),
        onResponseHeaders: arr(s.handlers.onResponseHeaders),
        replaceResponse: arr(s.handlers.replaceResponse),
        modifyResponse: arr(s.handlers.modifyResponse),
        onDom: s.handlers.onDom.length
            ? JSON.stringify(s.handlers.onDom.map((d) => ({ when: d.when, src: d.fn.toString() })))
            : null,
    };
}

function emptyHandlers(): ScriptHandlers {
    return createCollector();
}

function createCollector(): ScriptHandlers {
    return {
        onRequest: [],
        onResponseHeaders: [],
        replaceResponse: [],
        modifyResponse: [],
        onDom: [],
    };
}

/** Console shadow for compiled scripts: routed into the script's log sink. */
function makeForwardingConsole(sink?: ResApiOverrides["logSink"]): Console {
    return sink ? makeScriptConsole(sink) : console;
}

function makeCollectorShim(store: any, overrides?: ResApiOverrides): any {
    return {
        onRequest: (fn: HandlerFn) => { store.onRequest.push(fn); },
        onResponseHeaders: (fn: HandlerFn) => { store.onResponseHeaders.push(fn); },
        replaceResponse: (fn: HandlerFn) => { store.replaceResponse.push(fn); },
        modifyResponse: (fn: HandlerFn) => { store.modifyResponse.push(fn); },
        onDom: (fn: HandlerFn, opts?: DomOptions) => {
            store.onDom.push({ fn, when: opts?.when || "DOMContentLoaded" });
        },
        // replaced per-compile by the meta-applying variant
        declareScript: (def: any) => def?.params || {},
        storage: overrides?.storage || {
            get: () => undefined,
            set: () => undefined,
        },
        log: (...args: any[]) => (overrides?.logSink ? overrides.logSink("info", "wt.log", formatLogArgs(args)) : console.log("[Wiretrick] wt.log:", ...args)),
    };
}

/**
 * Builds wt.declareScript: applies match/strategy onto the
 * script's meta and marks it declared, collects param defs, and returns
 * the resolved param values for the script to use.
 */
function createDeclareShim(meta: ResMeta, storedValues?: Record<string, any>) {
    const state: { defs?: Record<string, import("./scriptDef").ParamDef> } = {};
    const run = (def: import("./scriptDef").ScriptDef): any => {
        if (!def || typeof def !== "object") return {};
        meta.declared = true;
        if (def.match?.length) meta.match = [...def.match];
        if (def.strategy?.length) meta.strategy = def.strategy.join(",");
        if (def.params) {
            state.defs = def.params;
            return resolveParamValues(def.params, storedValues);
        }
        return {};
    };
    return { run, get defs() { return state.defs; } };
}
