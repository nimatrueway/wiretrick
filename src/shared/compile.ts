/**
 * Compiles a ResScript source into { meta, handlers }.
 * Runs identically in the background page, the Tier-A page hook, and the Tier-B
 * proxy service worker — each provides its own minimal `res` API shim and
 * re-evaluates handler sources with `new Function`.
 */
import { parseMeta, type ResMeta } from "./metaParser";
import { resolveParamValues } from "./scriptDef";

export type HandlerFn = (...args: any[]) => any;

/** When an onDom handler should fire (2nd argument of res.onDom). */
export type DomWhen = "document_start" | "document_end" | "document_idle" | "DOMContentLoaded";

/** Options for the onDom hook (2nd argument of res.onDom). */
export interface DomOptions {
    /**
     * When to run the handler:
     *  - "DOMContentLoaded" (default) — full DOM parsed, before hydration
     *  - "document_start" — immediately at hook install (DOM barely exists;
     *    use for registering observers before page scripts run)
     *  - "document_end" — DOM parsed (same as DOMContentLoaded in practice)
     *  - "document_idle" — after `load` (page fully settled; safest for
     *    measuring final state)
     */
    when?: DomWhen;
}

/**
 * Registrations STACK within a script: multiple res.onRequest(...) calls
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
    /** parameter definitions collected from res.declareScript (if any) */
    paramDefs?: Record<string, import("./scriptDef").ParamDef>;
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
    log?: (...args: any[]) => void;
    /** receives formatted console.log/warn/error from user scripts */
    consoleSink?: (level: "info" | "warn" | "error", msg: string) => void;
    /** stored parameter values, merged over declareScript defaults */
    paramValues?: Record<string, any>;
}

/** Standard overrides for a stored script: storage wired by id, log → sink. */
export function makeScriptOverrides(
    scriptId: string,
    storage: { get(scriptId: string, key: string): Promise<any>; set(scriptId: string, key: string, v: any): Promise<void> },
    logSink: (scriptId: string, msg: string) => void,
    consoleSink?: (scriptId: string, level: "info" | "warn" | "error", msg: string) => void,
    paramValues?: Record<string, any>
): ResApiOverrides {
    return {
        storage: {
            get: (key: string) => storage.get(scriptId, key),
            set: (key: string, value: any) => storage.set(scriptId, key, value),
        },
        log: (...args: any[]) =>
            logSink(scriptId, args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
        consoleSink: consoleSink ? (level, msg) => consoleSink(scriptId, level, msg) : undefined,
        paramValues,
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

/** Compile from full source (background storage path). */
export function compileScript(code: string, overrides?: ResApiOverrides): CompiledScript {
    const meta = parseMeta(code);
    try {
        const js = toRunnableJs(code);
        // eslint-disable-next-line no-new-func
        const fn = new Function("res", "console", `"use strict";\n${js}`);
        const store = createCollector();
        const declare = createDeclareShim(meta, overrides?.paramValues);
        const shim = makeCollectorShim(store, overrides);
        shim.declareScript = declare.run;
        fn(shim, makeForwardingConsole(overrides?.consoleSink));
        return { meta, handlers: store, error: null, code, paramDefs: declare.defs };
    } catch (e: any) {
        return { meta, handlers: emptyHandlers(), error: e && e.stack ? e.stack : String(e), code };
    }
}

/** Rebuild handlers from serialized sources (hook / proxy path). */
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

/** Serialize compiled handlers so they can be shipped to hook/proxy contexts. */
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

/** Console shadow for compiled scripts: mirrors into the UI log sink. */
function makeForwardingConsole(sink?: ResApiOverrides["consoleSink"]): Console {
    if (!sink) return console;
    const fmt = (args: any[]) =>
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    const wrap = (level: "info" | "warn" | "error") => (...args: any[]) => {
        // eslint-disable-next-line no-console
        (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(...args);
        sink(level, fmt(args));
    };
    return {
        log: wrap("info"),
        info: wrap("info"),
        debug: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
    } as unknown as Console;
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
        log: overrides?.log || ((...args: any[]) => console.log("[ResScript]", ...args)),
    };
}

/**
 * Builds res.declareScript: applies name/match/strategy/runAt onto the
 * parsed meta (comment block stays as the fallback), collects param defs,
 * and returns the resolved param values for the script to use.
 */
function createDeclareShim(meta: ResMeta, storedValues?: Record<string, any>) {
    const state: { defs?: Record<string, import("./scriptDef").ParamDef> } = {};
    const run = (def: import("./scriptDef").ScriptDef): any => {
        if (!def || typeof def !== "object") return {};
        if (def.name) meta.name = def.name;
        if (def.match?.length) meta.match = [...def.match];
        if (def.include?.length) meta.include = [...def.include];
        if (def.strategy?.length) meta.strategy = def.strategy.join(",");
        if (def.runAt) meta.runAt = def.runAt;
        if (def.params) {
            state.defs = def.params;
            return resolveParamValues(def.params, storedValues);
        }
        return {};
    };
    return { run, get defs() { return state.defs; } };
}
