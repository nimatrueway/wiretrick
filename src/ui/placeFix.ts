/**
 * Editor quick fixes for where a handler runs:
 * - an onSite handler using a store or a handle (which the site's world
 *   can't have): move it to wt.onPage;
 * - a route with the removed `js` / `dom` / `unsafe` options: the API that
 *   replaces them (js: "page" → wt.onSite, dom: "overlay" → wt.onOverlay).
 */

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

/** where the bracket/quote opened at `open` closes (exclusive), or -1 */
function skip(code: string, open: number): number {
    const c = code[open];
    if (c === '"' || c === "'" || c === "`") {
        for (let i = open + 1; i < code.length; i++) {
            if (code[i] === "\\") i++;
            else if (code[i] === c) return i + 1;
        }
        return -1;
    }
    const close = c === "{" ? "}" : c === "[" ? "]" : c === "(" ? ")" : "";
    if (!close) return -1;
    for (let i = open + 1; i < code.length; i++) {
        const d = code[i];
        if (d === close) return i + 1;
        if (d === '"' || d === "'" || d === "`" || d === "{" || d === "[" || d === "(") {
            const end = skip(code, i);
            if (end < 0) return -1;
            i = end - 1;
        }
    }
    return -1;
}

/** `wt.onSite` registrations' `onSite` name, at or before `offset`: the nearest one becomes `onPage` */
export function onPageEdit(code: string, offset: number): TextEdit | null {
    const re = /\bwt\s*\.\s*(onSite)\s*\(/g;
    let at = -1;
    for (let m = re.exec(code); m && m.index < offset; m = re.exec(code)) at = m.index + m[0].indexOf("onSite");
    return at < 0 ? null : { start: at, end: at + "onSite".length, text: "onPage" };
}

const LEGACY_PROP = /\b(js|dom|unsafe)\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|(true|false))/g;

/**
 * The registration with removed route options nearest before `offset` (else
 * the first): its API by what they asked for, and the options dropped.
 * Null when there's none, or a route isn't a literal.
 */
export function legacyRouteEdit(code: string, offset: number): TextEdit | null {
    const re = /\bwt\s*\.\s*(onPage|onOverlay)\s*\(\s*/g;
    let pick: TextEdit | null = null;
    for (let m = re.exec(code); m; m = re.exec(code)) {
        const at = m.index + m[0].length;
        if (code[at] !== "{") continue;
        const end = skip(code, at);
        if (end < 0) continue;
        const route = code.slice(at, end);
        const opts: Record<string, string> = {};
        for (const p of route.matchAll(LEGACY_PROP)) opts[p[1]] = p[2] ?? p[3] ?? p[4] ?? p[5];
        if (!Object.keys(opts).length) continue;
        const api = m[1] === "onOverlay" || opts.dom === "overlay" ? "onOverlay" : opts.js === "page" ? "onSite" : "onPage";
        const cleaned = route
            .replace(new RegExp(`\\s*${LEGACY_PROP.source}\\s*,?`, "g"), "")
            .replace(/,(\s*)}$/, (_, ws: string) => (ws.includes("\n") ? `,${ws}}` : " }"))
            .replace(/{\s*}/, "{}")
            .replace(/^{(?=\S)(?!})/, "{ ");
        const start = m.index + m[0].indexOf(m[1]);
        const edit = { start, end, text: api + code.slice(start + m[1].length, at) + cleaned };
        if (m.index < offset || !pick) pick = edit;
        if (m.index >= offset) break;
    }
    return pick;
}
