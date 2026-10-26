/**
 * Network → right-click → Copy: a request as a URL, a cURL command (bash),
 * a fetch() call or HAR, devtools-style. Several requests join like
 * devtools' "Copy all as …" (HAR: one log with every request).
 */
import type { NetEntry } from "../../shared/netTypes";

/** dropped from cURL/fetch: HTTP/2 pseudo-headers and ones the client sets itself */
const SKIP = new Set(["host", "content-length", "connection", "accept-encoding", "method", "path", "scheme", "version", "authority", "protocol"]);

const headersOf = (e: NetEntry): [string, string][] => (e.requestHeaders ?? []).filter(([k]) => !k.startsWith(":") && !SKIP.has(k.toLowerCase()));

/** the body to replay, or why it can't be */
function bodyOf(e: NetEntry): { text: string | null; missing?: string } {
    const b = e.requestBody;
    if (!b) return { text: null };
    if (b.binary) return { text: null, missing: `binary request body (${b.size} bytes) not captured` };
    if (b.truncated) return { text: null, missing: `request body only partly captured (${b.size} bytes)` };
    return { text: b.text };
}

/** bash single-quoting; $'…' when the text has control characters */
export function shellQuote(s: string): string {
    if (!/[\x00-\x1f\x7f]/.test(s)) return `'${s.replace(/'/g, `'\\''`)}'`;
    const esc = s.replace(/[\\'\x00-\x1f\x7f]/g, (c) => {
        const named: Record<string, string> = { "\\": "\\\\", "'": "\\'", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
        return named[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
    });
    return `$'${esc}'`;
}

export function asCurl(e: NetEntry): string {
    const { text, missing } = bodyOf(e);
    const parts = [`curl ${shellQuote(e.url)}`];
    // --data-raw already implies POST
    if (e.method !== "GET" && !(e.method === "POST" && text !== null)) parts.push(`-X ${shellQuote(e.method)}`);
    for (const [k, v] of headersOf(e)) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
    if (text !== null) parts.push(`--data-raw ${shellQuote(text)}`);
    if (e.requestHeaders?.some(([k]) => k.toLowerCase() === "accept-encoding")) parts.push("--compressed");
    return (missing ? `# ${missing}\n` : "") + parts.join(" \\\n  ");
}

export function asFetch(e: NetEntry): string {
    const { text, missing } = bodyOf(e);
    const headers = headersOf(e);
    const referrer = headers.find(([k]) => k.toLowerCase() === "referer")?.[1];
    const opts: Record<string, unknown> = {
        headers: Object.fromEntries(headers.filter(([k]) => k.toLowerCase() !== "referer")),
        ...(referrer ? { referrer } : {}),
        body: text,
        method: e.method,
    };
    return (missing ? `// ${missing}\n` : "") + `fetch(${JSON.stringify(e.url)}, ${JSON.stringify(opts, null, 2)});`;
}

const HAR_TYPES: Record<string, string> = { main_frame: "document", sub_frame: "document", xmlhttprequest: "xhr", image: "image", imageset: "image", csp_report: "csp" };

const nameValues = (rows: [string, string][] | undefined) => (rows ?? []).map(([name, value]) => ({ name, value }));
const headerOf = (rows: [string, string][] | undefined, name: string) => rows?.find(([k]) => k.toLowerCase() === name)?.[1];

function cookiesIn(rows: [string, string][] | undefined, header: "cookie" | "set-cookie") {
    const out: { name: string; value: string }[] = [];
    for (const [k, v] of rows ?? []) {
        if (k.toLowerCase() !== header) continue;
        // Cookie: a=1; b=2 — Set-Cookie: a=1; Path=/ (one per header; attributes skipped)
        for (const part of header === "cookie" ? v.split(";") : v.split("\n").map((l) => l.split(";")[0])) {
            const eq = part.indexOf("=");
            if (eq > 0) out.push({ name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
        }
    }
    return out;
}

/** why a recorded body isn't all there (HAR `comment`) */
const bodyNote = (b: { truncated: boolean; binary: boolean; size: number }) =>
    b.binary ? `binary body (${b.size} bytes) not captured` : b.truncated ? `body cut to the first part of ${b.size} bytes (Settings → Network → Body capture)` : undefined;

function harEntry(e: NetEntry) {
    const time = e.endedAt !== null ? Math.max(0, e.endedAt - e.startedAt) : 0;
    let queryString: { name: string; value: string }[] = [];
    try {
        queryString = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value }));
    } catch {}
    const rb = e.requestBody;
    const res = e.responseBody;
    const mime = e.mime || headerOf(e.responseHeaders, "content-type") || "";
    return {
        startedDateTime: new Date(e.startedAt).toISOString(),
        time,
        request: {
            method: e.method,
            url: e.url,
            httpVersion: "",
            cookies: cookiesIn(e.requestHeaders, "cookie"),
            headers: nameValues(e.requestHeaders),
            queryString,
            ...(rb ? { postData: { mimeType: headerOf(e.requestHeaders, "content-type") ?? "", text: rb.binary ? "" : rb.text, ...(bodyNote(rb) ? { comment: bodyNote(rb) } : {}) } } : {}),
            headersSize: -1,
            bodySize: rb ? rb.size : 0,
        },
        response: {
            status: e.status ?? 0,
            statusText: e.statusText ?? "",
            httpVersion: "",
            cookies: cookiesIn(e.responseHeaders, "set-cookie"),
            headers: nameValues(e.responseHeaders),
            content: {
                size: res ? res.size : (e.size ?? 0),
                mimeType: mime,
                ...(res && !res.binary ? { text: res.text } : {}),
                // browsers don't expose response bodies: only ones a script handled are recorded
                ...(res ? (bodyNote(res) ? { comment: bodyNote(res) } : {}) : { comment: "response body not captured" }),
            },
            redirectURL: e.redirectTo ?? "",
            headersSize: -1,
            bodySize: e.size ?? -1,
            ...(e.error ? { _error: e.error } : {}),
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
        ...(e.ip ? { serverIPAddress: e.ip } : {}),
        _resourceType: e.synthetic ? "other" : (HAR_TYPES[e.type] ?? e.type ?? "other"),
        ...(e.outcomes.length ? { _wiretrick: e.outcomes.map((o) => ({ script: o.scriptName, action: o.action, kind: o.kind })) } : {}),
    };
}

/** HAR 1.2: one log with every request in `list` */
export function asHar(list: NetEntry[]): string {
    let version = "";
    try {
        version = (globalThis as any).chrome?.runtime?.getManifest?.().version ?? "";
    } catch {}
    const entries = [...list].sort((a, b) => a.startedAt - b.startedAt).map(harEntry);
    return JSON.stringify({ log: { version: "1.2", creator: { name: "Wiretrick", version }, pages: [], entries } }, null, 2);
}

export type CopyKind = "url" | "curl" | "fetch" | "har";

export function copyRequests(list: NetEntry[], kind: CopyKind): string {
    if (kind === "url") return list.map((e) => e.url).join("\n");
    if (kind === "har") return asHar(list);
    return list.map(kind === "curl" ? asCurl : asFetch).join(kind === "curl" ? " ;\n" : "\n\n");
}
