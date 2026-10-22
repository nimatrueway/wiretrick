/**
 * Compiles a Wiretrick source into { meta, handlers }.
 * Runs identically in the background (MV3: the sandbox page) and the page
 * hook — each provides its own minimal `wt` API shim and re-evaluates
 * handler sources with `new Function`.
 */
import { defaultMeta, finishMeta, type ResMeta } from "./metaParser";
import { resolveParamValues, type ParamDef } from "./scriptDef";
import { formatLogArgs, makeScriptConsole, type ScriptLogLevel } from "./scriptLog";
import { scriptFunction } from "./scriptFn";
import { normalizeRoute, type RouteKind, type RouteMeta } from "./route";

export type { DomWhen } from "./route";

export type HandlerFn = (...args: any[]) => any;

/** a registered handler and the route it was registered with */
export interface Routed {
    fn: HandlerFn;
    route: RouteMeta;
}

/**
 * Registrations STACK within a script: multiple wt.onRequest(...) calls
 * all run, in registration order (same semantics as across scripts).
 */
export interface ScriptHandlers {
    onRequest: Routed[];
    onResponseHeaders: Routed[];
    replaceResponse: Routed[];
    modifyResponse: Routed[];
    /** run in the page — DOM/title manipulation (route.when = timing) */
    onDom: Routed[];
}

export interface CompiledScript {
    meta: ResMeta;
    handlers: ScriptHandlers;
    error: string | null;
    /** original full source */
    code: string;
    /** parameter definitions collected from wt.params / wt.defineParam (if any) */
    paramDefs?: Record<string, ParamDef>;
    /** the module's exports (utility scripts: importable by others) */
    exports?: any;
}

import { DECLARE_REMOVED } from "./route";
export { DECLARE_REMOVED };

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
    /** stored parameter values, merged over wt.params defaults */
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
 * Compile from full source. A script is ACTIVE when its top level
 * registers at least one handler; one that registers nothing compiles as
 * a utility module (exports importable, params allowed).
 */
export function compileScript(code: string, overrides?: ResApiOverrides): CompiledScript {
    const meta = defaultMeta();
    const owner = createOwner(meta, overrides?.paramValues);
    const store = createCollector();
    try {
        const js = toRunnableJs(code);
        const moduleObj = { exports: {} as any };
        // eslint-disable-next-line no-new-func
        const fn = scriptFunction(js);
        const shim = makeShim(owner, overrides);
        const requireShim = overrides?.importModule
            ? overrides.importModule
            : (spec: string) => {
                  throw new Error(`cannot import "${spec}" here — imports resolve in the background/hook contexts`);
              };
        withCollector(store, () => fn(shim, makeForwardingConsole(overrides?.logSink), requireShim, moduleObj, moduleObj.exports));
        meta.routes = routesOf(store);
        finishMeta(meta);
        return { meta, handlers: store, error: null, code, paramDefs: owner.defs, exports: moduleObj.exports };
    } catch (e: any) {
        meta.routes = [];
        finishMeta(meta);
        return { meta, handlers: emptyHandlers(), error: e && e.stack ? e.stack : String(e), code, paramDefs: owner.defs };
    }
}

const stubs = new WeakSet<object>();

/** a route that mentions a stubbed import — its real value is only known once imports resolve */
function mentionsStub(route: unknown): boolean {
    const isStub = (x: unknown) => typeof x === "function" && stubs.has(x as object);
    if (isStub(route)) return true;
    const parts: unknown[] = Array.isArray(route) ? route : route && typeof route === "object" ? [(route as any).url, (route as any).exclude] : [];
    return parts.some((p) => isStub(p) || (Array.isArray(p) && p.some(isStub)));
}

/**
 * Module stub for meta-only compiles (scriptStore.saveScript): imports
 * resolve to a callable/gettable proxy so top-level code that references
 * library exports doesn't throw before its handlers register.
 */
