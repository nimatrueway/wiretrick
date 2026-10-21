/**
 * Which scripts import which: ES `import … from "./utils"` resolves to the
 * script named "utils" (same keys as makeModuleResolver in compile.ts).
 */

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

function specKey(spec: string): string {
    return spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "").toLowerCase();
}

function nameKeys(name: string): string[] {
    return [name.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase(), name.toLowerCase()];
}

/** normalized import specifiers in code */
export function importKeys(code: string): Set<string> {
    const out = new Set<string>();
    for (const m of code.matchAll(IMPORT_RE)) out.add(specKey(m[1]));
    return out;
}

/** ids of scripts that import `name`, directly or through other scripts */
export function dependantsOf<T extends { id: string; name: string; code: string }>(name: string, scripts: T[]): string[] {
    const imports = new Map(scripts.map((s) => [s.id, importKeys(s.code)]));
    const found = new Set<string>();
    const queue = [name];
    while (queue.length) {
        const keys = nameKeys(queue.shift()!);
        for (const s of scripts) {
            if (found.has(s.id) || !keys.some((k) => imports.get(s.id)!.has(k))) continue;
            found.add(s.id);
            queue.push(s.name);
        }
    }
    return [...found];
}
