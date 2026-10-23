/**
 * The `rules` strategy's probe: run each rules handler ONCE, at load time,
 * with a "tripwire" ctx, and turn what it returns into rule specs.
 *
 *   ctx.groups.<name>  → a placeholder for that capture (as-is in a redirect
 *                        URL it becomes a regexSubstitution `\N`)
 *   ctx.url            → a placeholder for the whole URL (`\0`)
 *   anything else      → recorded: the result depends on the request, so it
 *                        can't be a fixed rule
 *
 * Runs where handlers live (MV3 sandbox, MV2 background); the output is
 * plain data so it can cross the sandbox boundary.
 */
import { captureToken, patternGroups, rulesForProbe, ruleErrorLine, URL_TOKEN, type ProbeResult, type RuleProbe, type RuleSpec } from "./dnrRules";
import { effectiveStrategy, NET_KINDS, type RouteMeta, type Strategy } from "./route";
import type { HandlerFn, ScriptHandlers } from "./compile";

const PROBE_TIMEOUT_MS = 2000;

/** ctx fields a rules handler may not read, with harmless stand-ins */
const REQUEST_FIELDS: Record<string, unknown> = { method: "GET", tabUrl: "", resourceType: "other", requestHeaders: {} };
const RESPONSE_FIELDS: Record<string, unknown> = { ...REQUEST_FIELDS, statusLine: "", responseHeaders: [] };

interface Trip {
    forbidden: Set<string>;
    captures: Set<string>;
    urlRead: boolean;
}

function tripwireCtx(route: RouteMeta, names: string[], missing: Set<string>, trip: Trip): any {
    const groupValues: Record<string, string | undefined> = {};
    for (const n of names) groupValues[n] = missing.has(n) ? undefined : captureToken(n);
    const groups = new Proxy(groupValues, {
        get(t, k) {
            if (typeof k === "string" && names.includes(k)) trip.captures.add(k);
            return (t as any)[k];
        },
        has(t, k) {
            if (typeof k === "string" && names.includes(k)) trip.captures.add(k);
            return k in t;
        },
        ownKeys(t) {
            for (const n of names) trip.captures.add(n);
            return Reflect.ownKeys(t);
        },
    });
    const fields = route.kind === "onResponseHeaders" ? RESPONSE_FIELDS : REQUEST_FIELDS;
    const base: Record<string, unknown> = { url: URL_TOKEN, groups, ...fields };
    return new Proxy(base, {
        get(t, k) {
            if (k === "url") trip.urlRead = true;
            else if (typeof k === "string" && k in fields) trip.forbidden.add(k);
            return (t as any)[k];
        },
        ownKeys(t) {
            // spreading / Object.keys(ctx) reads everything
            for (const k of Object.keys(fields)) trip.forbidden.add(k);
            trip.urlRead = true;
            return Reflect.ownKeys(t);
        },
    });
}

/** the handler result as plain data (only what rules can express) */
function serializeResult(r: any): ProbeResult | null {
    if (!r) return null;
    if (typeof r !== "object") return {};
    const out: ProbeResult = {};
    if (r.respond) out.respond = true;
    if (r.redirect) out.redirect = String(r.redirect);
    if (r.block) out.block = true;
    const h = r.headers;
    if (h && typeof h === "object") {
        out.headers = {};
        if (h.set && typeof h.set === "object") out.headers.set = Object.fromEntries(Object.entries(h.set).map(([k, v]) => [k, String(v)]));
        if (h.remove) out.headers.remove = (Array.isArray(h.remove) ? h.remove : [h.remove]).map(String);
    }
    return out;
}

async function runOnce(fn: HandlerFn, ctx: any): Promise<{ result?: ProbeResult | null; error?: string }> {
    let timer: any;
    try {
        const r = await Promise.race([
            Promise.resolve().then(() => fn(ctx)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS / 1000} s (rules run the handler once, at load)`)), PROBE_TIMEOUT_MS);
            }),
        ]);
        return { result: serializeResult(r) };
    } catch (e: any) {
        return { error: e?.message ? String(e.message) : String(e) };
    } finally {
        clearTimeout(timer);
    }
}

function tokensToEmpty(r: ProbeResult | null | undefined, names: string[]): string {
    let s = JSON.stringify(r ?? null);
    for (const n of names) s = s.split(JSON.stringify(captureToken(n)).slice(1, -1)).join("");
    return s;
}

/** run one rules handler with the tripwire ctx */
export async function probeHandler(fn: HandlerFn, route: RouteMeta): Promise<RuleProbe> {
    const kind = route.kind as RuleProbe["kind"];
    const base: RuleProbe = { kind, route, captures: [], urlRead: false };
    if (kind === "onResponseBody" || kind === "replaceResponse") return base;
    const groups = new Map<string, boolean>();
    try {
        for (const p of route.url) for (const g of patternGroups(p)) groups.set(g.name, (groups.get(g.name) ?? false) || g.optional);
    } catch {
        // an unparsable pattern: rulesForProbe reports it
    }
    const names = [...groups.keys()];
    const trip: Trip = { forbidden: new Set(), captures: new Set(), urlRead: false };
    const first = await runOnce(fn, tripwireCtx(route, names, new Set(), trip));
    const probe: RuleProbe = { ...base, forbidden: [...trip.forbidden], captures: [...trip.captures], urlRead: trip.urlRead, result: first.result };
    if (first.error) {
        probe.error = trip.forbidden.size ? undefined : `threw during its one-time run: ${first.error}`;
        return probe;
    }
    // a missing optional capture is substituted as "" by a rule: the
    // handler must do the same (e.g. `ctx.groups.ver ?? ""`)
    const optional = probe.captures.filter((n) => groups.get(n));
    if (optional.length && !probe.forbidden?.length) {
        const second = await runOnce(fn, tripwireCtx(route, names, new Set(optional), { forbidden: new Set(), captures: new Set(), urlRead: false }));
        const want = tokensToEmpty(first.result, optional);
        const got = second.error ? null : tokensToEmpty(second.result, []);
        if (got !== want) probe.optionalMismatch = optional;
    }
    return probe;
}

/** a probed script's rules: specs per handler, and per-handler errors */
export interface ScriptRules {
    rules: { route: RouteMeta; specs: RuleSpec[] }[];
    /** "onRequest #2: reason" */
    errors: string[];
}

/** probe + translate every handler of a script that runs on `rules` */
export async function probeScriptRules(handlers: ScriptHandlers, defaultStrategy: Strategy): Promise<ScriptRules> {
    const out: ScriptRules = { rules: [], errors: [] };
    for (const kind of NET_KINDS) {
        for (const h of handlers[kind]) {
            if (effectiveStrategy(h.route, defaultStrategy) !== "rules") continue;
            const r = rulesForProbe(await probeHandler(h.fn, h.route));
            if ("error" in r) out.errors.push(ruleErrorLine(h.route, r.error));
            else out.rules.push({ route: h.route, specs: r.rules });
        }
    }
    return out;
}
