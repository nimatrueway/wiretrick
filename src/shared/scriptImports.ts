/**
 * Import resolution, shared by the compilers, the page hook, dependency
 * tracking and the Editor. Like TypeScript, a specifier resolves relative
 * to the importing script's folder (`./x`, `../lib/x`); a bare one
 * (`utils`) resolves from the root. A specifier ending in `.json` names a
 * data file (its path, case-insensitive); anything else a script: the path
 * with an optional `.ts`/`.js`, matched case-insensitively against script
 * names (paths) or their legacy key (each segment's other characters → `_`,
 * so `./My_Utils` finds "My Utils"). A URL (`https://unpkg.com/x@1.2.3`)
 * is a package import (shared/packageImports), never a script path.
 */
import { isUrlSpec, makePackageLoader, type PackageModule, type PackageModules } from "./packageImports";

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

function specKey(spec: string): string {
    return spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "").toLowerCase();
}

/** normalized import specifiers in code */
export function importKeys(code: string): Set<string> {
    const out = new Set<string>();
    for (const m of code.matchAll(IMPORT_RE)) out.add(specKey(m[1]));
    return out;
}

/** import specifiers in code, as written */
export function importSpecs(code: string): Set<string> {
    const out = new Set<string>();
    for (const m of code.matchAll(IMPORT_RE)) out.add(m[1]);
    return out;
}

/** 1-based line of the first import of `spec` in code */
export function importLine(code: string, spec: string): number | undefined {
    for (const m of code.matchAll(IMPORT_RE)) if (m[1] === spec) return code.slice(0, m.index).split("\n").length;
    return undefined;
}

/** does the specifier (or path) name a data file? */
export function isDataSpec(spec: string): boolean {
    return /\.json$/i.test(spec);
}

/** folder part of a path ("" at the root) */
export function folderOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
}

/** the path `spec` points at from the script named `importer`; null when it climbs above the root */
export function importPath(importer: string, spec: string): string | null {
    const out = /^\.\.?(\/|$)/.test(spec) ? folderOf(importer).split("/").filter(Boolean) : [];
    for (const seg of spec.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg !== "..") out.push(seg);
        else if (!out.pop()) return null;
    }
    return out.length ? out.join("/") : null;
}

function legacyKey(path: string): string {
    return path
        .split("/")
        .map((seg) => seg.replace(/[^a-zA-Z0-9_-]+/g, "_"))
        .join("/")
        .toLowerCase();
}

export type ResolvedImport = { kind: "script"; name: string } | { kind: "data"; path: string };

/**
 * Resolver over these script names and data file paths: what `spec`,
 * imported by the script named `importer`, refers to (the stored name /
 * path), or undefined. The first script with a matching key wins.
 */
export function importResolver(scriptNames: Iterable<string>, dataPaths: Iterable<string> = []): (importer: string, spec: string) => ResolvedImport | undefined {
    const scripts = new Map<string, string>();
    for (const n of scriptNames) for (const k of [legacyKey(n), n.toLowerCase()]) if (!scripts.has(k)) scripts.set(k, n);
    const data = new Map<string, string>();
    for (const p of dataPaths) if (!data.has(p.toLowerCase())) data.set(p.toLowerCase(), p);
    return (importer, spec) => {
        if (isUrlSpec(spec)) return undefined;
        const path = importPath(importer, spec);
        if (path === null) return undefined;
        if (isDataSpec(path)) {
            const p = data.get(path.toLowerCase());
            return p === undefined ? undefined : { kind: "data", path: p };
        }
        const name = scripts.get(path.replace(/\.(ts|js)$/, "").toLowerCase());
        return name === undefined ? undefined : { kind: "script", name };
    };
}

/**
 * ids of scripts that import the script named `target` (or, kind "data",
 * the data file at that path), directly or through other scripts. The
 * target needn't exist any more (a rename's old name).
 */
