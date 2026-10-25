/**
 * ctx.requestBody / ctx.json(): the request payload, read-only. Text or
 * binary is decided by bodyKind on the request's Content-Type, the same check
 * (and settings.textTypes) as response bodies. helper/src/proxy.rs mirrors
 * REQUEST_BODY_CAP.
 */
import { bodyKind } from "./bodyKind";

/** bigger bodies aren't read: ctx.requestBody is undefined */
export const REQUEST_BODY_CAP = 8 * 1024 * 1024;

export type RequestBody = string | Uint8Array;

const REQUEST_STREAM_WAIT_MS = 2000;

const isBytes = (b: unknown): b is Uint8Array => b instanceof Uint8Array || Object.prototype.toString.call(b) === "[object Uint8Array]";

/** raw bytes → what ctx.requestBody holds; empty or over the cap → undefined */
export function requestBodyFrom(bytes: Uint8Array | null | undefined, contentType: string | null | undefined): RequestBody | undefined {
    if (!bytes || !bytes.length || bytes.length > REQUEST_BODY_CAP) return undefined;
    return bodyKind(contentType, bytes) === "binary" ? bytes : new TextDecoder().decode(bytes);
}

/** a string body as-is, except the kind check still applies (a binary Content-Type → bytes) */
export function requestBodyFromText(text: string | null | undefined, contentType: string | null | undefined): RequestBody | undefined {
    if (!text) return undefined;
    if (contentType && bodyKind(contentType, null) === "binary") return requestBodyFrom(new TextEncoder().encode(text), contentType);
    return text.length > REQUEST_BODY_CAP ? undefined : text;
}

export function concatBytes(list: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) {
        out.set(b, at);
        at += b.length;
    }
    return out;
}

/**
 * webRequest's details.requestBody: formData → urlencoded string, raw → the
 * bytes (no Content-Type yet: sniffed). File parts or bytes Chrome left out
 * (large uploads) → undefined.
 */
export function requestBodyFromWebRequest(rb: { raw?: { bytes?: ArrayBuffer; file?: string }[]; formData?: { [name: string]: unknown[] }; error?: string } | null | undefined): RequestBody | undefined {
    if (!rb || rb.error) return undefined;
    if (rb.formData) {
        return requestBodyFromText(
            Object.entries(rb.formData)
                .flatMap(([k, vs]) => (Array.isArray(vs) ? vs : []).map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`))
                .join("&"),
            "application/x-www-form-urlencoded"
        );
    }
    if (!rb.raw?.length || rb.raw.some((p) => !p.bytes)) return undefined;
    return requestBodyFrom(concatBytes(rb.raw.map((p) => new Uint8Array(p.bytes!))), undefined);
}

/** case-insensitive header lookup over an object, [name, value] pairs or {name, value} list */
export function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== "object") return undefined;
    const n = name.toLowerCase();
    if (Array.isArray(headers)) {
        for (const h of headers) {
            const [k, v] = Array.isArray(h) ? h : [h?.name, h?.value];
            if (typeof k === "string" && k.toLowerCase() === n) return v == null ? undefined : String(v);
        }
        return undefined;
    }
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === n) return v == null ? undefined : String(v);
    return undefined;
}

/**
 * The page strategy's ctx.requestBody for a fetch(input, init) (XHR goes
 * through fetch too): a copy — the page's own body is never consumed.
 * Streams and bodies over the cap → undefined; never throws.
 */
export async function readFetchBody(input: unknown, init: RequestInit | undefined, url: string, method: string): Promise<RequestBody | undefined> {
    try {
        if (/^(GET|HEAD)$/i.test(method)) return undefined;
        const body: any = init?.body;
        if (body !== undefined && body !== null) {
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            if (typeof body === "string") return requestBodyFromText(body, headers.get("content-type"));
            if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return undefined;
            const size = body instanceof Blob ? body.size : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body.byteLength : 0;
            if (size > REQUEST_BODY_CAP) return undefined;
            // URLSearchParams / FormData / Blob get the Content-Type the browser would send
            const r = new Request(url, { method, body, headers });
            return requestBodyFrom(new Uint8Array(await r.arrayBuffer()), r.headers.get("content-type"));
        }
        if (input instanceof Request && input.body && !input.bodyUsed) {
            // a Request built on a stream the page fills later: don't wait on it
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), REQUEST_STREAM_WAIT_MS)));
            const buf = await Promise.race([input.clone().arrayBuffer(), late]).finally(() => clearTimeout(timer));
            return buf ? requestBodyFrom(new Uint8Array(buf), input.headers.get("content-type")) : undefined;
        }
    } catch {}
    return undefined;
}

/** the ctx fields: requestBody plus json(), which parses it */
export function requestBodyCtx(body: RequestBody | undefined): { requestBody: RequestBody | undefined; json: <T = any>() => T | undefined } {
    const requestBody = typeof body === "string" || isBytes(body) ? (body as RequestBody) : undefined;
    return {
        requestBody,
        json<T = any>(): T | undefined {
            if (requestBody === undefined) return undefined;
            const text = typeof requestBody === "string" ? requestBody : new TextDecoder().decode(requestBody);
            try {
                return JSON.parse(text) as T;
            } catch (e) {
                throw new Error(`ctx.json(): the request body is not valid JSON (${(e as Error)?.message || e})`);
            }
        },
    };
}
