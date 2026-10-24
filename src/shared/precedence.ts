/**
 * How handlers override each other or stack up — one model for every
 * strategy (docs/scripting.md "Multiple handlers — how they stack").
 *
 * A request passes the strategies as layers, page side first:
 *
 *   page → rules → extension → debugger → helper → server
 *
 * Within a layer, handlers run in stages, each in list order:
 *
 *   onRequest → replaceResponse → (network) → onResponseHeaders → onResponseBody
 *
 * A final result (onRequest block/redirect/replaceResponse, or a
 * replaceResponse body) ends the request in its layer: later handlers of
 * the layer and every handler of the layers behind it never see it.
 */
import { routeLabel, routeMatches, type NetKind, type RouteMeta, type Strategy } from "./route";

/** the layers a request passes, page side first */
export const LAYERS: Strategy[] = ["page", "rules", "extension", "debugger", "helper"];

/** stage of each handler kind within a layer */
const STAGE: Record<NetKind, number> = { onRequest: 0, replaceResponse: 1, onResponseHeaders: 2, onResponseBody: 3 };

/** the handler a result came from */
export interface Who {
    scriptId: string;
    scriptName: string;
    kind: NetKind;
    index: number;
}

export type FinalOutcome = "replace" | "block" | "redirect";

/** a final result and where it was decided */
export interface Winner extends Who {
    strategy: Strategy;
    outcome: FinalOutcome;
    /** redirect target */
    target?: string;
}

/** an enabled handler, in list order */
export interface RouteRef {
    scriptId: string;
    scriptName: string;
    /** the script's position in the list */
    order: number;
    route: RouteMeta;
    strategy: Strategy;
}

export interface SkipRequest {
    url: string;
    method?: string;
    /** webRequest type; "" or undefined = unknown */
    type?: string;
}

/**
 * The handlers a final result kept from running on this request:
 *
 * - same layer: later in list order within the winner's stage, and every
 *   later stage (nothing runs after a replacement, a block or a redirect);
 * - layers behind the winner: everything (the request never gets there);
 * - layers in front: only response handlers, and only for a block (a
 *   replacement or a redirect still comes back to them as a response).
 *
 * After a redirect, handlers that also match the target run on the new
 * request, so they aren't counted.
 */
export function skippedBy(routes: RouteRef[], req: SkipRequest, w: Winner): RouteRef[] {
    const wl = LAYERS.indexOf(w.strategy);
    const ws = STAGE[w.kind];
    const wOrder = routes.find((r) => r.scriptId === w.scriptId)?.order ?? -1;
    const type = req.type || undefined;
    return routes.filter((r) => {
        const kind = r.route.kind;
        if (kind === "onDocument") return false;
        if (r.scriptId === w.scriptId && kind === w.kind && r.route.index === w.index) return false;
        // page handlers only ever see the page's own fetch/XHR
        if (r.strategy === "page" && type !== "xmlhttprequest") return false;
        if (!routeMatches(r.route, req.url, req.method, type)) return false;
        if (w.outcome === "redirect" && w.target && routeMatches(r.route, w.target, req.method, type)) return false;
        const l = LAYERS.indexOf(r.strategy);
        const rs = STAGE[kind];
        if (l > wl) return true;
        if (l < wl) return w.outcome === "block" && rs >= STAGE.onResponseHeaders;
        if (rs !== ws) return rs > ws;
        return r.order > wOrder || (r.order === wOrder && r.route.index > w.index);
    });
}

/**
 * The Winner behind a runOp result: a requestDecision `respond`/`cancel`/
 * `redirect`, or a `replace` result. null for anything else.
 */
export function winnerOf(r: any, strategy: Strategy): Winner | null {
    const who: Who | undefined = r?.who;
    if (!who) return null;
    if (who.kind === "replaceResponse") return { ...who, strategy, outcome: "replace" };
    if (r.kind === "respond") return { ...who, strategy, outcome: "replace" };
    if (r.kind === "cancel") return { ...who, strategy, outcome: "block" };
    if (r.kind === "redirect") return { ...who, strategy, outcome: "redirect", target: r.url };
    return null;
}

