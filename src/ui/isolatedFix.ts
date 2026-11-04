/**
 * The quick fix for a main-world `overlay.fn()` call: run the `wt.onPage`
 * handler it's in in the isolated world. Rewrites the route (the first
 * argument) of the nearest `wt.onPage(` / `wt.onDocument(` before the call:
 * a URL string or array becomes `{ url: …, world: "isolated" }`, an object
 * gets `world: "isolated"` (replacing `world: "main"`). The deprecated
 * `wt.onDocument` (no `world` option) becomes `wt.onPage` too.
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
    const re = /\bwt\s*\.\s*(on(?:Page|Document))\s*\(\s*/g;
    let at = -1;
    let rename = -1;
    for (let m = re.exec(code); m && m.index < offset; m = re.exec(code)) {
        at = m.index + m[0].length;
        rename = m[1] === "onDocument" ? m.index + m[0].indexOf("onDocument") : -1;
    }
    if (at < 0) return null;
    const end = skip(code, at);
    if (end < 0) return null;
    const route = code.slice(at, end);
    let edit: { start: number; end: number; text: string } | null;
    const world = /\bworld\s*:\s*(["'`])main\1/.exec(route);
    if (route[0] !== "{") edit = { start: at, end, text: `{ url: ${route}, world: "isolated" }` };
    else if (world) edit = { start: at + world.index, end: at + world.index + world[0].length, text: 'world: "isolated"' };
    else if (/\bworld\s*:/.test(route)) edit = null;
    else edit = { start: at + 1, end: at + 1, text: ' world: "isolated",' };
    // one contiguous edit: from the API name through the route
    if (edit && rename >= 0) edit = { start: rename, end: edit.end, text: "onPage" + code.slice(rename + "onDocument".length, edit.start) + edit.text };
    return edit;
}
