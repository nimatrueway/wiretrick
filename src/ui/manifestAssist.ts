/**
 * metadata.json's "scripts" completions: the .ts/.tsx files in the bundle's
 * folder (and its subfolders), as paths relative to it, minus the ones already
 * listed. Pure, so it's unit-tested; editor.ts registers it for JSON models.
 */

export interface ManifestScriptCompletions {
    /** relative paths to offer */
    paths: string[];
    /** inside a string: its content's range (the quotes stay); else the cursor (insert a quoted path) */
    replaceFrom: number;
    replaceTo: number;
    inString: boolean;
}

type Frame = { arr: true; key?: string } | { arr: false; key?: string; expectKey: boolean };

/** the string starting at `i` (a quote): its end (past the closing quote, or `text.length` if unterminated) and value */
function readString(text: string, i: number): { end: number; value: string; closed: boolean } {
    let j = i + 1;
    let value = "";
    while (j < text.length && text[j] !== '"' && text[j] !== "\n") {
        if (text[j] === "\\" && j + 1 < text.length) {
            value += text[j + 1];
            j += 2;
        } else value += text[j++];
    }
    const closed = text[j] === '"';
    return { end: closed ? j + 1 : j, value, closed };
}

/**
 * At `offset` in a metadata.json's `text` (in `folder`, "" at the root), what
 * to suggest — null when the cursor isn't in the top-level "scripts" array.
 * `files` are every script's path in the scripts folder.
 */
export function manifestScriptCompletions(text: string, offset: number, folder: string, files: string[]): ManifestScriptCompletions | null {
    const stack: Frame[] = [];
    let lastKey: string | undefined;
    let at: { inString: boolean; from: number; to: number } | null = null;
    let target = -1;
    const listed: string[] = [];
    for (let i = 0; i < text.length; ) {
        const c = text[i];
        const top = stack[stack.length - 1];
        const inScripts = stack.length === 2 && top?.arr && top.key === "scripts";
        if (c === '"') {
            const s = readString(text, i);
            const contentEnd = s.closed ? s.end - 1 : s.end;
            if (at === null && offset > i && offset <= contentEnd) {
                if (!inScripts) return null;
                at = { inString: true, from: i + 1, to: contentEnd };
                target = stack.length;
            } else if (inScripts && (at === null || stack.length === target)) listed.push(s.value);
            if (top && !top.arr && top.expectKey) lastKey = s.value;
            i = s.end;
            continue;
        }
        if (at === null && i >= offset) {
            if (!inScripts) return null;
            at = { inString: false, from: offset, to: offset };
            target = stack.length;
        }
        if (c === "{") stack.push({ arr: false, key: lastKey, expectKey: true });
        else if (c === "[") stack.push({ arr: true, key: top && !top.arr ? lastKey : undefined });
        else if (c === "}" || c === "]") {
            if (at && stack.length === target) break;
            stack.pop();
        } else if (top && !top.arr) {
            if (c === ":") top.expectKey = false;
            else if (c === ",") top.expectKey = true;
        }
        i++;
    }
    if (at === null) {
        const top = stack[stack.length - 1];
        if (!(stack.length === 2 && top?.arr && top.key === "scripts")) return null;
        at = { inString: false, from: offset, to: offset };
    }
    const base = folder ? folder.replace(/\/$/, "") + "/" : "";
    const current = at.inString ? text.slice(at.from, at.to) : null;
    const taken = new Set(listed.filter((p) => p !== current).map((p) => p.replace(/^\.\//, "").toLowerCase()));
    const paths = files
        .filter((f) => /\.tsx?$/i.test(f) && f.toLowerCase().startsWith(base.toLowerCase()))
        .map((f) => f.slice(base.length))
        .filter((p) => !taken.has(p.toLowerCase()))
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return { paths, replaceFrom: at.from, replaceTo: at.to, inString: at.inString };
}
