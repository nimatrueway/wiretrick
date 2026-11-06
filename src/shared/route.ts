/**
 * Handler routes: the first argument of every wt.onXxx registration.
 *
 *   wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, fn)
 *   wt.onResponseBody({ url: [...], exclude, methods, resourceTypes, strategy, binary }, fn)
 *   wt.onPage("*://example.com/*", fn) or wt.onPage({ url, exclude, when, js, dom, unsafe }, fn):
 *   kind "onDocument", or with dom: "overlay" kind "onOverlay" (api "onPage")
 *
 * Each network route is owned by exactly one strategy: its own, required,
 * `strategy` — there is no default.
 */
import { matchAny, matchGroups, matchPatternError } from "./matcher";

export type Strategy = "page" | "extension" | "debugger" | "helper" | "rules";
export const STRATEGIES: Strategy[] = ["helper", "page", "extension", "debugger", "rules"];

export type NetKind = "onRequest" | "onResponseHeaders" | "replaceResponse" | "onResponseBody";
/** page handlers (wt.onPage) and overlay handlers (wt.onPage({ dom: "overlay" })) */
export type DocKind = "onDocument" | "onOverlay";
export type RouteKind = NetKind | DocKind;
export const NET_KINDS: NetKind[] = ["onRequest", "onResponseHeaders", "replaceResponse", "onResponseBody"];

/** a network handler's kind (one that a strategy runs), not a page/overlay one */
export const isNetKind = (kind: RouteKind): kind is NetKind => kind !== "onDocument" && kind !== "onOverlay";

/** where an onPage handler's JavaScript runs: a private world, or the site's own JS world */
export type PageWorld = "isolated" | "page";
const JS_WORLDS = ["isolated", "page"];
const DOMS = ["page", "overlay"];

/** which kind a wt.onPage call registers: `dom: "overlay"` makes it an overlay handler */
export const pageCallKind = (raw: unknown): DocKind => (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as any).dom === "overlay" ? "onOverlay" : "onDocument");

export const UNSAFE_LAYER =
    'js: "page" with dom: "overlay" runs the overlay as the site\'s own code: the site can see, read and change what it draws and call into it — add unsafe: true to allow it at your own risk';

export type DocumentWhen = "document_start" | "document_end" | "document_idle";
const DOCUMENT_WHENS: DocumentWhen[] = ["document_start", "document_end", "document_idle"];

/** webRequest resource type names (also ctx.resourceType) */
export const RESOURCE_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
] as const;

export interface RouteMeta {
    kind: RouteKind;
    /** registration order within kind (0-based) */
    index: number;
    /** the source line of the wt.* call that registered it (Problems view) */
    line?: number;
    /** URLPatterns; [] matches nothing */
    url: string[];
    exclude: string[];
    /** uppercase HTTP methods; undefined = any */
    methods?: string[];
    /** webRequest resource types; undefined = any */
    resourceTypes?: string[];
    /** the strategy that runs the handler; required on network routes, absent on onDocument */
    strategy?: Strategy;
    /** onDocument / onOverlay only */
    when?: DocumentWhen;
    /**
     * The JavaScript world (`js`). onDocument: "isolated" (the default),
     * absent = the page's own world. onOverlay: "page" (`js: "page"`, the
     * page-world layer), absent = the overlay frame.
     */
    world?: "isolated" | "page";
    /**
     * `unsafe: true` (page-world routes only): the script's page-world code
     * gets its stores and overlay, which the page can then reach too
     */
    unsafe?: true;
    /** the API name it was registered with, when it differs from `kind` (wt.onPage → kind "onDocument" or "onOverlay") */
    api?: "onPage";
    /** wt.onPage: which of the script's calls to it it is (0-based, either kind), when it differs from `index` */
    n?: number;
    /** onResponseBody only: which bodies the handler gets (see takesBinary / takesText) */
    binary?: BinaryOption;
}

/** onResponseBody `binary`: unset/false = text only (false also silences the "body is binary" warning), true = binary only, "both" */
export type BinaryOption = boolean | "both";

export const takesBinary = (r: { binary?: BinaryOption }): boolean => r.binary === true || r.binary === "both";
export const takesText = (r: { binary?: BinaryOption }): boolean => r.binary !== true;

