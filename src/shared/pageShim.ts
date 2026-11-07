/**
 * The `wt` object a script sees when its page handlers compile in the
 * site's JavaScript world (hook.ts: `wt.onSite` handlers; bridge.ts: the
 * same when the page CSP forbids eval there) or the isolated world
 * (bridge.ts in MV2, isolated.ts in MV3: `wt.onPage` handlers). Network
 * registrations and overlay handlers are inert here (they run in the
 * background / the overlay); this world's handlers are collected with
 * their routes (the other world's are skipped), and params resolve to the
 * raw values the background shipped in the bundle (each def's `parse`
 * runs here, in the page).
 *
 * Each onSite / onPage / onOverlay registration is a handle named by its
 * route's `key` (`"onPage:0"`, shared/rpc.ts). With an `exposer`, this
 * world's handlers expose what they return (`firePageHandler`). In the
 * isolated world a handle calls its handler wherever it runs (`call`); in
 * the site's world no handle can be called (siteRemote), and the stores
 * aren't there.
 */
import { normalizeRoute, placeApi, placeKeyer, placeKind, routeMatches, type DocumentWhen, type PageWorld, type PlaceApi, type RouteMeta } from "./route";
import { inertRemote, siteRemote, SITE_NO_STORES, type SiteCannotCallError } from "./remote";
import type { Exposer } from "./rpc";
import { parseParamValue, type ParamDef } from "./scriptDef";
import { scriptEnv } from "./scriptEnv";
import { claimStoreName, storePersist } from "./storeOps";

export interface PageDocumentHandler {
    /** its RPC handle id: the route's key (`"onPage:0"`) */
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
    /** which handlers this shim collects: "page" (wt.onSite, the default) or "isolated" (wt.onPage) */
    world?: PageWorld;
    /** answers calls into this world's handles */
    exposer?: Exposer;
    /**
     * isolated world: a handle → what calls it (`api`: where its handler
     * runs); absent: handles are inert (a library's)
     */
    call?: (api: PlaceApi, key: string) => any;
    /** site's world: a handle's function was called (it throws SiteCannotCallError; its stack is the caller's) */
    onSiteCall?: (e: SiteCannotCallError) => void;
    /** the script's store replicas (`wt.pageStore`: this page's copy): the isolated world only */
    stores?: PageStores;
}

export interface PageStores {
    store(name: string, initial: object, persist: boolean | string[]): object;
    pageStore(name: string, initial: object): object;
}

const fail = (): never => {
    throw new Error(SITE_NO_STORES);
};
const noStore = new Proxy(Object.create(null), { get: (_t, p) => (p === "then" || typeof p === "symbol" ? undefined : fail()), set: fail, has: fail, ownKeys: fail, deleteProperty: fail });
const NO_FETCH = "wt.fetch isn't available in page code — use the page's own fetch";
/** a library's handles: its handlers don't run */
const LIB_HANDLE = "handles from an imported library don't connect; register the handler in the script itself";

export function makePageShim(o: PageShimOptions): { wt: any; dom: PageDocumentHandler[] } {
    const dom: PageDocumentHandler[] = [];
    const world = o.world || "page";
    const mine: PlaceApi = world === "page" ? "onSite" : "onPage";
    const inert = () => {};
    const keyOf = placeKeyer();
    // registrations always count, so indexes match the background's
    let pageIndex = 0;
    let overlayIndex = 0;
    const register = (api: PlaceApi) => (route: unknown, fn: unknown, n?: number) => {
        if (typeof fn !== "function") throw new Error(`wt.${api}: second argument must be the handler function`);
        const kind = placeKind(api);
        const r = normalizeRoute(kind, route, kind === "onOverlay" ? overlayIndex++ : pageIndex++, api);
        const k = keyOf(api, n);
        r.key = k.key;
        if (api !== "onOverlay" && k.n !== r.index) r.n = k.n;
        if (api === mine) {
            o.exposer?.register(k.key);
            dom.push({ h: k.key, route: r, when: r.when || "document_end", fn: fn as any });
        }
        if (world === "page") return siteRemote(o.onSiteCall);
        return o.call ? o.call(api, k.key) : inertHandle();
    };
    const stores = world === "isolated" ? o.stores : undefined;
    const names = new Map<string, string>();
    const parsed = (key: string, def: ParamDef | undefined) => (def && typeof def === "object" ? parseParamValue(key, def, o.params[key]) : o.params[key]);
    const wt = {
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: inert,
        onResponseBody: inert,
        onSite: placeApi(register("onSite")),
        onPage: placeApi(register("onPage")),
        onOverlay: placeApi(register("onOverlay")),
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
    return { wt, dom };
}

function inertHandle(): any {
    return inertRemote(LIB_HANDLE);
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
