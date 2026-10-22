/**
 * TS QuickInfo → hover markdown, the way VS Code's TypeScript extension
 * renders it (textRendering.ts): signature as a code block, documentation
 * as markdown, then tags — @example as a code block, @param as
 * `name` — text, {@link X} as `X`. Monaco's built-in hover flattens
 * all of this into one paragraph.
 */

export interface SymbolPart {
    text: string;
    kind: string;
    /** {@link} targets (linkName parts) */
    target?: { fileName: string; textSpan: { start: number; length: number } };
}
/** href for a {@link X} reference, or undefined to render it as plain `X` */
export type LinkResolver = (name: string, part: SymbolPart) => string | undefined;
export interface TagInfo {
    name: string;
    text?: SymbolPart[] | string;
}
export interface QuickInfoLike {
    displayParts?: SymbolPart[];
    documentation?: SymbolPart[];
    tags?: TagInfo[];
}

/** plain text of display parts; {@link X} / {@link X | label} → `X` / label (a markdown link when `resolve` knows X) */
export function partsToMarkdown(parts: SymbolPart[] | string | undefined, resolve?: LinkResolver): string {
    if (!parts) return "";
    if (typeof parts === "string") return parts;
    let out = "";
    let link: { name: string; text: string; part?: SymbolPart } | null = null;
    let afterLink = false;
    for (const p of parts) {
        // TS swallows the line break after a closing `}` of {@link}
        if (afterLink && p.kind !== "link" && /^\w/.test(p.text)) out += " ";
        afterLink = false;
        if (p.kind === "link") {
            if (link) {
                const label = link.text.trim() || "`" + link.name + "`";
                const href = link.part && resolve?.(link.name, link.part);
                out += href ? `[${label}](${href})` : label;
                link = null;
                afterLink = true;
            } else link = { name: "", text: "" };
        } else if (link && p.kind === "linkName") {
            link.name += p.text;
            link.part ??= p;
        }
        else if (link && p.kind === "linkText") link.text += p.text;
        else out += p.text;
    }
    return out;
}

const codeBlock = (text: string): string => (/^\s*[~`]{3}/m.test(text) ? text : "```typescript\n" + text.replace(/^\n+|\s+$/g, "") + "\n```");

function tagBody(tag: TagInfo, resolve?: LinkResolver): string {
    const code = tag.name === "example" || tag.name === "default";
    const text = partsToMarkdown(tag.text, code ? undefined : resolve);
    if (!text) return "";
    if (tag.name === "example") {
        const cap = /^<caption>(.*?)<\/caption>\s*\r?\n/.exec(text);
        return cap ? cap[1] + "\n" + codeBlock(text.slice(cap[0].length)) : codeBlock(text);
    }
    if (tag.name === "default") return codeBlock(text);
    return text;
}

function tagToMarkdown(tag: TagInfo, resolve?: LinkResolver): string | null {
    if ((tag.name === "param" || tag.name === "template") && Array.isArray(tag.text)) {
        const i = tag.text.findIndex((p) => p.kind === "parameterName" || p.kind === "typeParameterName");
        if (i >= 0) {
            const doc = partsToMarkdown(tag.text.slice(i + 1), resolve).trim();
            const label = `*@${tag.name}* \`${tag.text[i].text}\``;
            return doc ? `${label} — ${doc}` : label;
        }
    }
    if ((tag.name === "returns" || tag.name === "return") && !partsToMarkdown(tag.text)) return null;
    const label = `*@${tag.name}*`;
    const body = tagBody(tag, resolve);
    if (!body) return label;
    return label + (/\n/.test(body) ? "  \n" + body : ` — ${body}`);
}

const OPEN = "([{<";
const CLOSE = ")]}>";

/** split `text` at top-level occurrences of `sep` (ignores =>, strings) */
function splitTop(text: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = "";
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c) && text[i - 1] !== "=") depth--;
        else if (depth === 0 && text.startsWith(sep, i)) {
            out.push(text.slice(start, i));
            start = i + sep.length;
            i += sep.length - 1;
        }
    }
    out.push(text.slice(start));
    return out;
}

/** index of the bracket closing the one at `open` */
function matching(text: string, open: number): number {
    let depth = 0;
    let quote = "";
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = "";
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c) && text[i - 1] !== "=" && --depth === 0) return i;
    }
    return -1;
}

/**
 * Wrap a long one-line signature the way a formatter would: each parameter
 * on its own line, and long unions one member per line.
 */
export function formatSignature(sig: string, width = 80): string {
    if (sig.includes("\n") || sig.length <= width) return sig;
    const prefix = /^\((?:method|function|property|parameter|const|let|var|alias|type)\)\s/.exec(sig)?.[0] ?? "";
    const body = sig.slice(prefix.length);
    // parameter list: first `(` that follows a name / type-args (not a union member)
    const m = /^[\w$.]+(?:<[^()]*?>)?\(/.exec(body);
    if (m) {
        const open = m[0].length - 1;
        const close = matching(body, open);
        if (close > open + 1) {
            const params = splitTop(body.slice(open + 1, close), ", ").map((p) => "    " + p.trim());
            return prefix + body.slice(0, open + 1) + "\n" + params.join(",\n") + "\n" + body.slice(close);
        }
    }
    // `name: A | B | C` (properties, variables, type aliases)
    const colon = /^[\w$.]+\??(: | = )/.exec(body);
    if (colon) {
        const rest = body.slice(colon[0].length);
        const wrapped = wrapUnion(rest, width - prefix.length - colon[0].length, "", true);
        return prefix + (wrapped === rest ? colon[0] : colon[0].trimEnd()) + wrapped;
    }
    return sig;
}

function wrapUnion(text: string, width: number, indent: string, leading = false): string {
    if (text.length <= width) return text;
    const parts = splitTop(text, " | ");
    if (parts.length < 2) return text;
    return (leading ? "\n" + indent + "    | " : "") + parts.join("\n" + indent + "    | ");
}

/** documentation + tags as markdown, tags separated by blank lines */
export function docsToMarkdown(
    documentation: SymbolPart[] | undefined,
    tags: TagInfo[] | undefined,
    skip: (t: TagInfo) => boolean = () => false,
    resolve?: LinkResolver
): string {
    const doc = partsToMarkdown(documentation, resolve).trim();
    const rendered = (tags ?? [])
        .filter((t) => !skip(t))
        .map((t) => tagToMarkdown(t, resolve))
        .filter((t): t is string => !!t);
    return [doc, ...rendered].filter(Boolean).join("\n\n");
}

export const signatureBlock = (sig: string): string => "```typescript\n" + formatSignature(sig) + "\n```";

/**
 * [signature block, documentation + tags] — empty sections dropped.
 * `links` (markdown) goes right under the signature; `resolve` links {@link}s.
 */
export function quickInfoToMarkdown(info: QuickInfoLike, opts: { links?: string; resolve?: LinkResolver } = {}): string[] {
    const out: string[] = [];
    const sig = partsToMarkdown(info.displayParts);
    if (sig) out.push(signatureBlock(sig) + (opts.links ? "\n\n" + opts.links : ""));
    else if (opts.links) out.push(opts.links);
    const body = docsToMarkdown(info.documentation, info.tags, undefined, opts.resolve);
    if (body) out.push(body);
    return out;
}
