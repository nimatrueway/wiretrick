/**
 * URIs in Log lines: any `scheme://…`, plus the common opaque schemes
 * (`mailto:`, `data:`, `about:`, `blob:`, `urn:`…). Script-running and
 * non-navigable schemes are left as text.
 */
const URI_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|sms|urn|data|about|blob|magnet|news|geo|view-source):)[^\s<>"'`]+/gi;
const NOT_LINKS = /^(?:javascript|vbscript|ws|wss):/i;
const TRAILING = /[.,;:!?…]$/;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (s: string, c: string): number => s.split(c).length - 1;

/** Drop sentence punctuation and unbalanced closing brackets glued to the end. */
function trimUri(uri: string): string {
    for (;;) {
        const last = uri.slice(-1);
        if (TRAILING.test(last)) uri = uri.slice(0, -1);
        else if (PAIRS[last] && count(uri, last) > count(uri, PAIRS[last])) uri = uri.slice(0, -1);
        else return uri;
    }
}

export interface LogSegment {
    text: string;
    /** set: this run is (part of) a link to it */
    uri?: string;
    /** inside the Log find highlight */
    mark?: boolean;
}

/** Split a Log line into plain/link runs, further split at the find highlight [start, end). */
export function logSegments(text: string, mark?: [number, number]): LogSegment[] {
    const cuts = new Set([0, text.length]);
    const links: { start: number; end: number; uri: string }[] = [];
    for (const m of text.matchAll(URI_RE)) {
        const uri = trimUri(m[0]);
        if (NOT_LINKS.test(uri) || /^[a-z][a-z0-9+.-]*:\/*$/i.test(uri)) continue;
        links.push({ start: m.index!, end: m.index! + uri.length, uri });
        cuts.add(m.index!).add(m.index! + uri.length);
    }
    if (mark && mark[1] > mark[0]) cuts.add(mark[0]).add(mark[1]);
    const at = [...cuts].sort((a, b) => a - b);
    const out: LogSegment[] = [];
    for (let i = 0; i < at.length - 1; i++) {
        const [s, e] = [at[i], at[i + 1]];
        const link = links.find((l) => l.start <= s && e <= l.end);
        const marked = !!mark && mark[0] <= s && e <= mark[1];
        out.push({ text: text.slice(s, e), ...(link ? { uri: link.uri } : {}), ...(marked ? { mark: true } : {}) });
    }
    return out;
}

/** Schemes a browser tab can show; anything else is handed to the OS (vscode:, mailto:…). */
export const opensInTab = (uri: string): boolean => /^(?:https?|ftp|file|chrome|chrome-extension|moz-extension|edge|brave|about|data|blob|view-source):/i.test(uri);
