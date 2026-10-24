/**
 * Handler execution for the "body ops" — shared by the MV3 sandbox (hook,
 * debugger and helper strategies) and the MV2 background page (helper strategy),
 * so chain semantics are identical everywhere:
 *
 *   requestDecision — onRequest handlers in order; the first terminal result
 *                     (replaceResponse / redirect / block) wins, header edits
 *                     stack (the later handler wins per header)
 *   replace         — replaceResponse handlers; first non-null result wins
 *   transform       — onResponseBody handlers compose in order
 *   responseHeaders — onResponseHeaders handlers; header edits stack
 *
 * Final results carry `who` — the handler that decided — so the caller can
 * report the handlers it kept from running (see precedence.ts).
 */
import { formatScriptError } from "./scriptError";
import { effectiveStrategy, routeGroups, routeMatches, type Strategy } from "./route";
import type { Routed, ScriptHandlers } from "./compile";
import { observedLine, type NetKind } from "./netTypes";
import { HeaderStack, overrideLine, type Who } from "./precedence";
import { makeMissedThrottle } from "./missedTap";

export type BodyOp = "requestDecision" | "transform" | "replace" | "responseHeaders";

export interface OpScript {
    id: string;
    name: string;
    handlers: ScriptHandlers;
}

/**
 * Which handlers an op runs: routes matching (url, method, type) and —
 * when `tier` is given — owned by that strategy (route.strategy, else
 * `defaultStrategy`). Each route has exactly one owner, so no handler runs
 * on two strategies.
 */
export interface OpFilter {
    url: string;
    method?: string;
    resourceType?: string;
    tier?: Strategy;
    defaultStrategy?: Strategy;
    /** restrict to these script ids */
    onlyIds?: string[];
}

export function handlerRuns(h: Routed, f: OpFilter): boolean {
    if (f.tier && effectiveStrategy(h.route, f.defaultStrategy) !== f.tier) return false;
    return routeMatches(h.route, f.url, f.method, f.resourceType);
}

export interface OpEnv {
    /** kind "observed": the handler ran but changed nothing (DEBUG line) */
    log(scriptId: string, level: "debug" | "info" | "warn" | "error", msg: string, kind?: NetKind): void;
    debug?(msg: string): void;
}

/** a replacement's mime when the URL has no telling extension */
const TYPE_MIME: Record<string, string> = { main_frame: "text/html", sub_frame: "text/html", stylesheet: "text/css", script: "application/javascript" };

export function guessMimeFromUrl(url: string, fallback = "application/json"): string {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
    const m: Record<string, string> = { js: "application/javascript", json: "application/json", css: "text/css", html: "text/html", xml: "application/xml" };
    return m[ext] || fallback;
}

/**
 * replaceResponse `{ file }` → body + mime. `data:` URLs are decoded (their
 * media type wins over the request URL's extension); other refs are served
 * as-is, as before.
 */
export function resolveFileRef(ref: string, url: string): { mime: string; content: string } {
    const m = /^data:([^,]*?),(.*)$/s.exec(ref);
    if (!m) return { mime: guessMimeFromUrl(url), content: ref };
    const params = m[1].split(";");
    const base64 = params.includes("base64");
    const mime = params[0] || "text/plain";
    let content: string;
    try {
        content = base64 ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    } catch {
        content = m[2];
    }
    return { mime, content };
}

export function serializeRespondBody(body: any): string {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    return JSON.stringify(body);
}

const HANDLER_OF: Record<BodyOp, keyof ScriptHandlers> = {
    requestDecision: "onRequest",
    transform: "onResponseBody",
    replace: "replaceResponse",
    responseHeaders: "onResponseHeaders",
};

/** matching handlers for `op`, grouped per script, in list then registration order */
function matching(scripts: OpScript[], op: BodyOp, f: OpFilter, env: OpEnv): { s: OpScript; handlers: Routed[] }[] {
    const kind = HANDLER_OF[op];
    const out: { s: OpScript; handlers: Routed[] }[] = [];
    for (const s of scripts) {
        if (f.onlyIds && !f.onlyIds.includes(s.id)) continue;
        const handlers = ((s.handlers as any)[kind] as Routed[] || []).filter((h) => handlerRuns(h, f));
        if (handlers.length) out.push({ s, handlers });
    }
    env.debug?.(`run ${op} ${f.url}${f.tier ? ` [${f.tier}]` : ""} → ${out.length} matching script(s) [${out.map((m) => m.s.name).join(", ")}]`);
    return out;
}

const overrideThrottle = makeMissedThrottle();

/** stack one handler's header edits; warn (throttled) when it overrides an earlier handler's */
function stackHeaders(stack: HeaderStack, edits: any, by: Who, which: "request" | "response", url: string, env: OpEnv): void {
    for (const o of stack.add(edits, by)) {
        const key = `${which}|${o.header}|${o.by.scriptId}|${o.by.kind}|${o.by.index}|${o.over.scriptId}|${o.over.kind}|${o.over.index}`;
        if (overrideThrottle(key)) env.log(o.by.scriptId, "warn", overrideLine(o, which, url));
    }
}

function hasHeaderMods(h: any): boolean {
    return !!h && ((h.set && Object.keys(h.set).length > 0) || (h.remove && h.remove.length > 0));
}

