/**
 * Clickable `wt` API types in hovers: which declared types a TS signature
 * mentions and where they live in wt-api.d.ts (so a hover can show theirs).
 */

import type { SymbolPart } from "./hoverMarkdown";

export const API_TYPINGS_URI = "file:///wt-api.d.ts";

export interface Span {
    start: number;
    length: number;
}

const TYPE_PART_KINDS = new Set(["interfaceName", "aliasName", "className", "enumName"]);

export interface NavTreeItem {
    text: string;
    kind: string;
    spans: Span[];
    nameSpan?: Span;
    childItems?: NavTreeItem[];
}

const TYPE_NAV_KINDS = new Set(["interface", "type", "class", "enum"]);

/** TS navigation tree of wt-api.d.ts → qualified type name → name span */
export function indexTypeDeclarations(root: NavTreeItem): Map<string, Span> {
    const map = new Map<string, Span>();
    const walk = (item: NavTreeItem, prefix: string): void => {
        for (const c of item.childItems ?? []) {
            const name = prefix + c.text;
            if (TYPE_NAV_KINDS.has(c.kind) && !map.has(name)) map.set(name, c.nameSpan ?? c.spans[0]);
            if (c.kind === "module") walk(c, name + ".");
        }
    };
    walk(root, "");
    return map;
}

/**
 * Where `name` is declared in wt-api.d.ts. Outside the typings TS always
 * qualifies namespace members (`Wiretrick.Route`); inside them it doesn't,
 * so there a bare name also matches a namespace member.
 */
export function resolveTypeName(index: Map<string, Span>, name: string, inTypings: boolean): Span | undefined {
    const exact = index.get(name);
    if (exact || !inTypings) return exact;
    for (const [key, span] of index) if (key.endsWith("." + name)) return span;
    return undefined;
}

/** `command:<id>?<args>` — the form Monaco's markdown renderer executes */
export function commandUri(command: string, args: unknown): string {
    return `command:${command}?${encodeURIComponent(JSON.stringify(args)).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
}

/** A type name inside a signature that links to its wt-api.d.ts declaration */
export interface TypeRef {
    /** offsets in the signature's plain text */
    start: number;
    end: number;
    /** qualified name (`Wiretrick.Route`) */
    name: string;
    /** the declaration's name in wt-api.d.ts */
    span: Span;
}

/**
 * Every type name in a signature that's declared in wt-api.d.ts, except the
 * hovered declaration itself (`exclude`: its name span).
 */
export function typeRefs(parts: SymbolPart[] | undefined, index: Map<string, Span>, inTypings: boolean, exclude?: Span | null): TypeRef[] {
    const out: TypeRef[] = [];
    let offset = 0;
    (parts ?? []).forEach((p, i) => {
        const start = offset;
        offset += p.text.length;
        if (!TYPE_PART_KINDS.has(p.kind)) return;
        let name = p.text;
        for (let j = i - 1; j >= 1 && parts![j].text === "." && parts![j - 1].kind === "moduleName"; j -= 2) name = parts![j - 1].text + "." + name;
        const span = resolveTypeName(index, name, inTypings);
        if (span && !(exclude && span.start === exclude.start)) out.push({ start, end: offset, name, span });
    });
    return out;
}

/** every declaration in the navigation tree (members too), depth first */
export function flattenNavTree(root: NavTreeItem): NavTreeItem[] {
    const out: NavTreeItem[] = [];
    const walk = (item: NavTreeItem): void => {
        for (const c of item.childItems ?? []) {
            out.push(c);
            walk(c);
        }
    };
    walk(root);
    return out;
}

/**
 * The name of the declaration a {@link} target (a whole declaration's span)
 * points at — where TS quick info for it has to be asked.
 */
export function declarationName(items: NavTreeItem[], target: Span): Span | undefined {
    const exact = items.find((d) => d.spans.some((s) => s.start === target.start));
    if (exact) return exact.nameSpan ?? exact.spans[0];
    let best: NavTreeItem | undefined;
    for (const d of items) {
        const s = d.spans[0];
        if (s && s.start <= target.start && target.start < s.start + s.length && (!best || s.length < best.spans[0].length)) best = d;
    }
    return best?.nameSpan;
}