export function dependantsOf<T extends { id: string; name: string; code: string }>(target: string, scripts: T[], kind: "script" | "data" = "script"): string[] {
    const names = scripts.map((s) => s.name);
    const resolve = kind === "data" ? importResolver(names, [target]) : importResolver([...names, target]);
    const specs = new Map(scripts.map((s) => [s.id, [...importSpecs(s.code)]]));
    const found = new Set<string>();
    const queue: ResolvedImport[] = [kind === "data" ? { kind, path: target } : { kind, name: target }];
    while (queue.length) {
        const t = queue.shift()!;
        for (const s of scripts) {
            if (found.has(s.id)) continue;
            const hit = specs.get(s.id)!.some((spec) => {
                const r = resolve(s.name, spec);
                return r?.kind === "data" ? t.kind === "data" && r.path.toLowerCase() === t.path.toLowerCase() : r?.kind === "script" && t.kind === "script" && r.name === t.name;
            });
            if (!hit) continue;
            found.add(s.id);
            queue.push({ kind: "script", name: s.name });
        }
    }
    return [...found];
}

/**
 * Indices of `items` that the `chosen` ones import (directly or through
 * other scripts) but that aren't chosen — libraries and data files
 * (`data: true`, `name` = path) a partial export or import would leave
 * dangling.
 */
export function missingImports<T extends { name: string; code: string; data?: boolean }>(chosen: number[], items: T[]): number[] {
    const resolve = importResolver(
        items.filter((i) => !i.data).map((i) => i.name),
        items.filter((i) => i.data).map((i) => i.name)
    );
    const index = new Map<string, number>();
    items.forEach((it, i) => {
        const k = `${it.data ? "d" : "s"}:${it.data ? it.name.toLowerCase() : it.name}`;
        if (!index.has(k)) index.set(k, i);
    });
    const picked = new Set(chosen);
    const missing = new Set<number>();
    const queue = [...chosen];
    while (queue.length) {
        const it = items[queue.shift()!];
        if (it.data) continue;
        for (const spec of importSpecs(it.code)) {
            const r = resolve(it.name, spec);
            const i = r && index.get(r.kind === "data" ? `d:${r.path.toLowerCase()}` : `s:${r.name}`);
            if (i === undefined || picked.has(i) || missing.has(i)) continue;
            missing.add(i);
            queue.push(i);
        }
    }
    return [...missing].sort((a, b) => a - b);
}

/** a library source, data file or package module shipped to the page (getHookBundle `libs`) */
export interface ShippedLib {
    name: string;
    /** a library's runnable JS */
    src?: string;
    /** a data file's text (`name` is its path) */
    json?: string;
    params?: Record<string, any>;
    /** a package module (`name` is its final URL) */
    pkg?: PackageModule;
    /** a package URL a script imports (`name`) → its module's final URL */
    alias?: string;
}

/**
 * Page-side `require` over the shipped libraries, data files and package
 * modules (hook and bridge): `requireFrom(importer)` resolves like the
 * background does. Libraries and package modules run once (`run`); data
 * files parse fresh per import.
 */
export function makeLibRequire<L extends ShippedLib>(libs: L[], run: (lib: L, require: (spec: string) => any, module: { exports: any }) => void): (importer: string) => (spec: string) => any {
    const pkgs: PackageModules = { aliases: {}, modules: {} };
    for (const l of libs) {
        if (l.pkg) pkgs.modules[l.name] = l.pkg;
        else if (l.alias !== undefined) pkgs.aliases[l.name] = l.alias;
    }
    const loadPackage = makePackageLoader(pkgs);
    const scriptLibs = libs.filter((l) => !l.pkg && l.alias === undefined);
    const resolve = importResolver(
        scriptLibs.filter((l) => l.json === undefined).map((l) => l.name),
        scriptLibs.filter((l) => l.json !== undefined).map((l) => l.name)
    );
    const modules = new Map<string, any>();
    const requireFrom =
        (importer: string) =>
        (spec: string): any => {
            if (isUrlSpec(spec)) return loadPackage(spec);
            const r = resolve(importer, spec);
            if (!r) throw new Error(`cannot import "${spec}" — is the ${isDataSpec(spec) ? "data file" : "library script"} saved?`);
            if (r.kind === "data") return JSON.parse(scriptLibs.find((l) => l.json !== undefined && l.name === r.path)!.json!);
            if (modules.has(r.name)) return modules.get(r.name);
            const lib = scriptLibs.find((l) => l.json === undefined && l.name === r.name)!;
            const moduleObj = { exports: {} as any };
            modules.set(r.name, moduleObj.exports); // early: cycle protection
            run(lib, requireFrom(lib.name), moduleObj);
            modules.set(r.name, moduleObj.exports);
            return moduleObj.exports;
        };
    return requireFrom;
}
