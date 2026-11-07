/** Lightweight source scans (not a parser) for the static checks and quick fixes. */

/**
 * `code` with comments and string/regex literal contents blanked to spaces
 * (same length, newlines kept); a template's `${…}` code is kept.
 */
export function codeOnly(code: string): string {
    const out = code.split("");
    const blank = (from: number, to: number) => {
        for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
    };
    const n = code.length;
    let prev = "";
    let i = 0;
    /** brace depth inside each open template's `${…}` */
    const tpl: number[] = [];
    const string = (quote: string) => {
        // from just past the opening quote; returns where the literal (or the template chunk) ends
        let cls = false;
        let j = i;
        while (j < n) {
            const d = code[j];
            if (d === "\\") {
                j += 2;
                continue;
            }
            if (d === "\n" && quote !== "`") break;
            if (quote === "/") {
                if (d === "[") cls = true;
                else if (d === "]") cls = false;
                else if (d === "/" && !cls) break;
            }
            if (quote === "`" && d === "$" && code[j + 1] === "{") {
                blank(i, j);
                tpl.push(0);
                return j + 2;
            }
            if (d === quote) break;
            j++;
        }
        // an unclosed "regex" is a division or JSX's `/>`: leave the line be
        if (quote === "/" && code[j] !== "/") return i;
        blank(i, Math.min(j, n));
        return j + 1;
    };
    while (i < n) {
        const c = code[i];
        if (c === "/" && code[i + 1] === "/") {
            const end = code.indexOf("\n", i);
            blank(i, end < 0 ? n : end);
            i = end < 0 ? n : end;
            continue;
        }
        if (c === "/" && code[i + 1] === "*") {
            const end = code.indexOf("*/", i + 2);
            const stop = end < 0 ? n : end + 2;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (tpl.length && c === "}" && tpl[tpl.length - 1] === 0) {
            // back in the template's text
            tpl.pop();
            i++;
            i = string("`");
            prev = "a";
            continue;
        }
        if (tpl.length && c === "{") tpl[tpl.length - 1]++;
        else if (tpl.length && c === "}") tpl[tpl.length - 1]--;
        if (c === '"' || c === "'" || c === "`" || (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)))) {
            i++;
            i = string(c);
            prev = "a";
            continue;
        }
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return out.join("");
}

/** where the bracketed group opening just before `from` closes (the index past it) */
export function closeOf(src: string, from: number): number {
    let depth = 1;
    let to = from;
    while (to < src.length && depth) {
        const c = src[to++];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
    }
    return to;
}
