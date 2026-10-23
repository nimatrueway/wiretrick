/**
 * Data files for the Code view's TypeScript: each one is declared as a
 * module next to it (`mock/rate-limits.json` → `mock/rate-limits.d.json.ts`,
 * which TypeScript looks up for `import … from "./mock/rate-limits.json"`),
 * typed like TypeScript types a JSON module. Pure, so it's unit-tested.
 */

/** bigger JSON is typed `any` (a type that size helps nobody and slows the TS worker) */
const MAX_TYPED = 256 * 1024;

/** the TypeScript type of a parsed JSON value (widened, like a JSON module's) */
export function jsonType(value: unknown, indent = ""): string {
    if (value === null) return "null";
    if (Array.isArray(value)) {
        const items = [...new Set(value.map((v) => jsonType(v, indent)))];
        if (!items.length) return "any[]";
        return items.length === 1 && !items[0].includes("|") ? `${items[0]}[]` : `(${items.join(" | ")})[]`;
    }
    if (typeof value === "object") {
        const inner = indent + "    ";
        const props = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${jsonType(v, inner)};`);
        return props.length ? `{\n${props.join("\n")}\n${indent}}` : "{}";
    }
    return typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "any";
}

/** the declaration of a data file's module; text that isn't valid JSON (yet) is `any` */
export function jsonModuleDts(text: string): string {
    let type = "any";
    if (text.length <= MAX_TYPED) {
        try {
            type = jsonType(JSON.parse(text));
        } catch {
            /* a JSON syntax error is the data file's problem, not its importers' */
        }
    }
    return `declare const data: ${type};\nexport = data;\n`;
}

/** `mock/rate-limits.json` → `mock/rate-limits.d.json.ts` */
export function jsonDeclPath(path: string): string {
    return path.replace(/\.json$/i, "") + ".d.json.ts";
}

/** the data file path a declaration (file:///…/x.d.json.ts, maybe %-encoded) is for, or null */
export function dataPathOfDecl(uri: string): string | null {
    const m = /^file:\/\/\/(.+)\.d\.json\.ts$/.exec(uri);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]) + ".json";
    } catch {
        return m[1] + ".json";
    }
}

/** a JSON import TypeScript can't find (no such data file) is the importer's compile error, not a type error */
export const JSON_FALLBACK_DTS = 'declare module "*.json" {\n    const data: any;\n    export = data;\n}\n';
