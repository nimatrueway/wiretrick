/**
 * The `wt` object a script sees when its onPage (alias onDocument) handlers
 * compile in the page (hook.ts, MAIN world) or the isolated world (bridge.ts:
 * `world: "isolated"` handlers, and the main-world CSP fallback).
 * Network and onOverlay registrations are inert here (they run in the
 * background / the overlay); onPage registrations for this shim's `world`
 * are collected with their routes (the other world's are skipped), and params resolve
 * to the raw values the background shipped in the bundle (each def's
 * `parse` runs here, in the page).
 */
import { normalizeRoute, pageWorld, routeMatches, type DocumentWhen, type PageWorld, type RouteMeta } from "./route";
import { inertRemote, REMOTE_MAIN_WORLD } from "./remote";
import { parseParamValue, type ParamDef } from "./scriptDef";
import { scriptEnv } from "./scriptEnv";

export interface PageDocumentHandler {
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
        if (pageWorld(r) === world) dom.push({ route: r, when: r.when || "document_end", fn: fn as any });
        return inertRemote("page functions are called from this script's overlay, not from page code");
    };
    const overlayHandle = inertRemote(world === "main" ? REMOTE_MAIN_WORLD : "the overlay isn't running on this page");
    const parsed = (key: string, def: ParamDef | undefined) => (def && typeof def === "object" ? parseParamValue(key, def, o.params[key]) : o.params[key]);
    const wt = {
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: inert,
        onResponseBody: inert,
        onPage: onPage("onPage"),
        onDocument: onPage("onDocument"),
        onOverlay: () => overlayHandle,
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

/** the handlers whose route matches this frame's URL */
export function domHandlersFor(dom: PageDocumentHandler[], url: string): PageDocumentHandler[] {
    return dom.filter((h) => routeMatches(h.route, url));
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