/** the strategy that owns a network route (onDocument/onOverlay routes have none) */
export function effectiveStrategy(route: Pick<RouteMeta, "strategy">): Strategy {
    return route.strategy!;
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
export function normalizeRoute(kind: RouteKind, raw: unknown, index: number, api?: "onPage"): RouteMeta {
    const name = api || kind;
    const where = `wt.${name}`;
    const doc = !isNetKind(kind);
    const example = doc ? `wt.${name}("*://example.com/*", handler)` : `wt.${kind}({ url: "*://example.com/*", strategy: "helper" }, handler)`;
    const shape = doc ? "a URL pattern (string, string[] or { url })" : "a route { url, strategy }";
    if (typeof raw === "function" || raw === undefined || raw === null) throw new Error(`${where}: first argument must be ${shape} — e.g. ${example}`);
    let obj: any;
    if (typeof raw === "string" || Array.isArray(raw)) {
        if (!doc) throw new Error(`${where}: a bare URL pattern has no strategy — pass { url, strategy } instead, e.g. ${example}. Strategies: ${STRATEGIES.join(", ")}`);
        obj = { url: raw };
    } else if (typeof raw === "object") obj = raw;
    else throw new Error(`${where}: first argument must be ${shape}, got ${typeof raw}`);
    if (obj.url === undefined && obj.match !== undefined) throw new Error(`${where}: the route field is "url", not "match"`);
    if (obj.url === undefined) throw new Error(`${where}: route is missing "url"`);
    const url = list(obj.url, "url", where);
    const exclude = list(obj.exclude, "exclude", where);
    checkPatterns(url, "url", where);
    checkPatterns(exclude, "exclude", where);
    const route: RouteMeta = { kind, index, url, exclude };
    if (api) route.api = api;
    if (doc) {
        const runs = kind === "onOverlay" ? "in the overlay" : "in the page";
        for (const k of ["methods", "resourceTypes", "strategy", "binary"]) {
            if (obj[k] !== undefined) throw new Error(`${where}: "${k}" doesn't apply to ${name} (it runs ${runs}, not on requests)`);
        }
        if (obj.when !== undefined) {
            if (!DOCUMENT_WHENS.includes(obj.when)) throw new Error(`${where}: when must be one of ${DOCUMENT_WHENS.join(", ")}`);
            route.when = obj.when;
        } else route.when = "document_end";
        if (obj.js !== undefined && !JS_WORLDS.includes(obj.js)) throw new Error(`${where}: js must be "isolated" or "page", got ${JSON.stringify(obj.js)}`);
        if (obj.dom !== undefined && !DOMS.includes(obj.dom)) throw new Error(`${where}: dom must be "page" or "overlay", got ${JSON.stringify(obj.dom)}`);
        if (obj.unsafe !== undefined && typeof obj.unsafe !== "boolean") throw new Error(`${where}: unsafe must be true or false, got ${JSON.stringify(obj.unsafe)}`);
        const js: PageWorld = obj.js === "page" ? "page" : "isolated";
        if (obj.unsafe === true && js !== "page") throw new Error(`${where}: "unsafe" applies only to js: "page" (it opens the script's stores and overlay to page-world code)`);
        if (kind === "onOverlay") {
            if (js === "page") {
                if (obj.unsafe !== true) throw new Error(`${where}: ${UNSAFE_LAYER}`);
                route.world = "page";
            }
        } else if (js === "isolated") route.world = "isolated";
        if (obj.unsafe === true) route.unsafe = true;
        return route;
    }
    if (obj.when !== undefined) throw new Error(`${where}: "when" applies to onPage only`);
    for (const k of ["js", "dom", "unsafe"]) if (obj[k] !== undefined) throw new Error(`${where}: "${k}" applies to onPage only`);
    if (obj.binary !== undefined) {
        if (kind !== "onResponseBody") throw new Error(`${where}: "binary" applies to onResponseBody only`);
        if (typeof obj.binary !== "boolean" && obj.binary !== "both") throw new Error(`${where}: binary must be true, false or "both", got ${JSON.stringify(obj.binary)}`);
        route.binary = obj.binary;
    }
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
    if (obj.strategy === undefined) throw new Error(`${where}: route is missing "strategy" — every handler names the strategy that runs it, e.g. ${example}. Strategies: ${STRATEGIES.join(", ")}`);
    if (Array.isArray(obj.strategy)) throw new Error(`${where}: strategy is a single value (one of ${STRATEGIES.join(", ")}), not a priority list`);
    if (!STRATEGIES.includes(obj.strategy)) throw new Error(`${where}: unknown strategy "${obj.strategy}" — one of ${STRATEGIES.join(", ")}`);
    route.strategy = obj.strategy;
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

/**
 * A URL the routes name (the Editor preview's default page URL): the first
 * pattern made concrete — `*://` → `https://`, a `*.` host prefix and other
 * `*`s dropped, a `*` host → example.com — that its route matches; else
 * the first that parses; else https://example.com/.
 */
export function sampleUrl(routes: RouteMeta[]): string {
    const concrete = (p: string) =>
        p
            .replace(/^\*:\/\//, "https://")
            .replace(/:\/\/\*\./, "://")
            .replace(/:\/\/\*(?=[/:]|$)/, "://example.com")
            .replace(/\*/g, "");
    let parsed = "";
    for (const r of routes)
        for (const p of r.url) {
            const u = concrete(p);
            try {
                new URL(u);
            } catch {
                continue;
            }
            if (routeMatches(r, u)) return u;
            parsed ||= u;
        }
    return parsed || "https://example.com/";
}

/** label for logs: `onResponseBody #2` (an onPage route is labeled onPage, not its kind, and numbered by its wt.onPage call) */
export function routeLabel(route: RouteMeta): string {
    return `${route.api || route.kind} #${(route.n ?? route.index) + 1}`;
}

/** the world an onPage (kind onDocument) route runs in */
export const pageWorld = (route: Pick<RouteMeta, "world">): PageWorld => route.world || "page";

/** an onOverlay route that runs in the page's own world (`js: "page"`, `dom: "overlay"`): the hook's layer, not the overlay frame */
export const isPageLayer = (route: Pick<RouteMeta, "kind" | "world">): boolean => route.kind === "onOverlay" && route.world === "page";

/** can this route ever fire on the hook (page fetch/XHR only)? */
export function hookCanSee(route: RouteMeta): boolean {
    return !route.resourceTypes || route.resourceTypes.includes("xmlhttprequest");
}
