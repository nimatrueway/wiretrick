/**
 * Handler routes: the first argument of every tt.onXxx registration.
 *
 *   tt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, fn)
 *   tt.onResponseBody({ url: [...], exclude, methods, resourceTypes, strategy, binary }, fn)
 *   tt.onSite / tt.onPage ("*://example.com/*" or { url, exclude, when }, fn): kind
 *   "onDocument" (world "page" / "isolated"); tt.onOverlay: kind "onOverlay"
 *
 * Each network route is owned by exactly one strategy: its own, required,
 * `strategy` — there is no default.
 */
import { matchAny, matchGroups, matchPatternError } from "./matcher";

export type Strategy = "page" | "extension" | "debugger" | "helper" | "rules";
export const STRATEGIES: Strategy[] = ["helper", "page", "extension", "debugger", "rules"];

export type NetKind = "onRequest" | "onResponseHeaders" | "replaceResponse" | "onResponseBody";
/** page handlers (tt.onSite, tt.onPage) and overlay handlers (tt.onOverlay) */
export type DocKind = "onDocument" | "onOverlay";
export type RouteKind = NetKind | DocKind;
export const NET_KINDS: NetKind[] = ["onRequest", "onResponseHeaders", "replaceResponse", "onResponseBody"];

/** a network handler's kind (one that a strategy runs), not a page/overlay one */
export const isNetKind = (kind: RouteKind): kind is NetKind => kind !== "onDocument" && kind !== "onOverlay";

/** where a page handler's JavaScript runs: a private world (tt.onPage), or the site's own JS world (tt.onSite) */
export type PageWorld = "isolated" | "page";

/** the three places: the site's JS world, the isolated world, the overlay frame */
export type PlaceApi = "onSite" | "onPage" | "onOverlay";
export const PLACE_APIS: PlaceApi[] = ["onSite", "onPage", "onOverlay"];
export const placeKind = (api: PlaceApi): DocKind => (api === "onOverlay" ? "onOverlay" : "onDocument");
export const placeWorld = (api: PlaceApi): PageWorld | undefined => (api === "onSite" ? "page" : api === "onPage" ? "isolated" : undefined);
/** the API a page/overlay route was registered with */
export const placeOf = (route: Pick<RouteMeta, "kind" | "world">): PlaceApi => (route.kind === "onOverlay" ? "onOverlay" : route.world === "isolated" ? "onPage" : "onSite");

/**
 * Names a script's onSite / onPage / onOverlay handlers (RouteMeta.key).
 * The compiler numbers each API's calls in the source (`tt.onPage(` →
 * `tt.onPage.k(2)(`, keyPlaceCalls), so a name doesn't depend on which
 * calls ran before it; a call it couldn't see (an alias) is numbered by
 * call order (`onPage:~0`). A call in a library's code (its exported
 * function, called by the script) is numbered in the library's source and
 * named after it (`onPage:0@utils/x`). A call that runs again (a helper
 * registering twice) gets `#1`, `#2`, ….
 */
export function placeKeyer(): (api: PlaceApi, n?: number, lib?: string) => { key: string; n: number } {
    const seen = new Map<string, number>();
    const counts: Partial<Record<PlaceApi, number>> = {};
    return (api, n, lib) => {
        const count = counts[api] ?? 0;
        counts[api] = count + 1;
        const base = (typeof n === "number" ? `${api}:${n}` : `${api}:~${count}`) + (lib === undefined ? "" : `@${lib}`);
        const again = seen.get(base) ?? 0;
        seen.set(base, again + 1);
        return { key: again ? `${base}#${again}` : base, n: typeof n === "number" ? n : count };
    };
}

/** `register(route, fn, n?)` as `tt.onX`: callable, plus the compiler's `.k(n)` form */
export function placeApi<R>(register: (route: unknown, fn: unknown, n?: number) => R): ((route: unknown, fn: unknown) => R) & { k(n: number): (route: unknown, fn: unknown) => R } {
    const api = (route: unknown, fn: unknown) => register(route, fn);
    api.k = (n: number) => (route: unknown, fn: unknown) => register(route, fn, n);
    return api;
}

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
    /** the source line of the tt.* call that registered it (Problems view) */
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
    /** onDocument: the JavaScript world — "isolated" (tt.onPage) or "page" (tt.onSite) */
    world?: PageWorld;
    /** the API name it was registered with, when it differs from `kind` (tt.onSite / tt.onPage → kind "onDocument") */
    api?: "onSite" | "onPage";
    /** tt.onSite / tt.onPage: which of the script's calls to that API it is (0-based), when it differs from `index` */
    n?: number;
    /** a call in this library's code (a function it exports, called by the script): `n` counts that library's calls */
    lib?: string;
    /**
     * onSite / onPage / onOverlay: the handler's stable name, `"onPage:2"`
     * (its API and which of the source's calls to it it is): its handle's
     * id, and what its run's owned things are keyed by
     */
    key?: string;
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
export function normalizeRoute(kind: RouteKind, raw: unknown, index: number, api?: PlaceApi): RouteMeta {
    const name = api || kind;
    const where = `tt.${name}`;
    const doc = !isNetKind(kind);
    const example = doc ? `tt.${name}("*://example.com/*", handler)` : `tt.${kind}({ url: "*://example.com/*", strategy: "helper" }, handler)`;
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
    if (api === "onSite" || api === "onPage") route.api = api;
    if (doc) {
        const runs = kind === "onOverlay" ? "in the overlay" : api === "onSite" ? "in the site's world" : "in the page";
        for (const k of ["methods", "resourceTypes", "strategy", "binary"]) {
            if (obj[k] !== undefined) throw new Error(`${where}: "${k}" doesn't apply to ${name} (it runs ${runs}, not on requests)`);
        }
        if (obj.when !== undefined) {
            if (!DOCUMENT_WHENS.includes(obj.when)) throw new Error(`${where}: when must be one of ${DOCUMENT_WHENS.join(", ")}`);
            route.when = obj.when;
        } else route.when = api === "onSite" ? "document_start" : "document_end"; // onSite: ahead of the site's own code
        if (kind === "onDocument") route.world = api === "onSite" ? "page" : "isolated";
        return route;
    }
    if (obj.when !== undefined) throw new Error(`${where}: "when" applies to onSite, onPage and onOverlay only`);
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

/**
 * label for logs: `onResponseBody #2` (an onSite / onPage route is labeled
 * with its API, numbered by its calls to that API; one a library's code
 * registered is numbered in that library: `onPage #1 (utils/x)`)
 */
export function routeLabel(route: RouteMeta): string {
    return `${route.api || route.kind} #${(route.n ?? route.index) + 1}${route.lib === undefined ? "" : ` (${route.lib})`}`;
}

/** the world an onDocument route runs in */
export const pageWorld = (route: Pick<RouteMeta, "world">): PageWorld => route.world || "page";

/** can this route ever fire on the hook (page fetch/XHR only)? */
export function hookCanSee(route: RouteMeta): boolean {
    return !route.resourceTypes || route.resourceTypes.includes("xmlhttprequest");
}
