/**
 * Compiles a Wiretrick source into { meta, handlers }.
 * Runs identically in the background (MV3: the sandbox page) and the page
 * hook — each provides its own minimal `wt` API shim and re-evaluates
 * handler sources with `new Function`.
 */
import { defaultMeta, finishMeta, type ResMeta } from "./metaParser";
import { parseParamValue, resolveParamValues, serializableParamDef, type ParamDef } from "./scriptDef";
import { formatLogArgs, makeScriptConsole, type ScriptLogLevel } from "./scriptLog";
import { scriptFunction } from "./scriptFn";
import { callerLine } from "./scriptError";
import { normalizeRoute, type RouteKind, type RouteMeta } from "./route";
import { inertRemote, REMOTE_FROM_BACKGROUND } from "./remote";
import { scriptEnv } from "./scriptEnv";
import { importLine, importPath, importResolver, isDataSpec } from "./scriptImports";
import { isUrlSpec, makePackageLoader, PackageImportError, type PackageModules } from "./packageImports";
import { builtinModule } from "./builtins";
import { builtinSpec } from "./builtinSpecs";
import { proxy } from "valtio/vanilla";
import type { StorePersist, WireRequest, WireResponse } from "./wire";
import { fromWireResponse, splitFetchInit, toWireRequest, type WtFetchInit } from "./wtFetch";

export type { DocumentWhen } from "./route";

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
    onResponseBody: Routed[];
    /** wt.onPage / wt.onDocument: run in the page — DOM/title manipulation (route.when = timing, route.world) */
    onDocument: Routed[];
    /** wt.onOverlay: run in the script's overlay frame above the page */
    onOverlay: Routed[];
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
    /** `wt.store`: the script's replicated store (default: a plain local valtio proxy) */
    store?: (name: string, initial: object, persist: StorePersist) => object;
    /** `wt.fetch(…, { from: "background" })` (default: this context's own fetch, no bypass) */
    fetch?: (request: WireRequest, bypass: boolean) => Promise<WireResponse>;
    /** `wt.fetch(…, { from: "page" })`, then the default `from` (the overlay); `url` resolves relative URLs */
    pageFetch?: { url: string; fetch: (request: WireRequest, bypass: boolean) => Promise<WireResponse> };
    /** what `wt.onPage` / `wt.onOverlay` registration number `index` returns (default: an inert handle) */
    remote?: (kind: "onDocument" | "onOverlay", index: number) => any;
}

