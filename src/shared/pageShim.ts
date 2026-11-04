/**
 * The `wt` object a script sees when its onPage (alias onDocument) handlers
 * compile in the page (hook.ts, MAIN world) or the isolated world (bridge.ts:
 * `world: "isolated"` handlers, and the main-world CSP fallback).
 * Network and onOverlay registrations are inert here (they run in the
 * background / the overlay); onPage registrations for this shim's `world`
 * are collected with their routes (the other world's are skipped), and params resolve
 * to the raw values the background shipped in the bundle (each def's
 * `parse` runs here, in the page).
 *
 * With an `exposer`, each onPage registration is a handle the overlay can
 * call (`"page:N"`, shared/rpc.ts): this world's handlers expose what they
 * return (`firePageHandler`), the other world's are marked elsewhere. With
 * `overlay`, `wt.onOverlay` returns a live handle (isolated world, top frame).
 */
import { normalizeRoute, pageWorld, routeMatches, type DocumentWhen, type PageWorld, type RouteMeta } from "./route";
import { inertRemote, REMOTE_MAIN_WORLD } from "./remote";
import { NOT_RUNNING, TOP_FRAME_ONLY, type Exposer } from "./rpc";
import { parseParamValue, type ParamDef } from "./scriptDef";
import { scriptEnv } from "./scriptEnv";

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
    /** which onPage handlers this shim collects (default "main") */
    world?: PageWorld;
    /** answers the overlay's calls into this script's onPage handles */
    exposer?: Exposer;
    /** why the other world's handles don't answer here (default: not running) */
    otherWorld?: string;
    /** the isolated world in the top frame: `"overlay:N"` → a live handle */
    overlay?: (h: string) => any;
}

const NO_STORE = "wt.store isn't available in page code — pass the data to an onPage function from the overlay instead";
const fail = (): never => {
    throw new Error(NO_STORE);
};
const noStore = new Proxy(Object.create(null), { get: (_t, p) => (p === "then" || typeof p === "symbol" ? undefined : fail()), set: fail, has: fail, ownKeys: fail, deleteProperty: fail });
const NO_FETCH = "wt.fetch isn't available in page code — use the page's own fetch";

export function makePageShim(o: PageShimOptions): { wt: any; dom: PageDocumentHandler[] } {
    const dom: PageDocumentHandler[] = [];
    const world = o.world || "main";
    const inert = () => {};
    // registrations always count, so indexes match the background's
    let pageIndex = 0;
    const onPage = (api: "onPage" | "onDocument") => (route: unknown, fn: unknown) => {
        if (typeof fn !== "function") throw new Error(`wt.${api}: second argument must be the handler function`);
        const r = normalizeRoute("onDocument", route, pageIndex++, api === "onPage" ? "onPage" : undefined);
        const h = `page:${r.index}`;
        if (pageWorld(r) === world) {
            o.exposer?.register(h);
            dom.push({ h, route: r, when: r.when || "document_end", fn: fn as any });
        } else o.exposer?.elsewhere(h, o.otherWorld ?? NOT_RUNNING);
        return inertRemote("page functions are called from this script's overlay, not from page code");
    };
    let overlayIndex = 0;
    const onOverlay = (_route: unknown, fn: unknown) => {
        const h = `overlay:${typeof fn === "function" ? overlayIndex++ : -1}`;
        if (world === "main") return inertRemote(REMOTE_MAIN_WORLD);
        return o.overlay ? o.overlay(h) : inertRemote(TOP_FRAME_ONLY);
    };
    const parsed = (key: string, def: ParamDef | undefined) => (def && typeof def === "object" ? parseParamValue(key, def, o.params[key]) : o.params[key]);
    const wt = {
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: inert,
        onResponseBody: inert,
        onPage: onPage("onPage"),
        onDocument: onPage("onDocument"),
        onOverlay,
        // declaring a store at top level is fine (that code runs here too); using it isn't
        store: () => noStore,
        fetch: () => Promise.reject(new Error(NO_FETCH)),
        about: inert,
        params: (defs: Record<string, ParamDef>) => Object.freeze(Object.fromEntries(Object.entries(defs || {}).map(([k, d]) => [k, parsed(k, d)]))),
        defineParam: (name: string, def: ParamDef) => parsed(name, def),
        log: o.log,
        storage: o.storage,
        ...scriptEnv(),
    };
    return { wt, dom };
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
export function firePageHandler(d: PageDocumentHandler, ctx: any, exposer?: Exposer): void {
    let out: unknown;
    try {
        out = d.fn(ctx);
    } catch (e) {
        exposer?.fail(d.h);
        throw e;
    }
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
