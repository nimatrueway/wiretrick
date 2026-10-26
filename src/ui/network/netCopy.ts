/**
 * Network → right-click → Copy: a request as a URL, a cURL command (bash)
 * or a fetch() call, devtools-style. Several requests join like devtools'
 * "Copy all as …".
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

export type CopyKind = "url" | "curl" | "fetch";

export function copyRequests(list: NetEntry[], kind: CopyKind): string {
    if (kind === "url") return list.map((e) => e.url).join("\n");
    return list.map(kind === "curl" ? asCurl : asFetch).join(kind === "curl" ? " ;\n" : "\n\n");
}
