/**
 * The `wt` object a script sees when its onPage handlers compile in the
 * page (hook.ts, MAIN world: `js: "page"` handlers) or the isolated world
 * (bridge.ts: default-world handlers, and the page-world CSP fallback).
 * Network registrations and overlay handlers are inert here (they run in
 * the background / the overlay); onPage registrations for this shim's
 * `world` are collected with their routes (the other world's are skipped),
 * and params resolve to the raw values the background shipped in the
 * bundle (each def's `parse` runs here, in the page).
 *
 * With an `exposer`, each onPage registration is a handle the overlay can
 * call (`"page:N"`, shared/rpc.ts): this world's handlers expose what they
 * return (`firePageHandler`), the other world's are marked elsewhere.
 *
 * `wt.onPage({ dom: "overlay" })` registers an overlay handler: with
 * `overlay`, it returns a live handle (isolated world, top frame). With
 * `js: "page"` too, it's the page-world layer (`layers`): the hook runs
 * it with its own `document`; everywhere else it's skipped and its handle
 * is inert.
 */
import { isPageLayer, normalizeRoute, pageCallKind, pageWorld, routeMatches, type DocumentWhen, type PageWorld, type RouteMeta } from "./route";
import { inertRemote, REMOTE_MAIN_WORLD, REMOTE_PAGE_LAYER } from "./remote";
import { NOT_RUNNING, TOP_FRAME_ONLY, type Exposer } from "./rpc";
import { parseParamValue, type ParamDef } from "./scriptDef";
import { scriptEnv } from "./scriptEnv";
import { claimStoreName, storePersist } from "./storeOps";

export interface PageDocumentHandler {
    /** its RPC handle id (`"page:N"`) */
    h: string;
    route: RouteMeta;
    when: DocumentWhen;
    fn: (ctx: any) => any;
}

export interface PageShimOptions {
    /** resolved RAW param values (from the bundle) */
    params: Record<string, any>;
    log: (...args: any[]) => void;
    storage: { get(key: string): any; set(key: string, value: any): any };
    /** which onPage handlers this shim collects (default "page") */
    world?: PageWorld;
    /** answers the overlay's calls into this script's onPage handles */
    exposer?: Exposer;
    /** why the other world's handles don't answer here (default: not running) */
    otherWorld?: string;
    /**
     * `"overlay:N"` → its handle: the isolated world, and `unsafe: true`
     * page-world code (absent in page world: calls are rejected)
     */
    overlay?: (h: string) => any;
    /** page world without `overlay`: a call into the overlay (rejected; its error has the caller's stack) */
    onMainWorldCall?: (e: Error) => void;
    /**
     * the script's store replicas (`wt.pageStore`: this page's copy): the
     * isolated world, and `unsafe: true` page-world code (the page can read
     * and forge them); absent: using a store throws NO_STORE
     */
    stores?: PageStores;
}

export interface PageStores {
    store(name: string, initial: object, persist: boolean | string[]): object;
    pageStore(name: string, initial: object): object;
}

export const NO_STORE = 'wt.globalStore and wt.pageStore aren\'t available in page-world code (the page could read and forge them) — use them in isolated onPage code (the default: drop js: "page"; read the page with ctx.evaluate) or the overlay — or, accepting that the page can then read and forge this script\'s stores, add unsafe: true to its js: "page" routes';
const fail = (): never => {
    throw new Error(NO_STORE);
};
const noStore = new Proxy(Object.create(null), { get: (_t, p) => (p === "then" || typeof p === "symbol" ? undefined : fail()), set: fail, has: fail, ownKeys: fail, deleteProperty: fail });
const NO_FETCH = "wt.fetch isn't available in page code — use the page's own fetch";

