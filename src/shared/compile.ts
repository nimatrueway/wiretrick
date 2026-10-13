/**
 * Compiles a ResScript source into { meta, handlers }.
 * Runs identically in the background page, the Tier-A page hook, and the Tier-B
 * proxy service worker — each provides its own minimal `res` API shim and
 * re-evaluates handler sources with `new Function`.
 */
import { parseMeta, type ResMeta } from "./metaParser";

export type HandlerFn = (...args: any[]) => any;

export interface ScriptHandlers {
    onRequest: HandlerFn | null;
    onResponseHeaders: HandlerFn | null;
    replaceResponse: HandlerFn | null;
    modifyResponse: HandlerFn | null;
    /** run at DOM-ready in the page — DOM/title manipulation */
    onDom: HandlerFn | null;
}

export interface CompiledScript {
    meta: ResMeta;
    handlers: ScriptHandlers;
    error: string | null;
    /** original full source */
    code: string;
}

export interface HandlerSources {
    onRequest: string | null;
    onResponseHeaders: string | null;
    replaceResponse: string | null;
    modifyResponse: string | null;
    onDom: string | null;
}

export interface ResApiOverrides {
    storage?: { get(key: string): Promise<any>; set(key: string, value: any): Promise<void> };
    log?: (...args: any[]) => void;
}

/** Standard overrides for a stored script: storage wired by id, log → sink. */
export function makeScriptOverrides(
    scriptId: string,
    storage: { get(scriptId: string, key: string): Promise<any>; set(scriptId: string, key: string, v: any): Promise<void> },
    logSink: (scriptId: string, msg: string) => void
): ResApiOverrides {
    return {
        storage: {
            get: (key: string) => storage.get(scriptId, key),
            set: (key: string, value: any) => storage.set(scriptId, key, value),
        },
        log: (...args: any[]) =>
            logSink(scriptId, args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
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
        const fn = new Function("res", `"use strict";\n${js}`);
        const store = createCollector();
        fn(makeCollectorShim(store, overrides));
        return { meta, handlers: store, error: null, code };
    } catch (e: any) {
        return { meta, handlers: emptyHandlers(), error: e && e.stack ? e.stack : String(e), code };
    }
}

/** Rebuild handlers from serialized sources (hook / proxy path). */
export function compileFromSources(meta: ResMeta, sources: HandlerSources): CompiledScript {
    const store = createCollector();
    const pairs: [keyof HandlerSources, keyof ScriptHandlers][] = [
        ["onRequest", "onRequest"],
        ["onResponseHeaders", "onResponseHeaders"],
        ["replaceResponse", "replaceResponse"],
        ["modifyResponse", "modifyResponse"],
        ["onDom", "onDom"],
    ];
    for (const [srcKey, hKey] of pairs) {
        const src = sources[srcKey];
        if (src) {
            try {
                // eslint-disable-next-line no-new-func
                store[hKey] = new Function(`return (${src});`)();
            } catch (e) {
                // a handler that fails to rebuild is treated as absent
            }
        }
    }
    return { meta, handlers: store, error: null, code: "" };
}

/** Serialize compiled handlers so they can be shipped to hook/proxy contexts. */
export function serializeHandlers(s: CompiledScript): HandlerSources {
    return {
        onRequest: s.handlers.onRequest ? s.handlers.onRequest.toString() : null,
        onResponseHeaders: s.handlers.onResponseHeaders ? s.handlers.onResponseHeaders.toString() : null,
        replaceResponse: s.handlers.replaceResponse ? s.handlers.replaceResponse.toString() : null,
        modifyResponse: s.handlers.modifyResponse ? s.handlers.modifyResponse.toString() : null,
        onDom: s.handlers.onDom ? s.handlers.onDom.toString() : null,
    };
}

function emptyHandlers(): ScriptHandlers {
    return {
        onRequest: null,
        onResponseHeaders: null,
        replaceResponse: null,
        modifyResponse: null,
        onDom: null,
    };
}

function createCollector(): ScriptHandlers {
    return {
        onRequest: null,
        onResponseHeaders: null,
        replaceResponse: null,
        modifyResponse: null,
        onDom: null,
    };
}

function makeCollectorShim(store: any, overrides?: ResApiOverrides) {
    return {
        onRequest: (fn: HandlerFn) => (store.onRequest = fn),
        onResponseHeaders: (fn: HandlerFn) => (store.onResponseHeaders = fn),
        replaceResponse: (fn: HandlerFn) => (store.replaceResponse = fn),
        modifyResponse: (fn: HandlerFn) => (store.modifyResponse = fn),
        onDom: (fn: HandlerFn) => (store.onDom = fn),
        storage: overrides?.storage || {
            get: () => undefined,
            set: () => undefined,
        },
        log: overrides?.log || ((...args: any[]) => console.log("[ResScript]", ...args)),
    };
}
