/**
 * Text or binary? The one check every body-reading strategy uses to decide
 * whether an onResponseBody handler gets a string, a Uint8Array (routes
 * with `binary: true` only) or nothing.
 *
 * Patterns are globs over the lowercased MIME essence (Content-Type before
 * `;`); `*` matches any run of characters, `/` included. settings.textTypes
 * replaces DEFAULT_TEXT_TYPES. helper/src/proxy.rs mirrors this — keep the
 * two in sync.
 */

export const DEFAULT_TEXT_TYPES: readonly string[] = [
    "text/*", "*json", "*xml", "*javascript", "*ecmascript", "*mpegurl", "*yaml", "*toml", "*graphql", "*/x-www-form-urlencoded",
];

export type BodyKind = "text" | "binary" | "unknown";

/** lowercased MIME essence: "Text/HTML; charset=utf-8" → "text/html" */
export function mimeEssence(contentType: string | null | undefined): string {
    return (contentType || "").split(";")[0].trim().toLowerCase();
}

/** `*` glob, whole-string match */
export function globMatch(pattern: string, input: string): boolean {
    const parts = pattern.toLowerCase().split("*");
    if (parts.length === 1) return parts[0] === input;
    if (!input.startsWith(parts[0])) return false;
    let at = parts[0].length;
    for (let i = 1; i < parts.length - 1; i++) {
        const j = input.indexOf(parts[i], at);
        if (j < 0) return false;
        at = j + parts[i].length;
    }
    const last = parts[parts.length - 1];
    return input.length - last.length >= at && input.endsWith(last);
}

export function isTextType(contentType: string | null | undefined, patterns: readonly string[] = textTypes): boolean {
    const m = mimeEssence(contentType);
    return !!m && patterns.some((p) => globMatch(p, m));
}

/** no Content-Type: a NUL byte in the first 512 bytes means binary */
export function sniffBinary(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 512);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
}

/** the Content-Type is trusted when present; bytes are sniffed only without one */
export function bodyKind(contentType: string | null | undefined, bytes: Uint8Array | null, patterns: readonly string[] = textTypes): BodyKind {
    if (mimeEssence(contentType)) return isTextType(contentType, patterns) ? "text" : "binary";
    if (!bytes) return "unknown";
    return sniffBinary(bytes) ? "binary" : "text";
}

let textTypes: readonly string[] = DEFAULT_TEXT_TYPES;

/** settings.textTypes (background: set on every reload); null/empty → defaults */
export function setTextTypes(p: readonly string[] | null | undefined): void {
    textTypes = Array.isArray(p) && p.length ? p.filter((x) => typeof x === "string" && x) : DEFAULT_TEXT_TYPES;
}

export function getTextTypes(): readonly string[] {
    return textTypes;
}