export async function runOp(scripts: OpScript[], op: BodyOp, args: any, env: OpEnv): Promise<any> {
    const url: string = args.url;
    const method: string = args.method;
    // "" = unknown (helper strategy, uncorrelated request): ctx says "other", route `resourceTypes` aren't checked
    const known: string | undefined = args.resourceType === undefined ? "xmlhttprequest" : args.resourceType || undefined;
    const resourceType: string = known ?? "other";
    const base = (h: Routed) => ({
        url,
        method,
        tabUrl: args.tabUrl || url,
        resourceType,
        requestHeaders: args.requestHeaders || {},
        groups: routeGroups(h.route, url),
    });
    const list = matching(scripts, op, { url, method, resourceType: known, tier: args.tier, defaultStrategy: args.defaultStrategy, onlyIds: args.onlyIds }, env);
    const observed = (s: OpScript, handler: string, why?: string) => env.log(s.id, "debug", observedLine(s.name, handler, url, why), "observed");

    if (op === "requestDecision") {
        const stack = new HeaderStack();
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                const who: Who = { scriptId: s.id, scriptName: s.name, kind: "onRequest", index: h.route.index };
                try {
                    const result = await h.fn(base(h));
                    if (!result) {
                        observed(s, "onRequest");
                        continue;
                    }
                    if (result.replaceResponse) {
                        const r = result.replaceResponse;
                        const mime = r.mime || guessMimeFromUrl(url);
                        const content = serializeRespondBody(r.body);
                        env.log(s.id, "info", `[${s.name}] onRequest → replaceResponse ${r.status || 200} ${mime} (${content.length}b) ${url}`);
                        return { kind: "respond", mime, content, status: r.status, headers: r.headers?.set, scriptId: s.id, scriptName: s.name, who };
                    }
                    if (result.redirect) {
                        env.log(s.id, "info", `[${s.name}] onRequest → redirect → ${result.redirect} ${url}`);
                        return { kind: "redirect", url: result.redirect, who };
                    }
                    if (result.block) {
                        env.log(s.id, "info", `[${s.name}] onRequest → block ${url}`);
                        return { kind: "cancel", who };
                    }
                    if (hasHeaderMods(result.headers)) {
                        const parts: string[] = [];
                        if (result.headers.set && Object.keys(result.headers.set).length) parts.push(`set ${Object.keys(result.headers.set).join(", ")}`);
                        if (result.headers.remove && result.headers.remove.length) parts.push(`remove ${result.headers.remove.join(", ")}`);
                        env.log(s.id, "info", `[${s.name}] onRequest → request headers (${parts.join("; ")}) ${url}`);
                        stackHeaders(stack, result.headers, who, "request", url, env);
                    } else observed(s, "onRequest");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onRequest"));
                }
            }
        }
        return stack.empty ? null : { kind: "headers", changes: stack.result() };
    }

    if (op === "responseHeaders") {
        const stack = new HeaderStack();
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                const who: Who = { scriptId: s.id, scriptName: s.name, kind: "onResponseHeaders", index: h.route.index };
                try {
                    const result = await h.fn({ ...base(h), status: args.status, statusLine: args.statusLine || "", responseHeaders: args.responseHeaders || [] });
                    if (hasHeaderMods(result?.headers)) {
                        env.log(s.id, "info", `[${s.name}] onResponseHeaders → ${Object.keys(result.headers.set || {}).length} set, ${(result.headers.remove || []).length} removed ${url}`);
                        stackHeaders(stack, result.headers, who, "response", url, env);
                    } else observed(s, "onResponseHeaders");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onResponseHeaders"));
                }
            }
        }
        return stack.empty ? null : stack.result();
    }

    if (op === "transform") {
        let out: string | Uint8Array = args.body || "";
        let touched = false;
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                try {
                    const result: any = await h.fn({ ...base(h), contentType: args.contentType, status: args.status }, out);
                    if (result !== undefined && result !== null) {
                        const before = typeof out === "string" ? out.length : out.byteLength;
                        const prevOut = out;
                        const next = typeof result === "string" ? result : result instanceof Uint8Array ? result : JSON.stringify(result);
                        const after = typeof next === "string" ? next.length : next.byteLength;
                        out = next;
                        if (next !== prevOut) env.log(s.id, "info", `[${s.name}] onResponseBody applied (${before}b → ${after}b) ${url}`);
                        else observed(s, "onResponseBody", "it returned the same body it received");
                        touched = true;
                    } else observed(s, "onResponseBody");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onResponseBody"));
                }
            }
        }
        // raw: binary in, binary out (cdp on MV2)
        return touched ? (typeof out === "string" || args.raw ? out : new TextDecoder().decode(out)) : null;
    }

    if (op === "replace") {
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                try {
                    const out = await h.fn(base(h));
                    if (out !== undefined && out !== null) {
                        const isFile = out && typeof out === "object" && typeof out.file === "string";
                        const { mime, content: body } = isFile ? resolveFileRef(out.file, url) : { mime: guessMimeFromUrl(url, TYPE_MIME[resourceType]), content: typeof out === "string" ? out : typeof out === "object" ? JSON.stringify(out) : String(out) };
                        env.log(s.id, "info", `[${s.name}] replaceResponse → ${mime} (${body.length}b) ${url}`);
                        return { mime, content: body, who: { scriptId: s.id, scriptName: s.name, kind: "replaceResponse", index: h.route.index } satisfies Who };
                    }
                    observed(s, "replaceResponse");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "replaceResponse"));
                }
            }
        }
        return null;
    }

    return null;
}