const WHAT: Record<FinalOutcome, string> = { replace: "replaceResponse", block: "block", redirect: "redirect" };

export function winnerLabel(w: Winner): string {
    return w.kind === "onRequest" ? `onRequest #${w.index + 1} → ${WHAT[w.outcome]}` : `replaceResponse #${w.index + 1}`;
}

/** why `r` didn't run: the rule from the list above that applies */
export function skipReason(r: RouteRef, w: Winner): string {
    const wl = LAYERS.indexOf(w.strategy);
    const l = LAYERS.indexOf(r.strategy);
    if (l > wl) return `strategy "${w.strategy}" comes before "${r.strategy}", so the request never got there`;
    if (l < wl) return `a blocked request has no response`;
    if (r.route.kind === w.kind) return `it comes earlier in the list`;
    return w.outcome === "replace" ? `a replaced response is final` : `the request ended there`;
}

export const SKIPPED_MARK = " → skipped: ";

/** WARN line: `[B] onResponseBody #1 → skipped: [A] onRequest #1 → block took priority (why) <url>` */
export function skippedLine(r: RouteRef, w: Winner, url: string): string {
    return `[${r.scriptName}] ${routeLabel(r.route)}${SKIPPED_MARK}[${w.scriptName}] ${winnerLabel(w)} took priority (${skipReason(r, w)}) ${url}`;
}

// ---- header edits: the later handler in list order wins per header ----

export interface HeaderEdits {
    set?: Record<string, any>;
    remove?: string[];
}

export interface HeaderOverride {
    header: string;
    /** the later handler, whose edit applies */
    by: Who;
    /** the earlier handler, whose edit is replaced */
    over: Who;
}

/**
 * Stacks header edits in list order. Per header (case-insensitive) the
 * last edit wins, whether it sets or removes.
 */
export class HeaderStack {
    private edits = new Map<string, { name: string; value?: string; by?: Who }>();

    /** add one handler's edits; returns the earlier edits it replaces with a different one */
    add(h: HeaderEdits | null | undefined, by?: Who): HeaderOverride[] {
        const out: HeaderOverride[] = [];
        const put = (name: string, value: string | undefined) => {
            const key = name.toLowerCase();
            const prev = this.edits.get(key);
            if (prev?.by && by && prev.value !== value && !(prev.by.scriptId === by.scriptId && prev.by.kind === by.kind && prev.by.index === by.index)) {
                out.push({ header: key, by, over: prev.by });
            }
            this.edits.delete(key); // re-insert: keeps the applied order
            this.edits.set(key, { name, value, by });
        };
        for (const n of h?.remove || []) put(String(n), undefined);
        for (const [n, v] of Object.entries(h?.set || {})) put(n, String(v));
        return out;
    }

    get empty(): boolean {
        return this.edits.size === 0;
    }

    /** the merged edits: no header is both set and removed */
    result(): { set: Record<string, string>; remove: string[] } {
        const set: Record<string, string> = {};
        const remove: string[] = [];
        for (const e of this.edits.values()) {
            if (e.value === undefined) remove.push(e.name);
            else set[e.name] = e.value;
        }
        return { set, remove };
    }
}

/** merge `add` over `base`: the later edit wins per header */
export function mergeHeaderEdits(base: HeaderEdits | null | undefined, add: HeaderEdits): { set: Record<string, string>; remove: string[] } {
    const s = new HeaderStack();
    s.add(base);
    s.add(add);
    return s.result();
}

export function overrideLine(o: HeaderOverride, which: "request" | "response", url: string): string {
    return `[${o.by.scriptName}] ${o.by.kind} #${o.by.index + 1} overrides ${which} header "${o.header}" from [${o.over.scriptName}] ${o.over.kind} #${o.over.index + 1} (the later one in the list wins) ${url}`;
}
