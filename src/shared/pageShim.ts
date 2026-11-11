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
import { inertRemote, LIB_SITE_STORE, siteRemote, SITE_NO_STORES, unusableStore, type SiteCannotCallError } from "./remote";
import type { Exposer } from "./rpc";
import type { Generation, ScriptLife } from "./runLifecycle";
import { parseParamValue, type ParamDef } from "./scriptDef";
import { libBodyRunning } from "./scriptImports";
import { paramsProxy, PARAM_AT_TOP, PARAM_NOT_HERE, PARAM_ON_SITE } from "./paramsProxy";
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
     * runs, `route`: its route); absent: handles are inert (a library's)
     */
    call?: (api: PlaceApi, key: string, route: RouteMeta) => any;
    /** site's world: a handle's function was called (it throws SiteCannotCallError; its stack is the caller's) */
    onSiteCall?: (e: SiteCannotCallError) => void;
    /** the script's store replicas (`wt.pageStore`: this page's copy): the isolated world only */
    stores?: PageStores;
    /** `wt.siteStore`: the site's world's store (onSite code) or a mirror of it (absent: a library's, which throws when used) */
    siteStore?: (name: string, initial: object) => object;
    /**
     * a library's shim (its name): what its code registers while a
     * script's top level runs (`top`) — a function it exports, called by
     * the script — is the script's; its own top level's isn't
     */
    lib?: string;
    /**
     * a param the code assigned (`cfg.on = false`), to be saved — `lib`:
     * a library's (this shim's `lib`). Absent: params can't change here
     * (onSite code never can).
     */
    setParam?: (key: string, value: any, lib?: string) => Promise<void>;
}

type Register = (api: PlaceApi) => (route: unknown, fn: unknown, n?: number, lib?: string) => any;
/** the script whose top level is running (PageShim.top): where libraries' registrations go */
let running: Register | null = null;

export interface PageStores {
    store(name: string, initial: object, persist: boolean | string[]): object;
    pageStore(name: string, initial: object): object;
}

const noStore = unusableStore(SITE_NO_STORES);
const libSiteStore = unusableStore(LIB_SITE_STORE);
const NO_FETCH = "wt.fetch isn't available in page code — use the page's own fetch";
/** a library's handles: its handlers don't run */
const LIB_HANDLE = "handles from an imported library don't connect; register the handler in the script itself";

export interface PageShim {
    wt: any;
    dom: PageDocumentHandler[];
    /** run the script's top level (`run`): libraries' functions it calls register into it, like the background's */
    top<T>(run: () => T): T;
}

export function makePageShim(o: PageShimOptions): PageShim {
    const dom: PageDocumentHandler[] = [];
    const world = o.world || "page";
    const mine: PlaceApi = world === "page" ? "onSite" : "onPage";
    const inert = () => {};
    const keyOf = placeKeyer();
    // registrations always count, so indexes match the background's
    let pageIndex = 0;
    let overlayIndex = 0;
    const own: Register = (api) => (route, fn, n, lib) => {
        if (typeof fn !== "function") throw new Error(`wt.${api}: second argument must be the handler function`);
        const kind = placeKind(api);
        const r = normalizeRoute(kind, route, kind === "onOverlay" ? overlayIndex++ : pageIndex++, api);
        const k = keyOf(api, n, lib);
        r.key = k.key;
        if (lib !== undefined) {
            r.lib = lib;
            r.n = k.n;
        } else if (api !== "onOverlay" && k.n !== r.index) r.n = k.n;
        if (api === mine) {
            o.exposer?.register(k.key);
            dom.push({ h: k.key, route: r, when: r.when || "document_end", fn: fn as any });
        }
        if (world === "page") return siteRemote(o.onSiteCall);
        return o.call ? o.call(api, k.key, r) : inertHandle();
    };
    const register = (api: PlaceApi) => (route: unknown, fn: unknown, n?: number) =>
        o.lib !== undefined && running && !libBodyRunning() ? running(api)(route, fn, n, o.lib) : own(api)(route, fn, n);
    const stores = world === "isolated" ? o.stores : undefined;
    const names = new Map<string, string>();
    const siteNames = new Map<string, string>();
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
        siteStore: (name: string, initial: object) => {
            if (!o.siteStore) return libSiteStore;
            claimStoreName(siteNames, "wt.siteStore", name, initial);
            siteNames.set(name, "wt.siteStore");
            return o.siteStore(name, initial);
        },
        fetch: () => Promise.reject(new Error(NO_FETCH)),
        metadata: inert,
        params: (defs: Record<string, ParamDef>) => {
            const known = Object.fromEntries(Object.entries(defs || {}).filter(([, d]) => d && typeof d === "object"));
            const unknown = Object.fromEntries(Object.entries(defs || {}).filter(([, d]) => !d || typeof d !== "object").map(([k]) => [k, o.params[k]]));
            return paramsProxy(known, o.params, unknown, {
                blocked: () => (world === "page" ? PARAM_ON_SITE : running || libBodyRunning() ? PARAM_AT_TOP : o.setParam ? undefined : PARAM_NOT_HERE),
                send: (k, v) => void o.setParam!(k, v, o.lib).catch(() => {}),
            });
        },
        defineParam: (name: string, def: ParamDef) => parsed(name, def),
        log: o.log,
        storage: o.storage,
        ...scriptEnv(),
    };
    const top = <T>(run: () => T): T => {
        const prev = running;
        running = own;
        try {
            return run();
        } finally {
            running = prev;
        }
    };
    return { wt, dom, top };
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

/**
 * Run a handler; what it returns is what its handle exposes. A throw is
 * rethrown, and the handle answers from the previous run when there's one
 * still alive (a failed reload), else `not running`.
 */
export function firePageHandler(d: PageDocumentHandler, ctx: any, exposer?: Exposer, onError?: (e: unknown) => void): unknown {
    let out: unknown;
    try {
        out = d.fn(ctx);
    } catch (e) {
        exposer?.revert(d.h);
        throw e;
    }
    // an async handler's rejection: an error like a thrown one
    if (onError && out && typeof (out as any).then === "function") (out as Promise<unknown>).then(undefined, onError);
    exposer?.expose(d.h, out);
    return out;
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

/** the ctx every page handler starts from */
export const pageCtxBase = (url: string) => ({ url, method: "GET", tabUrl: url, resourceType: "main_frame", requestHeaders: {}, groups: {} });

/** run handler `d` as a run of `gen` (shared/runLifecycle.ts): its ctx gets signal, once, patch, style, mount, each */
export function fireRun(life: ScriptLife, gen: Generation, d: PageDocumentHandler, base: object | ((signal: AbortSignal) => object), exposer: Exposer | undefined, report: (e: unknown) => void): void {
    life.fire(gen, d.h, report, (ctx, quiet) => firePageHandler(d, { ...(typeof base === "function" ? base(ctx.signal) : base), ...ctx }, exposer, quiet));
}