export function makePageShim(o: PageShimOptions): { wt: any; dom: PageDocumentHandler[]; layers: PageDocumentHandler[] } {
    const dom: PageDocumentHandler[] = [];
    const layers: PageDocumentHandler[] = [];
    const world = o.world || "page";
    const inert = () => {};
    // registrations always count, so indexes match the background's
    let pageIndex = 0;
    let overlayIndex = 0;
    let pageCalls = 0;
    const onPage = (route: unknown, fn: unknown) => {
        if (typeof fn !== "function") throw new Error("wt.onPage: second argument must be the handler function");
        if (pageCallKind(route) === "onOverlay") {
            const r = normalizeRoute("onOverlay", route, overlayIndex++, "onPage");
            if (pageCalls !== r.index) r.n = pageCalls;
            pageCalls++;
            const h = `overlay:${r.index}`;
            if (!isPageLayer(r)) return overlayHandle(h);
            layers.push({ h, route: r, when: r.when || "document_end", fn: fn as any });
            return inertRemote(REMOTE_PAGE_LAYER);
        }
        const r = normalizeRoute("onDocument", route, pageIndex++, "onPage");
        if (pageCalls !== r.index) r.n = pageCalls;
        pageCalls++;
        const h = `page:${r.index}`;
        if (pageWorld(r) === world) {
            o.exposer?.register(h);
            dom.push({ h, route: r, when: r.when || "document_end", fn: fn as any });
        } else o.exposer?.elsewhere(h, o.otherWorld ?? NOT_RUNNING);
        return inertRemote("page functions are called from this script's overlay, not from page code");
    };
    const overlayHandle = (h: string) => {
        if (o.overlay) return o.overlay(h);
        return world === "page" ? inertRemote(REMOTE_MAIN_WORLD, o.onMainWorldCall) : inertRemote(TOP_FRAME_ONLY);
    };
    const stores = o.stores;
    const names = new Map<string, string>();
    const parsed = (key: string, def: ParamDef | undefined) => (def && typeof def === "object" ? parseParamValue(key, def, o.params[key]) : o.params[key]);
    const wt = {
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: inert,
        onResponseBody: inert,
        onPage,
        // without stores, declaring one at top level is fine (that code runs here too); using it isn't
        globalStore: (name: string, initial: object, opts?: unknown) => {
            if (!stores) return noStore;
            claimStoreName(names, "wt.globalStore", name, initial);
            names.set(name, "wt.globalStore");
            return stores.store(name, initial, storePersist(name, opts));
        },
        pageStore: (name: string, initial: object) => {
            if (!stores) return noStore;
            claimStoreName(names, "wt.pageStore", name, initial);
            names.set(name, "wt.pageStore");
            return stores.pageStore(name, initial);
        },
        fetch: () => Promise.reject(new Error(NO_FETCH)),
        metadata: inert,
        params: (defs: Record<string, ParamDef>) => Object.freeze(Object.fromEntries(Object.entries(defs || {}).map(([k, d]) => [k, parsed(k, d)]))),
        defineParam: (name: string, def: ParamDef) => parsed(name, def),
        log: o.log,
        storage: o.storage,
        ...scriptEnv(),
    };
    return { wt, dom, layers };
}

/** the handlers whose route matches this frame's URL (the others' handles answer `not running`) */
export function domHandlersFor(dom: PageDocumentHandler[], url: string, exposer?: Exposer): PageDocumentHandler[] {
    return dom.filter((h) => {
        const on = routeMatches(h.route, url);
        if (!on) exposer?.fail(h.h);
        return on;
    });
}

/** run a handler; what it returns is what its handle exposes (a throw: `not running`, rethrown) */
export function firePageHandler(d: PageDocumentHandler, ctx: any, exposer?: Exposer, onError?: (e: unknown) => void): void {
    let out: unknown;
    try {
        out = d.fn(ctx);
    } catch (e) {
        exposer?.fail(d.h);
        throw e;
    }
    // an async handler's rejection: an error like a thrown one
    if (onError && out && typeof (out as any).then === "function") (out as Promise<unknown>).then(undefined, onError);
    exposer?.expose(d.h, out);
}

/** run `run` at the handler's `when` (immediately when `now`) */
export function scheduleDocument(when: DocumentWhen, run: () => void, now = false): void {
    if (now || when === "document_start") run();
    else if (when === "document_idle") {
        if (document.readyState === "complete") run();
        else window.addEventListener("load", run, { once: true });
    } else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    else run();
}
