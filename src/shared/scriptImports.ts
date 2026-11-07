/**
 * Import resolution, shared by the compilers, the page hook, dependency
 * tracking and the Editor. Like TypeScript, a specifier resolves relative
 * to the importing script's folder (`./x`, `../lib/x`); a bare one
 * (`utils`) resolves from the root. A specifier ending in `.json` or `.svg`
 * names a data file (its path, case-insensitive); anything else a script: the path
 * with an optional `.ts`/`.js`, matched case-insensitively against script
 * names (paths), else (as TypeScript) the .tsx script of that path (`./Panel` and `./Panel.tsx` find "Panel.tsx"). A URL (`https://unpkg.com/x@1.2.3`)
 * is a package import (shared/packageImports), never a script path.
 */
import { builtinSpec, jsxImportSource, usesJsx } from "./builtinSpecs";
import { isUrlSpec, makePackageLoader, PACKAGE_ORIGIN, parsePackageUrl, type PackageModule, type PackageModules } from "./packageImports";

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

/** import specifiers in code, as written (plus the JSX runtime a file with JSX imports when compiled) */
export function importSpecs(code: string): Set<string> {
    const out = new Set<string>();
    for (const m of code.matchAll(IMPORT_RE)) out.add(m[1]);
    if (usesJsx(code)) out.add(`${jsxImportSource(code)}/jsx-runtime`);
    return out;
}

/** a URL import that can't load: where its specifier is (inside the quotes) and why */
export interface BadPackageImport {
    offset: number;
    length: number;
    spec: string;
    message: string;
    /** unpkg package and requested range/tag ("latest" when none) when pinning the version fixes it */
    pin?: { name: string; range: string; sub: string };
}

/** URL imports in code that can't load (unpinned, not unpkg, …) */
export function badPackageImports(code: string): BadPackageImport[] {
    const out: BadPackageImport[] = [];
    for (const m of code.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (!isUrlSpec(spec) || builtinSpec(spec)) continue;
        const message = parsePackageUrl(spec);
        if (typeof message !== "string") continue;
        const offset = m.index! + m[0].length - 1 - spec.length;
        const p = spec.startsWith(PACKAGE_ORIGIN) && !/[?#]/.test(spec) ? /^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]*))?(?:\/(.*))?$/.exec(spec.slice(PACKAGE_ORIGIN.length)) : null;
        const pin = p && message.includes("pin an exact version") ? { name: p[1], range: p[2] || "latest", sub: p[3] ?? "" } : undefined;
        out.push({ offset, length: spec.length, spec, message, pin });
    }
    return out;
}

/** code with each import specifier replaced by what `to` returns for it (undefined: kept) */
export function rewriteImports(code: string, to: (spec: string) => string | undefined): string {
    return code.replace(IMPORT_RE, (m, spec: string) => {
        const next = to(spec);
        return next === undefined ? m : m.slice(0, m.length - spec.length - 1) + next + m.slice(-1);
    });
}

/** 1-based line of the first import of `spec` in code */
export function importLine(code: string, spec: string): number | undefined {
    for (const m of code.matchAll(IMPORT_RE)) if (m[1] === spec) return code.slice(0, m.index).split("\n").length;
    return undefined;
}

/** does the specifier (or path) name a data file (`.json`, or `.svg`)? */
export function isDataSpec(spec: string): boolean {
    return /\.(json|svg)$/i.test(spec);
}

/** an `.svg` data file: importing it gives its markup, a string */
export function isSvgPath(path: string): boolean {
    return /\.svg$/i.test(path);
}

/** what importing a data file gives: an `.svg`'s markup, a `.json`'s parsed value */
export function dataFileValue(path: string, text: string): any {
    return isSvgPath(path) ? text : JSON.parse(text);
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

export type ResolvedImport = { kind: "script"; name: string } | { kind: "data"; path: string };

/**
 * Resolver over these script names and data file paths: what `spec`,
 * imported by the script named `importer`, refers to (the stored name /
 * path), or undefined. The first script with a matching key wins.
 */
export function importResolver(scriptNames: Iterable<string>, dataPaths: Iterable<string> = []): (importer: string, spec: string) => ResolvedImport | undefined {
    const scripts = new Map<string, string>();
    for (const n of scriptNames) if (!scripts.has(n.toLowerCase())) scripts.set(n.toLowerCase(), n);
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
        const key = path.replace(/\.(ts|js)$/, "").toLowerCase();
        const name = scripts.get(key) ?? (/\.tsx$/.test(key) ? undefined : scripts.get(key + ".tsx"));
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

/** what page-world code gets for a built-in import: the module graph still loads, using it throws */
function pageBuiltin(spec: string): any {
    const fail = (): never => {
        throw new Error(`cannot use "${spec}": the built-in modules aren't available in onSite code — use them in onPage or onOverlay code`);
    };
    return new Proxy(Object.create(null), {
        // the CommonJS interop reads __esModule at import; anything else is a use
        get: (_t, p) => (p === "__esModule" ? true : p === "then" || typeof p === "symbol" ? undefined : fail()),
        set: fail,
        has: () => false,
        ownKeys: () => [],
        apply: fail,
    });
}

export interface LibRequireOptions {
    /** a built-in import (`react`, `valtio`…) from `importer` (default: a module that throws when used) */
    builtin?: (spec: string, importer: string, loadUrl: (url: string) => any) => any;
    /** a `.css` package import's text (the overlay adds a <style>; default: ignored) */
    style?: (css: string, url: string) => void;
}

/**
 * Page-side `require` over the shipped libraries, data files and package
 * modules (hook, bridge and overlay): `requireFrom(importer)` resolves like
 * the background does. Libraries and package modules run once (`run`);
 * data files parse fresh per import.
 */
export function makeLibRequire<L extends ShippedLib>(libs: L[], run: (lib: L, require: (spec: string) => any, module: { exports: any }) => void, opts: LibRequireOptions = {}): (importer: string) => (spec: string) => any {
    const pkgs: PackageModules = { aliases: {}, modules: {} };
    for (const l of libs) {
        if (l.pkg) pkgs.modules[l.name] = l.pkg;
        else if (l.alias !== undefined) pkgs.aliases[l.name] = l.alias;
    }
    const builtin = opts.builtin;
    // a downloaded package's own `require("react")` gets the built-in too (one React copy), unless it's React itself
    const loadPackage = makePackageLoader(
        pkgs,
        builtin ? (spec, from) => (builtinSpec(spec) && !/^https:\/\/unpkg\.com\/(react|react-dom|scheduler|valtio)@/.test(from) ? { module: builtin(spec, from, (u) => loadPackage(u)) } : undefined) : undefined,
        { style: opts.style }
    );
    const scriptLibs = libs.filter((l) => !l.pkg && l.alias === undefined);
    const resolve = importResolver(
        scriptLibs.filter((l) => l.json === undefined).map((l) => l.name),
        scriptLibs.filter((l) => l.json !== undefined).map((l) => l.name)
    );
    const modules = new Map<string, any>();
    const requireFrom =
        (importer: string) =>
        (spec: string): any => {
            const r = isUrlSpec(spec) ? null : resolve(importer, spec);
            if (!r && builtinSpec(spec)) return builtin ? builtin(spec, importer, loadPackage) : pageBuiltin(spec);
            if (isUrlSpec(spec)) return loadPackage(spec);
            if (!r) throw new Error(`cannot import "${spec}" — is the ${isDataSpec(spec) ? "data file" : "library script"} saved?`);
            if (r.kind === "data") return dataFileValue(r.path, scriptLibs.find((l) => l.json !== undefined && l.name === r.path)!.json!);
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
