/**
 * Clickable `wt` API types in hovers: which declared types a TS signature
 * mentions, where they live in wt-api.d.ts, and the command links that
 * open them read-only in the Code view.
 */

import type { SymbolPart } from "./hoverMarkdown";

export const API_TYPINGS_URI = "file:///wt-api.d.ts";
export const OPEN_API_COMMAND = "wt.openApiDeclaration";

export interface Span {
    start: number;
    length: number;
}

const TYPE_PART_KINDS = new Set(["interfaceName", "aliasName", "className", "enumName"]);

/**
 * Distinct type names a signature's display parts mention, in order, with
 * their namespace qualifier (`Wiretrick.Route`, `URLPattern`).
 */
export function referencedTypeNames(parts: SymbolPart[] | undefined): string[] {
    const out: string[] = [];
    (parts ?? []).forEach((p, i) => {
        if (!TYPE_PART_KINDS.has(p.kind)) return;
        let name = p.text;
        for (let j = i - 1; j >= 1 && parts![j].text === "." && parts![j - 1].kind === "moduleName"; j -= 2) name = parts![j - 1].text + "." + name;
        if (!out.includes(name)) out.push(name);
    });
    return out;
}

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

const escapeLabel = (s: string): string => s.replace(/[\\[\]*_`<>]/g, "\\$&");

export interface ApiLink {
    label: string;
    title: string;
    span: Span;
}

export function apiLinkMarkdown(link: ApiLink): string {
    return `[${escapeLabel(link.label)}](${commandUri(OPEN_API_COMMAND, link.span)} "${link.title.replace(/"/g, "'")}")`;
}

/** "Go to definition · Types: Route, RequestCtx" — empty when there's nothing to link */
export function apiLinksMarkdown(definition: Span | null, types: ApiLink[]): string {
    const out: string[] = [];
    if (definition) out.push(apiLinkMarkdown({ label: "Go to definition", title: "Open the declaration in wt-api.d.ts", span: definition }));
    if (types.length) out.push("Types: " + types.map(apiLinkMarkdown).join(", "));
    return out.join(" · ");
}

/** the type links for a signature (the hovered symbol's own declaration excluded) */
export function typeLinks(parts: SymbolPart[] | undefined, index: Map<string, Span>, inTypings: boolean, definition: Span | null = null): ApiLink[] {
    const out: ApiLink[] = [];
    for (const name of referencedTypeNames(parts)) {
        const span = resolveTypeName(index, name, inTypings);
        if (!span || (definition && span.start === definition.start) || out.some((l) => l.span.start === span.start)) continue;
        out.push({ label: name.slice(name.lastIndexOf(".") + 1), title: `${name} — open in wt-api.d.ts`, span });
    }
    return out;
}
