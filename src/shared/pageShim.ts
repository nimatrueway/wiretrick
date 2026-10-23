/**
 * The `wt` object a script sees when its onDom handlers compile in the
 * page (hook.ts, MAIN world) or the isolated-world fallback (bridge.ts).
 * Network registrations are inert here (they run in the background);
 * onDom registrations are collected with their routes, and params resolve
 * to the raw values the background shipped in the bundle (each def's
 * `parse` runs here, in the page).
 */
import { normalizeRoute, routeMatches, type DomWhen, type RouteMeta } from "./route";
import { parseParamValue, type ParamDef } from "./scriptDef";
import { scriptEnv } from "./scriptEnv";

export interface PageDomHandler {
    route: RouteMeta;
    when: DomWhen;
    fn: (ctx: any) => any;
}

export interface PageShimOptions {
    /** resolved RAW param values (from the bundle) */
    params: Record<string, any>;
    log: (...args: any[]) => void;
    storage: { get(key: string): any; set(key: string, value: any): any };
}

export function makePageShim(o: PageShimOptions): { wt: any; dom: PageDomHandler[] } {
    const dom: PageDomHandler[] = [];
    const inert = () => {};
    const parsed = (key: string, def: ParamDef | undefined) => (def && typeof def === "object" ? parseParamValue(key, def, o.params[key]) : o.params[key]);
    const wt = {
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: inert,
        onResponseBody: inert,
        onDom: (route: unknown, fn: unknown) => {
            if (typeof fn !== "function") throw new Error("wt.onDom: second argument must be the handler function");
            const r = normalizeRoute("onDom", route, dom.length);
            dom.push({ route: r, when: r.when || "DOMContentLoaded", fn: fn as any });
        },
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
export function domHandlersFor(dom: PageDomHandler[], url: string): PageDomHandler[] {
    return dom.filter((h) => routeMatches(h.route, url));
}

/** run `run` at the handler's `when` (immediately when `now`) */
export function scheduleDom(when: DomWhen, run: () => void, now = false): void {
    if (now || when === "document_start") run();
    else if (when === "document_idle") {
        if (document.readyState === "complete") run();
        else window.addEventListener("load", run, { once: true });
    } else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    else run();
}
