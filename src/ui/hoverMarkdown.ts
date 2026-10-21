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
}
export interface TagInfo {
    name: string;
    text?: SymbolPart[] | string;
}
export interface QuickInfoLike {
    displayParts?: SymbolPart[];
    documentation?: SymbolPart[];
    tags?: TagInfo[];
}

/** plain text of display parts; {@link X} / {@link X | label} → `X` / label */
export function partsToMarkdown(parts: SymbolPart[] | string | undefined): string {
    if (!parts) return "";
    if (typeof parts === "string") return parts;
    let out = "";
    let link: { name: string; text: string } | null = null;
    let afterLink = false;
    for (const p of parts) {
        // TS swallows the line break after a closing `}` of {@link}
        if (afterLink && p.kind !== "link" && /^\w/.test(p.text)) out += " ";
        afterLink = false;
        if (p.kind === "link") {
            if (link) {
                out += link.text.trim() || "`" + link.name + "`";
                link = null;
                afterLink = true;
            } else link = { name: "", text: "" };
        } else if (link && p.kind === "linkName") link.name += p.text;
        else if (link && p.kind === "linkText") link.text += p.text;
        else out += p.text;
    }
    return out;
}

const codeBlock = (text: string): string => (/^\s*[~`]{3}/m.test(text) ? text : "```typescript\n" + text.replace(/^\n+|\s+$/g, "") + "\n```");

function tagBody(tag: TagInfo): string {
    const text = partsToMarkdown(tag.text);
    if (!text) return "";
    if (tag.name === "example") {
        const cap = /^<caption>(.*?)<\/caption>\s*\r?\n/.exec(text);
        return cap ? cap[1] + "\n" + codeBlock(text.slice(cap[0].length)) : codeBlock(text);
    }
    if (tag.name === "default") return codeBlock(text);
    return text;
}

function tagToMarkdown(tag: TagInfo): string | null {
    if ((tag.name === "param" || tag.name === "template") && Array.isArray(tag.text)) {
        const i = tag.text.findIndex((p) => p.kind === "parameterName" || p.kind === "typeParameterName");
        if (i >= 0) {
            const doc = partsToMarkdown(tag.text.slice(i + 1)).trim();
            const label = `*@${tag.name}* \`${tag.text[i].text}\``;
            return doc ? `${label} — ${doc}` : label;
        }
    }
    if ((tag.name === "returns" || tag.name === "return") && !partsToMarkdown(tag.text)) return null;
    const label = `*@${tag.name}*`;
    const body = tagBody(tag);
    if (!body) return label;
    return label + (/\n/.test(body) ? "  \n" + body : ` — ${body}`);
}

/** [signature block, documentation + tags] — empty sections dropped */
export function quickInfoToMarkdown(info: QuickInfoLike): string[] {
    const out: string[] = [];
    const sig = partsToMarkdown(info.displayParts);
    if (sig) out.push("```typescript\n" + sig + "\n```");
    const doc = partsToMarkdown(info.documentation).trim();
    const tags = (info.tags ?? []).map(tagToMarkdown).filter((t): t is string => !!t);
    const body = [doc, ...tags].filter(Boolean).join("\n\n");
    if (body) out.push(body);
    return out;
}
