/**
 * Handler routes: the first argument of every wt.onXxx registration.
 *
 *   wt.onRequest("*://api.example.com/*", fn)
 *   wt.onResponseBody({ url: [...], exclude, methods, resourceTypes, strategy }, fn)
 *   wt.onDom({ url, exclude, when }, fn)
 *
 * Each route is owned by exactly one strategy (tier): its own `strategy`,
 * else settings.defaultStrategy, else the per-browser default.
 */
import { matchAny, matchGroups, matchPatternError } from "./matcher";

export type Strategy = "page" | "webRequest" | "debugger" | "helper" | "rules";
export const STRATEGIES: Strategy[] = ["helper", "page", "webRequest", "debugger", "rules"];

export type NetKind = "onRequest" | "onResponseHeaders" | "replaceResponse" | "onResponseBody";
export type RouteKind = NetKind | "onDom";
export const NET_KINDS: NetKind[] = ["onRequest", "onResponseHeaders", "replaceResponse", "onResponseBody"];

export type DomWhen = "document_start" | "document_end" | "document_idle" | "DOMContentLoaded";
const DOM_WHENS: DomWhen[] = ["document_start", "document_end", "document_idle", "DOMContentLoaded"];

/** webRequest resource type names (also ctx.resourceType) */
export const RESOURCE_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
] as const;

export interface RouteMeta {
    kind: RouteKind;
    /** registration order within kind (0-based) */
    index: number;
    /** URLPatterns; [] matches nothing */
    url: string[];
    exclude: string[];
    /** uppercase HTTP methods; undefined = any */
    methods?: string[];
    /** webRequest resource types; undefined = any */
    resourceTypes?: string[];
    /** explicit per-handler strategy; undefined = settings default */
    strategy?: Strategy;
    /** onDom only */
    when?: DomWhen;
}

const IS_FIREFOX_RT = typeof (globalThis as any).browser !== "undefined" && typeof (globalThis as any).browser?.webRequest?.filterResponseData === "function";

/** built-in default when settings.defaultStrategy is unset */
export function builtinStrategy(firefox = IS_FIREFOX_RT): Strategy {
    return firefox ? "webRequest" : "helper";
}

let defaultStrategy: Strategy = builtinStrategy();

/** settings.defaultStrategy (background: set on every reload) */
export function setDefaultStrategy(s: Strategy | undefined | null): void {
    defaultStrategy = s && STRATEGIES.includes(s) ? s : builtinStrategy();
}

export function getDefaultStrategy(): Strategy {
    return defaultStrategy;
}

/** the tier that owns a route */
export function effectiveStrategy(route: Pick<RouteMeta, "strategy">, fallback: Strategy = defaultStrategy): Strategy {
    return route.strategy || fallback;
}

function list(v: unknown, what: string, where: string): string[] {
    if (v === undefined || v === null) return [];
    const arr = Array.isArray(v) ? v : [v];
    for (const x of arr) {
        if (typeof x !== "string") throw new Error(`${where}: ${what} entries must be strings, got ${typeof x}`);
    }
    return arr as string[];
}

function checkPatterns(ps: string[], what: string, where: string): void {
    for (const p of ps) {
        const err = matchPatternError(p);
        if (err) throw new Error(`${where}: ${what} ${err.replace(/^match /, "")}`);
    }
}

/**
 * Validate and normalize a registration's route argument. Throws a
 * script error on anything unusable (it surfaces like a syntax error).
 */
export function normalizeRoute(kind: RouteKind, raw: unknown, index: number): RouteMeta {
    const where = `wt.${kind}`;
    if (typeof raw === "function" || raw === undefined || raw === null) {
        throw new Error(`${where}: first argument must be a URL pattern (string, string[] or { url }) — e.g. wt.${kind}("*://example.com/*", handler)`);
    }
    let obj: any;
    if (typeof raw === "string" || Array.isArray(raw)) obj = { url: raw };
    else if (typeof raw === "object") obj = raw;
    else throw new Error(`${where}: first argument must be a URL pattern (string, string[] or { url }), got ${typeof raw}`);
    if (obj.url === undefined && obj.match !== undefined) throw new Error(`${where}: the route field is "url", not "match"`);
    if (obj.url === undefined) throw new Error(`${where}: route is missing "url"`);
    const url = list(obj.url, "url", where);
    const exclude = list(obj.exclude, "exclude", where);
    checkPatterns(url, "url", where);
    checkPatterns(exclude, "exclude", where);
    const route: RouteMeta = { kind, index, url, exclude };
    if (kind === "onDom") {
        for (const k of ["methods", "resourceTypes", "strategy"]) {
            if (obj[k] !== undefined) throw new Error(`${where}: "${k}" doesn't apply to onDom (it runs in the page, not on requests)`);
        }
        if (obj.when !== undefined) {
            if (!DOM_WHENS.includes(obj.when)) throw new Error(`${where}: when must be one of ${DOM_WHENS.join(", ")}`);
            route.when = obj.when;
        } else route.when = "DOMContentLoaded";
        return route;
    }
    if (obj.when !== undefined) throw new Error(`${where}: "when" applies to onDom only`);
    if (obj.methods !== undefined) {
        const m = list(obj.methods, "methods", where).map((x) => x.toUpperCase());
        route.methods = m;
    }
    if (obj.resourceTypes !== undefined) {
        const t = list(obj.resourceTypes, "resourceTypes", where);
        const bad = t.find((x) => !(RESOURCE_TYPES as readonly string[]).includes(x));
        if (bad) throw new Error(`${where}: unknown resource type "${bad}" — one of ${RESOURCE_TYPES.join(", ")}`);
        route.resourceTypes = t;
    }
    if (obj.strategy !== undefined) {
        if (Array.isArray(obj.strategy)) throw new Error(`${where}: strategy is a single value now (one of ${STRATEGIES.join(", ")}), not a priority list`);
        if (!STRATEGIES.includes(obj.strategy)) throw new Error(`${where}: unknown strategy "${obj.strategy}" — one of ${STRATEGIES.join(", ")}`);
        route.strategy = obj.strategy;
    }
    return route;
}

/** exact (stage 2) check: url ∧ ¬exclude ∧ method ∧ type */
export function routeMatches(route: RouteMeta, url: string, method?: string, type?: string): boolean {
    if (!matchAny(route.url, url)) return false;
    if (route.exclude.length && matchAny(route.exclude, url)) return false;
    if (route.methods && method && !route.methods.includes(method.toUpperCase())) return false;
    if (route.resourceTypes && type && !route.resourceTypes.includes(type)) return false;
    return true;
}

/** ctx.groups for a matched url */
export function routeGroups(route: RouteMeta, url: string): Record<string, string> {
    return matchGroups(route.url, url) || {};
}

/** union of a script's route urls (badge / "active on this tab") */
export function scriptUrls(routes: RouteMeta[] | undefined): string[] {
    const out = new Set<string>();
    for (const r of routes || []) for (const u of r.url) out.add(u);
    return [...out];
}

/** label for logs: `onResponseBody #2` */
export function routeLabel(route: RouteMeta): string {
    return `${route.kind} #${route.index + 1}`;
}

/** can this route ever fire on the hook (page fetch/XHR only)? */
export function hookCanSee(route: RouteMeta): boolean {
    return !route.resourceTypes || route.resourceTypes.includes("xmlhttprequest");
}
