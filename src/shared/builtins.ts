/**
 * Built-in modules: the extension's own valtio (^2.3) and React 19, which
 * script imports of `valtio`, `react`, `react-dom`, … (bare or esm.sh,
 * see builtinSpecs.ts) resolve to — one copy, so `wt.globalStore` proxies and
 * hooks just work.
 *
 * valtio's vanilla parts are bundled with the compiler (they're small and
 * `wt.globalStore` is built on them). React is a separate chunk
 * (`builtins-react.js`, scripts/build.mjs) loaded with a <script> tag only
 * when a script imports it: `ensureBuiltins(codes)` before compiling.
 * `valtio/react` is built over whichever React the importer uses (the
 * built-in, or a Preact file's `preact/compat`).
 */
import * as vanilla from "valtio/vanilla";
import * as vanillaUtils from "valtio/vanilla/utils";
import { createProxy, isChanged } from "proxy-compare";
import { builtinNeedsReact, builtinSpec, preactRoot, preactTarget, REACT_BUILTINS } from "./builtinSpecs";
import { importSpecs } from "./scriptImports";
import type { PackageModules } from "./packageImports";

export const REACT_CHUNK = "builtins-react.js";
const CHUNK_GLOBAL = "__wtBuiltinReact";

export type ReactBuiltins = Record<(typeof REACT_BUILTINS)[number], any>;

let react: ReactBuiltins | null = null;
let loading: Promise<void> | null = null;

/** load the React chunk next to the current page (the MV3 sandbox, the MV2 background page) */
function scriptTagLoader(): Promise<ReactBuiltins> {
    return new Promise((resolve, reject) => {
        const done = () => {
            const r = (globalThis as any)[CHUNK_GLOBAL];
            if (r) resolve(r);
            else reject(new Error(`${REACT_CHUNK} didn't load`));
        };
        if ((globalThis as any)[CHUNK_GLOBAL]) return done();
        if (typeof document === "undefined") return reject(new Error("the built-in React can't load here"));
        const s = document.createElement("script");
        s.src = REACT_CHUNK;
        s.onload = done;
        s.onerror = () => reject(new Error(`${REACT_CHUNK} didn't load`));
        document.head.appendChild(s);
    });
}

let loader: () => Promise<ReactBuiltins> = scriptTagLoader;

/** how the React chunk loads (tests import React directly) */
export function setBuiltinLoader(fn: () => Promise<ReactBuiltins>): void {
    loader = fn;
    react = null;
    loading = null;
}

/** do these sources (scripts, plus downloaded packages) import the built-in React? */
export function needsReact(codes: Iterable<string>, packages?: PackageModules): boolean {
    for (const code of codes)
        for (const spec of importSpecs(code)) {
            const b = builtinSpec(spec);
            if (b && builtinNeedsReact(b, code) && !preactRoot(code)) return true;
        }
    for (const mod of Object.values(packages?.modules ?? {})) for (const spec of Object.keys(mod.requires)) if (builtinSpec(spec)?.startsWith("react")) return true;
    return false;
}

/** load what these sources need before they compile (compiling is synchronous) */
export async function ensureBuiltins(codes: Iterable<string>, packages?: PackageModules): Promise<void> {
    if (react || !needsReact(codes, packages)) return;
    loading ??= loader().then(
        (r) => void (react = r),
        (e) => {
            loading = null;
            throw e;
        }
    );
    await loading;
}

function reactBuiltin(name: string): any {
    if (!react) throw new Error(`cannot import "${name}": the built-in React isn't loaded yet — save the script to load it`);
    return react[name as keyof ReactBuiltins];
}

// ---- valtio/react over a given React ----

const reactBindings = new WeakMap<object, { useSnapshot: any; useProxy: any }>();

/**
 * valtio 2.3's `useSnapshot` and `useProxy` (valtio/src/react.ts and
 * react/utils/useProxy.ts, MIT), bound to the React the importer uses.
 */
function valtioReact(R: any): { useSnapshot: any; useProxy: any } {
    const hit = reactBindings.get(R);
    if (hit) return hit;
    const targetCache = new WeakMap();
    function useSnapshot(proxyObject: object, options?: { sync?: boolean }) {
        const notifyInSync = options?.sync;
        const affected = R.useMemo(() => proxyObject && new WeakMap(), [proxyObject]);
        const lastSnapshot = R.useRef(undefined);
        let inRender = true;
        const currSnapshot = R.useSyncExternalStore(
            R.useCallback(
                (callback: () => void) => {
                    const unsub = vanilla.subscribe(proxyObject, callback, notifyInSync);
                    callback();
                    return unsub;
                },
                [proxyObject, notifyInSync]
            ),
            () => {
                const nextSnapshot = vanilla.snapshot(proxyObject);
                try {
                    if (!inRender && lastSnapshot.current && !isChanged(lastSnapshot.current, nextSnapshot, affected, new WeakMap())) return lastSnapshot.current;
                } catch {}
                return nextSnapshot;
            },
            () => vanilla.snapshot(proxyObject)
        );
        inRender = false;
        R.useLayoutEffect(() => {
            lastSnapshot.current = currSnapshot;
        });
        const proxyCache = R.useMemo(() => new WeakMap(), []);
        return createProxy(currSnapshot, affected, proxyCache, targetCache);
    }
    const DUMMY = Symbol();
    function useProxy(p: object, options?: { sync?: boolean }) {
        const snap: any = useSnapshot(p, options);
        void snap[DUMMY];
        let isRendering = true;
        R.useLayoutEffect(() => {
            isRendering = false;
        });
        return new Proxy(p, { get: (target: any, prop) => (isRendering ? snap[prop] : target[prop]) });
    }
    const out = { useSnapshot, useProxy };
    reactBindings.set(R, out);
    return out;
}

/** `{ ...base }` plus the hooks, resolved only when used (so vanilla-only code doesn't need React) */
function withHooks(base: object, hooks: () => { useSnapshot: any; useProxy: any }, names: ("useSnapshot" | "useProxy")[]): any {
    const out: any = { ...base };
    for (const n of names) Object.defineProperty(out, n, { enumerable: true, get: () => hooks()[n] });
    return out;
}

/**
 * The module a built-in specifier resolves to, for an importer whose
 * source is `code`. `loadUrl` loads a downloaded package (a Preact
 * file's `preact/compat`).
 */
export function builtinModule(spec: string, code = "", loadUrl?: (url: string) => any): any {
    const name = builtinSpec(spec);
    if (!name) throw new Error(`"${spec}" isn't a built-in module`);
    const root = preactRoot(code);
    const mapped = root ? preactTarget(root, name) : null;
    if (mapped) {
        if (!loadUrl) throw new Error(`cannot import "${spec}": Preact isn't available here`);
        return loadUrl(mapped);
    }
    const reactLib = () => (root ? loadUrl!(`${root}/compat`) : reactBuiltin("react"));
    const hooks = () => valtioReact(reactLib());
    switch (name) {
        case "valtio/vanilla":
            return vanilla;
        case "valtio/vanilla/utils":
            return vanillaUtils;
        case "valtio":
            return withHooks(vanilla, hooks, ["useSnapshot"]);
        case "valtio/utils":
            return withHooks(vanillaUtils, hooks, ["useProxy"]);
        case "valtio/react":
            return { useSnapshot: hooks().useSnapshot };
        case "valtio/react/utils":
            return { useProxy: hooks().useProxy };
        default:
            return reactBuiltin(name);
    }
}
