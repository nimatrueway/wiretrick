/**
 * `wt.fetch` on the script side: the request serialized for a link
 * (`WireRequest`) and the answer rebuilt as a real `Response`. The fetch
 * itself runs where `from` says — the background (src/background/engine/
 * wtFetch.ts) — so these work in any context that compiles scripts.
 */
import { FETCH_MAX_BYTES, type WireRequest, type WireResponse } from "./wire";

export type WtFetchInit = RequestInit & { from?: "page" | "background"; bypass?: boolean };

/** the Response statuses that can't have a body */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** split `init` into the fetch options and wt's own (`from`, `bypass`) */
export function splitFetchInit(init: WtFetchInit | undefined): { init: RequestInit; from?: string; bypass: boolean } {
    if (init !== undefined && (init === null || typeof init !== "object")) throw new TypeError("wt.fetch: the second argument must be an options object");
    const { from, bypass, ...rest } = init ?? {};
    if (from !== undefined && from !== "page" && from !== "background") throw new TypeError(`wt.fetch: from must be "page" or "background" (got ${JSON.stringify(from)})`);
    return { init: rest, from, bypass: !!bypass };
}

/**
 * Serialize a request for the link. The URL must be absolute: a
 * background fetch has no page to resolve it against.
 */
export async function toWireRequest(input: RequestInfo | URL, init: RequestInit): Promise<WireRequest> {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url;
    try {
        new URL(raw);
    } catch {
        throw new TypeError(`wt.fetch: "${raw}" isn't an absolute URL — a background fetch has no page to resolve it against`);
    }
    // a signal can't cross the link; drop it rather than fail
    const { signal: _signal, ...rest } = init;
    const req = new Request(input instanceof URL ? input.href : input, rest);
    const out: WireRequest = { url: req.url, method: req.method, headers: [...req.headers] };
    if (req.method !== "GET" && req.method !== "HEAD") {
        const body = new Uint8Array(await req.arrayBuffer());
        if (body.byteLength > FETCH_MAX_BYTES) throw new RangeError(`wt.fetch: the request body is larger than ${FETCH_MAX_BYTES / 1024 / 1024} MB`);
        if (body.byteLength || init.body != null) out.body = body;
    }
    // only what the caller set: the background picks its own defaults (cookies: include)
    const opts = input instanceof Request ? { ...pick(input), ...init } : init;
    if (opts.credentials) out.credentials = req.credentials;
    if (opts.redirect) out.redirect = req.redirect;
    if (opts.cache) out.cache = req.cache;
    if (opts.referrerPolicy) out.referrerPolicy = req.referrerPolicy;
    if (opts.referrer !== undefined) out.referrer = req.referrer;
    return out;
}

function pick(r: Request): RequestInit {
    // a Request always has every field; treat only non-defaults as set
    const out: RequestInit = {};
    if (r.credentials !== "same-origin") out.credentials = r.credentials;
    if (r.redirect !== "follow") out.redirect = r.redirect;
    if (r.cache !== "default") out.cache = r.cache;
    if (r.referrerPolicy) out.referrerPolicy = r.referrerPolicy;
    return out;
}

/** a wire request as fetch arguments */
export function fromWireRequest(w: WireRequest, defaults: RequestInit = {}): [string, RequestInit] {
    const init: RequestInit = { ...defaults, method: w.method, headers: w.headers };
    if (w.body && w.method !== "GET" && w.method !== "HEAD") init.body = w.body as BodyInit;
    if (w.credentials) init.credentials = w.credentials;
    if (w.redirect) init.redirect = w.redirect;
    if (w.cache) init.cache = w.cache;
    if (w.referrer !== undefined) init.referrer = w.referrer;
    if (w.referrerPolicy) init.referrerPolicy = w.referrerPolicy;
    return [w.url, init];
}

/** read a fetched Response into a wire response, refusing bodies over the cap */
export async function toWireResponse(r: Response, max = FETCH_MAX_BYTES): Promise<WireResponse> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = r.body?.getReader();
    if (reader) {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > max) {
                void reader.cancel();
                throw new RangeError(`wt.fetch: the response from ${r.url} is larger than ${max / 1024 / 1024} MB`);
            }
            chunks.push(value);
        }
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
        body.set(c, at);
        at += c.byteLength;
    }
    return { status: r.status, statusText: r.statusText, url: r.url, headers: [...r.headers], body };
}

/** rebuild a real Response (with the original `url` and `status`, which the constructor can't set) */
export function fromWireResponse(w: WireResponse): Response {
    const inRange = w.status >= 200 && w.status <= 599;
    const nullBody = NULL_BODY.has(w.status) || !inRange;
    const r = new Response(nullBody ? null : (w.body as BodyInit), { status: inRange ? w.status : 200, statusText: w.statusText, headers: w.headers });
    Object.defineProperty(r, "url", { value: w.url, enumerable: true });
    if (!inRange) {
        Object.defineProperty(r, "status", { value: w.status, enumerable: true });
        Object.defineProperty(r, "ok", { value: false, enumerable: true });
    }
    return r;
}
