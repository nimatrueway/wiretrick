/**
 * Handler execution for the "body ops" — shared by the MV3 sandbox (hook,
 * debugger and process tiers) and the MV2 background page (process tier),
 * so chain semantics are identical everywhere:
 *
 *   requestDecision — onRequest handlers in order; the first terminal result
 *                     (respond / redirect / cancel) wins, header edits merge
 *   replace         — replaceResponse handlers; first non-null result wins
 *   transform       — modifyResponse handlers compose in order
 *   responseHeaders — onResponseHeaders handlers; header edits merge
 */
import { formatScriptError } from "./scriptError";
import { matchAny } from "./matcher";
import type { ScriptHandlers } from "./compile";
import { seenLine, type NetKind } from "./netTypes";

export type BodyOp = "requestDecision" | "transform" | "replace" | "responseHeaders";

export interface OpScript {
    id: string;
    name: string;
    match: string[];
    handlers: ScriptHandlers;
}

export interface OpEnv {
    /** kind "seen": the handler ran but changed nothing (DEBUG line) */
    log(scriptId: string, level: "debug" | "info" | "warn" | "error", msg: string, kind?: NetKind): void;
    debug?(msg: string): void;
}

export function guessMimeFromUrl(url: string): string {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
    const m: Record<string, string> = { js: "application/javascript", json: "application/json", css: "text/css", html: "text/html", xml: "application/xml" };
    return m[ext] || "application/json";
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
    transform: "modifyResponse",
    replace: "replaceResponse",
    responseHeaders: "onResponseHeaders",
};

/** matching scripts with handlers for `op`, in list order */
function matching(scripts: OpScript[], op: BodyOp, url: string, onlyIds: string[] | undefined, env: OpEnv): { s: OpScript; handlers: any[] }[] {
    const handler = HANDLER_OF[op];
    const out: { s: OpScript; handlers: any[] }[] = [];
    for (const s of scripts) {
        if (!matchAny(s.match, url)) continue;
        if (onlyIds && !onlyIds.includes(s.id)) continue;
        const handlers = (s.handlers as any)[handler] || [];
        if (handlers.length) out.push({ s, handlers });
    }
    env.debug?.(`run ${op} ${url} → ${out.length} matching script(s) [${out.map((m) => m.s.name).join(", ")}]`);
    return out;
}

function mergeHeaderMods(prev: any, next: any): any {
    return { set: { ...(prev?.set || {}), ...(next.set || {}) }, remove: [...(prev?.remove || []), ...(next.remove || [])] };
}

function hasHeaderMods(h: any): boolean {
    return !!h && ((h.set && Object.keys(h.set).length > 0) || (h.remove && h.remove.length > 0));
}

export async function runOp(scripts: OpScript[], op: BodyOp, args: any, env: OpEnv): Promise<any> {
    const url: string = args.url;
    const method: string = args.method;
    const base = () => ({
        url,
        method,
        tabUrl: args.tabUrl || url,
        resourceType: args.resourceType || "xmlhttprequest",
        requestHeaders: args.requestHeaders || {},
    });
    const list = matching(scripts, op, url, args.onlyIds, env);
    const seen = (s: OpScript, handler: string) => env.log(s.id, "debug", seenLine(s.name, handler, url), "seen");

    if (op === "requestDecision") {
        let headerMods: any = null;
        for (const { s, handlers } of list) {
            for (const onRequest of handlers) {
                try {
                    const result = await onRequest(base());
                    if (!result) {
                        seen(s, "onRequest");
                        continue;
                    }
                    if (result.respond) {
                        const r = result.respond;
                        const mime = r.mime || guessMimeFromUrl(url);
                        const content = serializeRespondBody(r.body);
                        env.log(s.id, "info", `[${s.name}] onRequest → respond ${r.status || 200} ${mime} (${content.length}b) ${url}`);
                        return { kind: "respond", mime, content, status: r.status, headers: r.headers?.set };
                    }
                    if (result.redirect) {
                        env.log(s.id, "info", `[${s.name}] onRequest → redirect → ${result.redirect} ${url}`);
                        return { kind: "redirect", url: result.redirect };
                    }
                    if (result.cancel) {
                        env.log(s.id, "info", `[${s.name}] onRequest → cancel ${url}`);
                        return { kind: "cancel" };
                    }
                    if (hasHeaderMods(result.headers)) {
                        const parts: string[] = [];
                        if (result.headers.set && Object.keys(result.headers.set).length) parts.push(`set ${Object.keys(result.headers.set).join(", ")}`);
                        if (result.headers.remove && result.headers.remove.length) parts.push(`remove ${result.headers.remove.join(", ")}`);
                        env.log(s.id, "info", `[${s.name}] onRequest → request headers (${parts.join("; ")}) ${url}`);
                        headerMods = mergeHeaderMods(headerMods, result.headers);
                    } else seen(s, "onRequest");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onRequest"));
                }
            }
        }
        return headerMods ? { kind: "headers", changes: headerMods } : null;
    }

    if (op === "responseHeaders") {
        let mods: any = null;
        for (const { s, handlers } of list) {
            for (const h of handlers) {
                try {
                    const result = await h({ ...base(), status: args.status, statusLine: args.statusLine || "", responseHeaders: args.responseHeaders || [] });
                    if (hasHeaderMods(result?.headers)) {
                        env.log(s.id, "info", `[${s.name}] onResponseHeaders → ${Object.keys(result.headers.set || {}).length} set, ${(result.headers.remove || []).length} removed ${url}`);
                        mods = mergeHeaderMods(mods, result.headers);
                    } else seen(s, "onResponseHeaders");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "onResponseHeaders"));
                }
            }
        }
        return mods;
    }

    if (op === "transform") {
        let out: string | Uint8Array = args.body || "";
        let touched = false;
        for (const { s, handlers } of list) {
            for (const transform of handlers) {
                try {
                    const result: any = await transform({ ...base(), contentType: args.contentType, status: args.status }, out);
                    if (result !== undefined && result !== null) {
                        const before = typeof out === "string" ? out.length : out.byteLength;
                        const prevOut = out;
                        const next = typeof result === "string" ? result : result instanceof Uint8Array ? result : JSON.stringify(result);
                        const after = typeof next === "string" ? next.length : next.byteLength;
                        out = next;
                        if (next !== prevOut) env.log(s.id, "info", `[${s.name}] modifyResponse applied (${before}b → ${after}b) ${url}`);
                        else seen(s, "modifyResponse");
                        touched = true;
                    } else seen(s, "modifyResponse");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "modifyResponse"));
                }
            }
        }
        return touched ? (typeof out === "string" ? out : new TextDecoder().decode(out)) : null;
    }

    if (op === "replace") {
        for (const { s, handlers } of list) {
            for (const replace of handlers) {
                try {
                    const out = await replace(base());
                    if (out !== undefined && out !== null) {
                        const isFile = out && typeof out === "object" && typeof out.file === "string";
                        const { mime, content: body } = isFile ? resolveFileRef(out.file, url) : { mime: guessMimeFromUrl(url), content: typeof out === "string" ? out : String(out) };
                        env.log(s.id, "info", `[${s.name}] replaceResponse → ${mime} (${body.length}b) ${url}`);
                        return { mime, content: body };
                    }
                    seen(s, "replaceResponse");
                } catch (e: any) {
                    env.log(s.id, "error", formatScriptError(s.name, e, "replaceResponse"));
                }
            }
        }
        return null;
    }

    return null;
}