export function makeStubModule(): any {
    const stub: any = new Proxy(function () {}, {
        get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
        apply: () => stub,
    });
    stubs.add(stub);
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
        const libOverrides = overridesFor(lib);
        // the lib's own top-level registrations make IT active (it's compiled
        // on its own as a script too); recipes it exports and the importer
        // calls register into the importer's collector
        withCollector(createCollector(), () =>
            scriptFunction(js)(
                makeShim(createOwner(defaultMeta(lib.name), libOverrides.paramValues), libOverrides),
                makeForwardingConsole(libOverrides.logSink),
                resolve,
                moduleObj,
                moduleObj.exports
            )
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
 * whose `import` fails must still run its body so its registrations
 * and params are captured — otherwise it silently stores as a utility.
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

/**
 * The collector stack: registrations go to the script whose top level is
 * running right now (recipes exported by a utility and called from an
 * importer's top level belong to the importer). Empty = too late.
 */
const collectors: ScriptHandlers[] = [];

function withCollector<T>(c: ScriptHandlers, run: () => T): T {
    collectors.push(c);
    try {
        return run();
    } finally {
        collectors.pop();
    }
}

function routesOf(h: ScriptHandlers): RouteMeta[] {
    return [...h.onRequest, ...h.onResponseHeaders, ...h.replaceResponse, ...h.modifyResponse, ...h.onDom].map((x) => x.route);
}

const PARAM_TYPES = ["boolean", "number", "string", "enum", "stringList"];

/** per-script state behind wt.describe / wt.params / wt.defineParam */
function createOwner(meta: ResMeta, storedValues?: Record<string, any>) {
    let defs: Record<string, ParamDef> | undefined;
    return {
        describe(text: unknown) {
            meta.description = String(text ?? "");
        },
        add(next: Record<string, ParamDef>, where: string): Record<string, any> {
            if (!next || typeof next !== "object") throw new Error(`${where}: expected an object of parameter definitions`);
            for (const [k, d] of Object.entries(next)) {
                if (defs && k in defs) throw new Error(`${where}: parameter "${k}" is already defined`);
                if (!d || typeof d !== "object" || !PARAM_TYPES.includes((d as any).type)) {
                    throw new Error(`${where}: parameter "${k}" needs a type (${PARAM_TYPES.join(", ")})`);
                }
                if ((d as any).type === "enum" && !Array.isArray((d as any).choices)) throw new Error(`${where}: enum parameter "${k}" needs choices`);
            }
            defs = { ...(defs || {}), ...next };
            return resolveParamValues(next, storedValues);
        },
        get defs() {
            return defs;
        },
    };
}

function makeShim(owner: ReturnType<typeof createOwner>, overrides?: ResApiOverrides): any {
    const register = (kind: RouteKind) => (route: unknown, fn: unknown) => {
        const top = collectors[collectors.length - 1];
        if (!top) {
            const msg = `wt.${kind} called after the script's top level finished — handlers must be registered synchronously at top level (not after await / in callbacks); ignored`;
            if (overrides?.logSink) overrides.logSink("error", "wt", msg);
            else console.error("[Wiretrick]", msg);
            return;
        }
        if (typeof route === "function" && fn === undefined && !mentionsStub(route)) normalizeRoute(kind, route, 0); // throws the "first argument" error
        if (typeof fn !== "function") throw new Error(`wt.${kind}: second argument must be the handler function`);
        const list = top[kind];
        // save-time compile with stubbed imports: route unknown until analyzed
        const r = mentionsStub(route) ? { kind, index: list.length, url: [], exclude: [] } : normalizeRoute(kind, route, list.length);
        list.push({ fn: fn as HandlerFn, route: r });
    };
    return {
        onRequest: register("onRequest"),
        onResponseHeaders: register("onResponseHeaders"),
        replaceResponse: register("replaceResponse"),
        modifyResponse: register("modifyResponse"),
        onDom: register("onDom"),
        describe: (text: unknown) => owner.describe(text),
        params: (defs: Record<string, ParamDef>) => Object.freeze(owner.add(defs, "wt.params")),
        defineParam: (name: string, def: ParamDef) => {
            if (typeof name !== "string" || !name) throw new Error("wt.defineParam: first argument must be the parameter name");
            return owner.add({ [name]: def }, "wt.defineParam")[name];
        },
        declareScript: () => {
            throw new Error(DECLARE_REMOVED);
        },
        storage: overrides?.storage || {
            get: () => undefined,
            set: () => undefined,
        },
        log: (...args: any[]) => (overrides?.logSink ? overrides.logSink("info", "wt.log", formatLogArgs(args)) : console.log("[Wiretrick] wt.log:", ...args)),
    };
}
