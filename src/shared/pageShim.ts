/**
 * The `wt` object a script sees when its onDom handlers compile in the
 * page (hook.ts, MAIN world) or the isolated-world fallback (bridge.ts).
 * Network registrations are inert here (they run in the background);
 * onDom registrations are collected with their routes, and params resolve
 * to the values the background shipped in the bundle.
 */
import { normalizeRoute, routeMatches, type DomWhen, type RouteMeta } from "./route";

export interface PageDomHandler {
    route: RouteMeta;
    when: DomWhen;
    fn: (ctx: any) => any;
}

export interface PageShimOptions {
    /** resolved param values (from the bundle) */
    params: Record<string, any>;
    log: (...args: any[]) => void;
    storage: { get(key: string): any; set(key: string, value: any): any };
}

export function makePageShim(o: PageShimOptions): { wt: any; dom: PageDomHandler[] } {
    const dom: PageDomHandler[] = [];
    const inert = () => {};
    const wt = {
        onRequest: inert,
        onResponseHeaders: inert,
        replaceResponse: inert,
        modifyResponse: inert,
        onDom: (route: unknown, fn: unknown) => {
            if (typeof fn !== "function") throw new Error("wt.onDom: second argument must be the handler function");
            const r = normalizeRoute("onDom", route, dom.length);
            dom.push({ route: r, when: r.when || "DOMContentLoaded", fn: fn as any });
        },
        describe: inert,
        params: (defs: Record<string, unknown>) => Object.freeze(Object.fromEntries(Object.keys(defs || {}).map((k) => [k, o.params[k]]))),
        defineParam: (name: string) => o.params[name],
        log: o.log,
        storage: o.storage,
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
