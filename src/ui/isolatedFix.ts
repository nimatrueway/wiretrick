/**
 * The quick fix for a page-world `overlay.fn()` call: run the `wt.onPage`
 * handler it's in in the isolated world (onPage's default). Rewrites the
 * nearest `wt.onPage(` before the call: its route's `js: "page"` becomes
 * `js: "isolated"`.
 */

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

/** the edit, in code offsets, or null when the route isn't a literal */
export function isolatedRouteEdit(code: string, offset: number): { start: number; end: number; text: string } | null {
    const re = /\bwt\s*\.\s*onPage\s*\(\s*/g;
    let at = -1;
    for (let m = re.exec(code); m && m.index < offset; m = re.exec(code)) at = m.index + m[0].length;
    if (at < 0) return null;
    const end = skip(code, at);
    if (end < 0) return null;
    const route = code.slice(at, end);
    const js = route[0] === "{" ? /\bjs\s*:\s*(["'`])page\1/.exec(route) : null;
    return js ? { start: at + js.index, end: at + js.index + js[0].length, text: 'js: "isolated"' } : null;
}