/** Standard overrides for a stored script: storage wired by id, log → sink. */
export function makeScriptOverrides(
    scriptId: string,
    storage: { get(scriptId: string, key: string): Promise<any>; set(scriptId: string, key: string, v: any): Promise<void> },
    logSink: (scriptId: string, level: ScriptLogLevel, source: string, text: string) => void,
    paramValues?: Record<string, any>,
    importModule?: (spec: string) => any,
    extra?: Pick<ResApiOverrides, "store" | "fetch">
): ResApiOverrides {
    return {
        ...extra,
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
    let syntax: any = null;
    try {
        let js = code;
        try {
            if (transpiler) js = transpiler(code);
        } catch (e) {
            syntax = e;
        }
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
        // the raw TS that the failed transpile left is rejected wherever its
        // first type is, without a position: the transpiler's error has the real one
        const at = e?.name === "SyntaxError" && syntax?.loc?.line;
        const error = at ? `SyntaxError: ${String(syntax.message).replace(/\s*\(\d+:\d+\)$/, "")} (line ${at})` : e && e.stack ? e.stack : String(e);
        return { meta, handlers: emptyHandlers(), error, code, paramDefs: owner.defs };
    }
}

const stubs = new WeakSet<object>();

/** a value that came from a stubbed import (meta-only compiles) */
function isStub(x: unknown): boolean {
    return typeof x === "function" && stubs.has(x as object);
}

/** a route that mentions a stubbed import — its real value is only known once imports resolve */
function mentionsStub(route: unknown): boolean {
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

/** a data file as the compilers see it: its path (with `.json`) and text */
export interface DataFileSource {
    path: string;
    text: string;
}

/**
 * Importing a data file failed (missing, invalid JSON). Never stubbed:
 * the importer (transitively) fails to compile, positioned at its import
 * line (`(line N)`, rewritten at each level as it propagates).
 */
class DataFileImportError extends Error {
    fatalImport = true;
}

/** a data file or package import error: never stubbed (see PackageImportError) */
export function isFatalImportError(e: unknown): boolean {
    return !!(e && (e as any).fatalImport === true);
}

function at(e: any, code: string | undefined, spec: string): any {
    const line = code === undefined ? undefined : importLine(code, spec);
    e.stack = line ? `Error: ${e.message} (line ${line})` : `Error: ${e.message}`;
    return e;
}

/** offset of the first character `JSON.parse` rejects (V8's "Unexpected token" message has no position) */
function jsonErrorOffset(text: string): number {
    let i = 0;
    const fail = (): never => {
        throw i;
    };
    const ws = () => {
        while (" \t\n\r".includes(text[i] ?? "x")) i++;
    };
    const str = () => {
        for (i++; text[i] !== '"'; i++) {
            if (i >= text.length || text[i] < " ") fail();
            if (text[i] === "\\") i++;
        }
        i++;
    };
    const value = (): void => {
        ws();
        const c = text[i];
        if (c === '"') return str();
        if (c !== "{" && c !== "[") {
            const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
            if (!m) fail();
            i += m![0].length;
            return;
        }
        const close = c === "{" ? "}" : "]";
        i++;
        ws();
        if (text[i] === close) return void i++;
        for (;;) {
            if (c === "{") {
                ws();
                if (text[i] !== '"') fail();
                str();
                ws();
                if (text[i] !== ":") fail();
                i++;
            }
            value();
            ws();
            if (text[i] === close) return void i++;
            if (text[i] !== ",") fail();
            i++;
        }
    };
    try {
        value();
        ws();
        return i;
    } catch (at) {
        return at as number;
    }
}

/** `JSON.parse` error → "path:line:col message" (positions from V8's "at position N", Firefox's "line L column C", or located) */
function jsonError(path: string, text: string, e: any): string {
    const msg = String(e?.message ?? e);
    let line: number;
    let col: number;
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const pos = /at position (\d+)/.exec(msg);
    if (lc) [line, col] = [Number(lc[1]), Number(lc[2])];
    else {
        const off = pos ? Number(pos[1]) : /end of (JSON )?(input|data)/i.test(msg) ? text.length : jsonErrorOffset(text);
        const before = text.slice(0, off).split("\n");
        [line, col] = [before.length, before[before.length - 1].length + 1];
    }
    const clean = msg
        .replace(/^JSON\.parse:\s*/, "")
        .replace(/\s*(in JSON )?at position \d+.*$/, "")
        .replace(/\s*at line \d+ column \d+.*$/, "")
        .replace(/, "[\s\S]*" is not valid JSON$/, "");
    return `${path}:${line}:${col} is not valid JSON — ${clean}`;
}

/** parse a data file's text (fresh each import: handlers mutating it don't leak across scripts) */
function parseDataFile(spec: string, d: DataFileSource): any {
    try {
        return JSON.parse(d.text);
    } catch (e) {
        throw new DataFileImportError(`cannot import "${spec}": ${jsonError(d.path, d.text, e)}`);
    }
}

/**
 * Module registry over the stored scripts and data files: an ES `import`
 * resolves like TypeScript (shared/scriptImports: relative to the
 * importer's folder, bare from the root, case-insensitive, "./x", "x.ts"
 * match the script named "x", "./a.json" the data file). Libs compile
 * lazily and memoize; circular imports get the partially-initialized
 * exports. `resolveFrom(name)` is the `require` of the script named
 * `name`; `resolve` resolves from the root. A URL imports a downloaded
 * package (shared/packageImports). `deps` collects the imported script
 * names, data file paths and package URLs.
 */
export function makeModuleResolver(
    scripts: { id: string; name: string; code: string }[],
    overridesFor: (s: { id: string; name: string; code: string }) => ResApiOverrides,
    opts?: { stubUnresolved?: boolean; dataFiles?: DataFileSource[]; packages?: PackageModules }
): { resolve: (spec: string) => any; resolveFrom: (importer: string) => (spec: string) => any; deps: Set<string> } {
    const cache = new Map<string, any>();
    const compiling = new Set<string>();
    const deps = new Set<string>();
    const dataFiles = opts?.dataFiles || [];
    const lookup = importResolver(
        scripts.map((s) => s.name),
        dataFiles.map((d) => d.path)
    );
    const byName = new Map<string, { id: string; name: string; code: string }>();
    for (const s of scripts) if (!byName.has(s.name)) byName.set(s.name, s);
    // a downloaded package's own `require("react")` gets the built-in too (one React copy), unless it's React itself
    const loadPackage = makePackageLoader(opts?.packages, (spec, from) => {
        if (!builtinSpec(spec) || /^https:\/\/unpkg\.com\/(react|react-dom|scheduler|valtio)@/.test(from)) return undefined;
        return { module: builtinModule(spec) };
    });
    const requires = new Map<string, (spec: string) => any>();
    const resolveFrom = (importer: string): ((spec: string) => any) => {
        let r = requires.get(importer);
        if (!r) requires.set(importer, (r = (spec) => {
            try {
                return load(importer, spec);
            } catch (e) {
                throw isFatalImportError(e) ? at(e, byName.get(importer)?.code, spec) : e;
            }
        }));
        return r;
    };
    const load = (importer: string, spec: string): any => {
        if (builtinSpec(spec) && (isUrlSpec(spec) || !lookup(importer, spec))) {
            try {
                return builtinModule(spec, byName.get(importer)?.code, (url) => {
                    deps.add(url);
                    return loadPackage(url);
                });
            } catch (e: any) {
                if (isFatalImportError(e)) throw e;
                if (opts?.stubUnresolved) return makeStubModule(); // meta-only, React not loaded
                throw new PackageImportError(e?.message ?? String(e));
            }
        }
        if (isUrlSpec(spec)) {
            deps.add(spec);
            return loadPackage(spec);
        }
        const found = lookup(importer, spec);
        if (!found) {
            if (isDataSpec(spec)) {
                const path = importPath(importer, spec);
                throw new DataFileImportError(`cannot import "${spec}": ${path ? `no data file "${path}"` : "the path goes above the root folder"}`);
            }
            if (opts?.stubUnresolved) return makeStubModule();
            throw new Error(`unknown module "${spec}" — no script named "${spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "")}"`);
        }
        if (found.kind === "data") {
            deps.add(found.path);
            return parseDataFile(spec, dataFiles.find((d) => d.path === found.path)!);
        }
        const key = found.name;
        if (cache.has(key)) return cache.get(key);
        const lib = byName.get(key)!;
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
        try {
            withCollector(createCollector(), () =>
                scriptFunction(js)(
                    makeShim(createOwner(defaultMeta(lib.name), libOverrides.paramValues), libOverrides),
                    makeForwardingConsole(libOverrides.logSink),
                    resolveFrom(lib.name),
                    moduleObj,
                    moduleObj.exports
                )
            );
        } catch (e) {
            compiling.delete(key);
            if (isFatalImportError(e)) {
                cache.delete(key);
                throw e;
            }
            if (!opts?.stubUnresolved) throw e;
            // meta-only: a broken library is inert, not the importer's compile error
            const stub = makeStubModule();
            cache.set(key, stub);
            return stub;
        }
        compiling.delete(key);
        cache.set(key, moduleObj.exports);
        return moduleObj.exports;
    };
    return { resolve: resolveFrom(""), resolveFrom, deps };
}

/**
 * Meta-only compile of one script against the stored scripts (save time):
 * imports resolve to the REAL libraries where a script by that name exists
 * — params/routes built from imported values (e.g. a param definition
 * exported by a utility) are captured — and to silent stubs otherwise.
 * `target` replaces any stored script with the same id.
 */
export function compileWithLibs(
    target: { id: string; name: string; code: string },
    scripts: { id: string; name: string; code: string }[],
    paramValues?: { [scriptId: string]: Record<string, any> | undefined },
    dataFiles?: DataFileSource[],
    packages?: PackageModules
): CompiledScript & { deps: string[] } {
    const resolver = makeModuleResolver(
        [target, ...scripts.filter((s) => s.id !== target.id)],
        (lib) => ({ paramValues: paramValues?.[lib.id] }),
        { stubUnresolved: true, dataFiles, packages }
    );
    const c = compileScript(target.code, { importModule: resolver.resolveFrom(target.name), paramValues: paramValues?.[target.id] });
    return { ...c, deps: [...resolver.deps] };
}

/**
 * Wrap a module resolver so unknown/missing imports resolve to a silent
 * stub instead of throwing. Used by the MV3 sandbox analyze path (and
 * anywhere meta capture must not depend on the import graph): a script
 * whose `import` fails must still run its body so its registrations
 * and params are captured — otherwise it silently stores as a utility.
 * A data file or package that fails to import is still the importer's error.
 */
export function resolveWithStubFallback(resolve: (spec: string) => any): (spec: string) => any {
    return (spec) => {
        try {
            return resolve(spec);
        } catch (e) {
            if (isFatalImportError(e)) throw e;
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
        onResponseBody: [],
        onDocument: [],
        onOverlay: [],
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
    return [...h.onRequest, ...h.onResponseHeaders, ...h.replaceResponse, ...h.onResponseBody, ...h.onDocument, ...h.onOverlay].map((x) => x.route);
}

const PARAM_TYPES = ["boolean", "number", "string", "enum", "stringList"];

/** per-script state behind wt.about / wt.params / wt.defineParam */
function createOwner(meta: ResMeta, storedValues?: Record<string, any>) {
    let defs: Record<string, ParamDef> | undefined;
    return {
        about(text: unknown) {
            meta.description = String(text ?? "");
        },
        add(next: Record<string, ParamDef>, where: string): Record<string, any> {
            // defs that come from a stubbed import (meta-only compiles) are
            // unknown here, not invalid: skip them — their values read as
            // stubs — instead of failing the whole script
            if (isStub(next)) return next;
            if (!next || typeof next !== "object") throw new Error(`${where}: expected an object of parameter definitions`);
            // `known` keeps the parsers (to resolve values); `defs` — stored,
            // messaged, diffed — holds them stripped
            const known: Record<string, ParamDef> = {};
            const unknown: Record<string, any> = {};
            for (const [k, d] of Object.entries(next)) {
                if (defs && k in defs) throw new Error(`${where}: parameter "${k}" is already defined`);
                if (isStub(d) || (d && typeof d === "object" && Object.values(d).some(isStub))) {
                    unknown[k] = makeStubModule();
                    continue;
                }
                if (!d || typeof d !== "object" || !PARAM_TYPES.includes((d as any).type)) {
                    throw new Error(`${where}: parameter "${k}" needs a type (${PARAM_TYPES.join(", ")})`);
                }
                if ((d as any).type === "enum" && !Array.isArray((d as any).choices)) throw new Error(`${where}: enum parameter "${k}" needs choices`);
                known[k] = d;
            }
            if (Object.keys(known).length) defs = { ...(defs || {}), ...Object.fromEntries(Object.entries(known).map(([k, d]) => [k, serializableParamDef(d)])) };
            const raw = resolveParamValues(known, storedValues);
            const values = Object.fromEntries(Object.entries(known).map(([k, d]) => [k, parseParamValue(k, d, raw[k])]));
            return { ...values, ...unknown };
        },
        get defs() {
            return defs;
        },
    };
}

/** `wt.store`'s `persist` option, checked */
function storePersist(name: string, opts: unknown): StorePersist {
    if (opts === undefined || opts === null) return true;
    if (typeof opts !== "object") throw new TypeError(`wt.store("${name}"): the third argument must be an options object`);
    const p = (opts as { persist?: unknown }).persist;
    if (p === undefined) return true;
    if (typeof p === "boolean") return p;
    if (Array.isArray(p) && p.every((k) => typeof k === "string")) return [...p];
    throw new TypeError(`wt.store("${name}"): persist must be true, false or a list of top-level field names`);
}

/** `wt.store` for one compiled instance: each name once */
function makeStore(overrides?: ResApiOverrides): (name: string, initial: object, opts?: unknown) => object {
    const names = new Set<string>();
    return (name, initial, opts) => {
        // save-time compile: arguments built from a stubbed import aren't known yet
        if (isStub(name) || isStub(initial) || isStub(opts)) return makeStubModule();
        if (typeof name !== "string" || !name) throw new TypeError("wt.store: the first argument must be the store's name (a non-empty string)");
        if (names.has(name)) throw new Error(`wt.store("${name}"): this script already has a store named "${name}" — a name may be used once per script (call wt.store at top level and share the result)`);
        const persist = storePersist(name, opts);
        if (!initial || typeof initial !== "object" || Array.isArray(initial)) throw new TypeError(`wt.store("${name}"): initial must be an object`);
        const out = overrides?.store ? overrides.store(name, initial, persist) : proxy(initial);
        names.add(name);
        return out;
    };
}

/** `wt.fetch`: background code, or the overlay (with `pageFetch`) */
function makeFetch(overrides?: ResApiOverrides): (input: RequestInfo | URL, init?: WtFetchInit) => Promise<Response> {
    return async (input, init) => {
        const { init: rest, from, bypass } = splitFetchInit(init);
        const page = overrides?.pageFetch;
        if (page && from !== "background") return fromWireResponse(await page.fetch(await toWireRequest(input, rest, page.url), bypass));
        if (from === "page") throw new Error('wt.fetch: from: "page" fetches as the page, which only an overlay (wt.onOverlay) can do — background code uses from: "background"');
        if (!overrides?.fetch) return fetch(input, { credentials: "include", ...rest });
        return fromWireResponse(await overrides.fetch(await toWireRequest(input, rest), bypass));
    };
}

/** `wt.storage.set("$store:…")` writes behind a store's back: warn (the store owns the key) */
function guardStoreKeys(storage: { get(key: string): any; set(key: string, value: any): any }, overrides?: ResApiOverrides) {
    return {
        get: (key: string) => storage.get(key),
        set: (key: string, value: any) => {
            if (typeof key === "string" && key.startsWith("$store:")) {
                const msg = `wt.storage.set("${key}"): that key is the persisted copy of wt.store("${key.slice(7)}") — change the store instead (the store overwrites this on its next save)`;
                if (overrides?.logSink) overrides.logSink("warn", "wt", msg);
                else console.warn("[Wiretrick]", msg);
            }
            return storage.set(key, value);
        },
    };
}

function makeShim(owner: ReturnType<typeof createOwner>, overrides?: ResApiOverrides): any {
    const register = (kind: RouteKind, api?: "onPage") => (route: unknown, fn: unknown) => {
        const name = api || kind;
        const top = collectors[collectors.length - 1];
        // page/overlay registrations hand back an RPC handle; in the background it's inert
        const remote = (index: number) => (kind !== "onDocument" && kind !== "onOverlay" ? undefined : index >= 0 && overrides?.remote ? overrides.remote(kind, index) : inertRemote(REMOTE_FROM_BACKGROUND));
        if (!top) {
            const msg = `wt.${name} called after the script's top level finished — handlers must be registered synchronously at top level (not after await / in callbacks); ignored`;
            if (overrides?.logSink) overrides.logSink("error", "wt", msg);
            else console.error("[Wiretrick]", msg);
            return remote(-1);
        }
        if (typeof route === "function" && fn === undefined && !mentionsStub(route)) normalizeRoute(kind, route, 0, api); // throws the "first argument" error
        if (typeof fn !== "function") throw new Error(`wt.${name}: second argument must be the handler function`);
        const list = top[kind];
        // save-time compile with stubbed imports: route unknown until analyzed
        const r: RouteMeta = mentionsStub(route) ? { kind, index: list.length, url: [], exclude: [], ...(api ? { api } : {}) } : normalizeRoute(kind, route, list.length, api);
        const line = callerLine();
        if (line) r.line = line;
        list.push({ fn: fn as HandlerFn, route: r });
        return remote(r.index);
    };
    return {
        onRequest: register("onRequest"),
        onResponseHeaders: register("onResponseHeaders"),
        replaceResponse: register("replaceResponse"),
        onResponseBody: register("onResponseBody"),
        onPage: register("onDocument", "onPage"),
        onDocument: register("onDocument"),
        onOverlay: register("onOverlay"),
        about: (text: unknown) => owner.about(text),
        params: (defs: Record<string, ParamDef>) => {
            const values = owner.add(defs, "wt.params");
            return isStub(values) ? values : Object.freeze(values); // a stub proxy can't be frozen
        },
        defineParam: (name: string, def: ParamDef) => {
            if (typeof name !== "string" || !name) throw new Error("wt.defineParam: first argument must be the parameter name");
            return owner.add({ [name]: def }, "wt.defineParam")[name];
        },
        storage: guardStoreKeys(overrides?.storage || {
            get: () => undefined,
            set: () => undefined,
        }, overrides),
        store: makeStore(overrides),
        fetch: makeFetch(overrides),
        log: (...args: any[]) => (overrides?.logSink ? overrides.logSink("info", "wt.log", formatLogArgs(args)) : console.log("[Wiretrick] wt.log:", ...args)),
        ...scriptEnv(),
    };
}

/** a `wt.onPage` / `wt.onOverlay` call that isn't at the script's top level */
export interface RegistrationProblem {
    api: "onPage" | "onOverlay";
    /** the call's 1-based line */
    line: number;
    /** 0-based: which `wt.<api>(` call of the source it is (onPage counts onDocument too) */
    nth: number;
}

const NESTING = /\b(?:if|else|for|while|do|switch|try|catch|finally)\b|=>|&&|\|\||\?/;

/**
 * `wt.onPage` / `wt.onOverlay` calls that aren't plain top-level
 * statements (inside a function, block, condition or loop): the page and
 * the overlay match handles by registration order, so a registration that
 * runs in one context and not the other would mix them up. A lightweight
 * scan (comments, strings and templates skipped), not a parser.
 */
export function registrationProblems(code: string): RegistrationProblem[] {
    const out: RegistrationProblem[] = [];
    const counts = { onPage: 0, onOverlay: 0 };
    let depth = 0;
    let line = 1;
    /** depth-0 text since the last statement boundary */
    let stmt = "";
    let prev = ""; // the last significant character (regex vs division)
    const n = code.length;
    let i = 0;
    const boundary = () => {
        stmt = "";
    };
    while (i < n) {
        const c = code[i];
        if (c === "\n") {
            line++;
            // a newline ends a depth-0 statement unless the next line continues it
            if (depth === 0 && !/(?:^\s*(?:if|for|while)\s*\(.*\)|^\s*(?:else|do)|[=(,:?&|+\-*/%<>!~^[{.])\s*$/.test(stmt) && !/^\s*[.?:&|+\-*/,]/.test(code.slice(i + 1, i + 40))) boundary();
            else if (depth === 0) stmt += c;
            i++;
            continue;
        }
        if (c === "/" && code[i + 1] === "/") {
            while (i < n && code[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && code[i + 1] === "*") {
            const end = code.indexOf("*/", i + 2);
            const stop = end < 0 ? n : end + 2;
            for (let j = i; j < stop; j++) if (code[j] === "\n") line++;
            i = stop;
            continue;
        }
        if (c === '"' || c === "'" || c === "`" || (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)))) {
            // a string, template or regex literal: skip it (a template's ${…} counts as nested code)
            const quote = c;
            let cls = false;
            i++;
            while (i < n) {
                const d = code[i];
                if (d === "\\") {
                    i += 2;
                    continue;
                }
                if (d === "\n") {
                    line++;
                    if (quote !== "`") break;
                }
                if (quote === "/") {
                    if (d === "[") cls = true;
                    else if (d === "]") cls = false;
                    else if (d === "/" && !cls) break;
                }
                if (quote === "`" && d === "$" && code[i + 1] === "{") {
                    // nested code: scan it for calls (all nested) by brace depth
                    let k = i + 2;
                    let inner = 1;
                    while (k < n && inner) {
                        if (code[k] === "{") inner++;
                        else if (code[k] === "}") inner--;
                        else if (code[k] === "\n") line++;
                        k++;
                    }
                    const sub = code.slice(i + 2, k - 1);
                    for (const m of sub.matchAll(/\bwt\s*\.\s*(onPage|onDocument|onOverlay)\s*(?:<[^()]*>\s*)?\(/g)) {
                        const api = m[1] === "onOverlay" ? "onOverlay" : "onPage";
                        if (m[1] !== "onDocument") out.push({ api, line, nth: counts[api] });
                        counts[api]++;
                    }
                    i = k;
                    continue;
                }
                if (d === quote) break;
                i++;
            }
            i++;
            prev = "a";
            if (depth === 0) stmt += "0";
            continue;
        }
        const call = c === "w" && /^wt\s*\.\s*(onPage|onDocument|onOverlay)\s*(?:<[^()]*>\s*)?\(/.exec(code.slice(i, i + 40));
        if (call && !/[\w$.]/.test(code[i - 1] || "")) {
            const api = call[1] === "onOverlay" ? "onOverlay" : "onPage";
            if (call[1] !== "onDocument" && (depth > 0 || NESTING.test(stmt))) out.push({ api, line, nth: counts[api] });
            counts[api]++;
        }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") {
            depth = Math.max(0, depth - 1);
            if (depth === 0 && c === "}") {
                boundary();
                prev = "}";
                i++;
                continue;
            }
        } else if (c === ";" && depth === 0) {
            boundary();
            prev = ";";
            i++;
            continue;
        }
        if (depth === 0 && !(c === "{" || c === "(" || c === "[")) stmt += c;
        else if (depth === 1 && (c === "(" || c === "[" || c === "{")) stmt += c;
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return out;
}
