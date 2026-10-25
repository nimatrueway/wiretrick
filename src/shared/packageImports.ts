/**
 * Package imports: a script imports an npm package straight from unpkg by
 * its pinned URL (`import dayjs from "https://unpkg.com/dayjs@1.11.13"`).
 * The background downloads the package's module graph (and its typings) at
 * save time and stores it; this module holds the pure parts shared by the
 * background, the sandbox, the page hook and the Editor: URL validation,
 * nested specifier rules, typings paths and the runtime loader.
 */

export const PACKAGE_ORIGIN = "https://unpkg.com/";
/** where package typings live: Monaco's `file:///<root>/…` and the synced folder's `<root>/…` */
export const TYPINGS_ROOT = ".wiretrick/types";
/** tsconfig `paths` mapping package URLs onto the typings mirror (`target` is the typings root, no trailing slash) */
export function packagePaths(target: string): Record<string, string[]> {
    return { [`${PACKAGE_ORIGIN}*`]: [`${target}/unpkg.com/*`] };
}

/** a validated package URL: `https://unpkg.com/<name>@<version>[/<sub>]` */
export interface PackageUrl {
    name: string;
    version: string;
    /** path inside the package, "" for the package itself */
    sub: string;
}

/** a downloaded module: CommonJS code plus where each of its `require` specifiers goes */
export interface PackageModule {
    js: string;
    /** spec → final URL of the module, or "!" + why it can't be required */
    requires: Record<string, string>;
}

/** the downloaded package modules as the compilers and the page hook see them */
export interface PackageModules {
    /** requested URL → final (redirected) URL */
    aliases: Record<string, string>;
    /** final URL → module */
    modules: Record<string, PackageModule>;
    /** requested URL a script imports → why its download failed */
    failed?: Record<string, string>;
}

export const PACKAGE_MODULES_KEY = "resPackageModules";
export const PACKAGE_TYPINGS_KEY = "resPackageTypings";

/** stored package typings */
export interface StoredTypings {
    /** path under the typings root → text */
    files: Record<string, string>;
    /** package URL a script imports → the paths it needs */
    tops: Record<string, string[]>;
}

const NAME = "[a-z0-9~-][a-z0-9._~-]*";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** is the specifier a URL (any scheme://)? URL specifiers are package imports, never script paths */
export function isUrlSpec(spec: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
}

/** parse a package URL, or say why it can't be imported (the message starts with `cannot import "<spec>"`) */
export function parsePackageUrl(spec: string): PackageUrl | string {
    const fail = (why: string) => `cannot import "${spec}": ${why}`;
    if (!spec.startsWith(PACKAGE_ORIGIN)) return fail(`only pinned ${PACKAGE_ORIGIN}<package>@<version> URLs can be imported`);
    if (/[?#]/.test(spec)) return fail("package URLs can't have a query string or hash");
    const m = new RegExp(`^((?:@${NAME}/)?${NAME})(?:@([^/]*))?(?:/(.*))?$`, "i").exec(spec.slice(PACKAGE_ORIGIN.length));
    if (!m) return fail(`not a package URL — expected ${PACKAGE_ORIGIN}<package>@<version>[/<path>]`);
    const [, name, version, sub = ""] = m;
    if (!version || !SEMVER.test(version)) {
        const rest = sub ? `/${sub}` : "";
        return fail(`pin an exact version, e.g. ${PACKAGE_ORIGIN}${name}@1.2.3${rest} (ranges and tags like "latest" can change under the script)`);
    }
    if (sub && sub.split("/").some((seg) => !seg || seg === "." || seg === "..")) return fail("the path inside the package isn't normalized");
    return { name, version, sub };
}

/** `https://unpkg.com/<name>@<version>` of a package URL */
export function packageRoot(p: { name: string; version: string }): string {
    return `${PACKAGE_ORIGIN}${p.name}@${p.version}`;
}

const BUILTINS = new Set(
    "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(
        " "
    )
);

/** is `spec` a Node.js built-in module (`fs`, `fs/promises`, `node:path`)? */
export function isNodeBuiltin(spec: string): boolean {
    return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]);
}

export function builtinMessage(spec: string): string {
    return `"${spec}" is a Node.js built-in — not available in Wiretrick scripts`;
}

/** a bare specifier's package name and path inside it (`@s/x/a/b` → `@s/x`, `a/b`) */
export function splitBare(spec: string): { name: string; sub: string } {
    const parts = spec.split("/");
    const n = spec.startsWith("@") ? 2 : 1;
    return { name: parts.slice(0, n).join("/"), sub: parts.slice(n).join("/") };
}

/**
 * Where a library module's `require(spec)` goes, before package.json
 * lookups: a URL (relative ones against the module's final URL), a bare
 * package (resolved by the caller from the importing package's
 * dependencies), or an error.
 */
export function classifyNested(spec: string, from: string): { url: string } | { bare: string; sub: string } | { error: string } {
    if (/^\.\.?(\/|$)/.test(spec)) return { url: new URL(spec, from).href };
    if (isUrlSpec(spec) || spec.startsWith("/")) {
        const url = spec.startsWith("/") ? new URL(spec, PACKAGE_ORIGIN).href : spec;
        return url.startsWith(PACKAGE_ORIGIN) ? { url } : { error: `cannot import "${spec}": only ${PACKAGE_ORIGIN} modules can be imported` };
    }
    if (!new RegExp(`^(?:@${NAME}/)?${NAME}(?:/.*)?$`, "i").test(spec)) return { error: `cannot import "${spec}": not a package name` };
    const { name, sub } = splitBare(spec);
    return { bare: name, sub };
}

/** `https://unpkg.com/<name>@<range>[/sub]` for a dependency range; null for non-registry ranges (`npm:`, git, `file:`, …) */
export function rangeUrl(name: string, range: string | undefined, sub: string): string | null {
    const r = (range ?? "").trim() || "latest";
    if (/[:/]/.test(r) || /^[\w.-]+\/[\w.-]+/.test(r)) return null;
    return `${PACKAGE_ORIGIN}${name}@${encodeURIComponent(r === "*" ? "latest" : r)}${sub ? `/${sub}` : ""}`;
}

/** a package.json's range for dependency `dep` (dependencies, peer, optional) */
export function dependencyRange(pkg: any, dep: string): string | undefined {
    for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const r = pkg?.[k]?.[dep];
        if (typeof r === "string") return r;
    }
    return undefined;
}

/** does the (CommonJS or ES module) code use ES module syntax? */
export function isEsModule(code: string): boolean {
    return /(?:^|[;})\]]|\*\/)[ \t]*(?:import[ \t]*(?:[\w$*{]|["'])|export[ \t]*(?:[\w$*{]))/m.test(code);
}

/** the string specifiers CommonJS code `require`s */
export function requireSpecs(js: string): string[] {
    const out = new Set<string>();
    for (const m of js.matchAll(/(?<![.\w$])require\s*\(\s*(["'])([^"'\n\\]+)\1\s*\)/g)) out.add(m[2]);
    return [...out];
}

/** references in a declaration file: module specifiers, `/// <reference path>`s (file-relative) and `/// <reference types>`s */
export function declarationRefs(text: string): { specs: string[]; paths: string[]; types: string[] } {
    const specs = new Set<string>();
    const paths = new Set<string>();
    const types = new Set<string>();
    for (const m of text.matchAll(/\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']/g)) (m[1] === "path" ? paths : types).add(m[2]);
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bdeclare\s+module\s+)(["'])([^"'\n]+)\1/g;
    for (const m of code.matchAll(re)) {
        // `declare module "x"` declares x (ambient); only a relative one augments another file
        if (/declare\s+module\s+$/.test(m[0].slice(0, -m[2].length - 2)) && !/^\.\.?\//.test(m[2])) continue;
        specs.add(m[2]);
    }
    return { specs: [...specs], paths: [...paths], types: [...types] };
}

/** conditions TypeScript's bundler resolution matches for an import */
const TS_CONDITIONS = new Set(["types", "import", "default"]);

/**
 * The `types` a package.json `exports` entry gives an import: conditions
 * in order, nested ones too, as TypeScript matches them; else the first
 * `types` under any condition (e.g. `require` only).
 */
function exportsTypes(v: any): string | undefined {
    return exportsTypesWith(v, (k) => TS_CONDITIONS.has(k)) ?? exportsTypesWith(v, () => true);
}

function exportsTypesWith(v: any, accept: (condition: string) => boolean): string | undefined {
    if (typeof v === "string") return /\.d\.[mc]?ts$/.test(v) ? v : undefined;
    if (Array.isArray(v)) {
        for (const x of v) {
            const t = exportsTypesWith(x, accept);
            if (t) return t;
        }
        return undefined;
    }
    if (!v || typeof v !== "object") return undefined;
    if (typeof v.types === "string") return v.types;
    for (const [k, x] of Object.entries(v)) {
        if (k === "types" || !accept(k)) continue;
        const t = exportsTypesWith(x, accept);
        if (t) return t;
    }
    return undefined;
}

/** the `exports` entry for subpath `"."` / `"./sub"` (exact keys, then one-`*` patterns) */
function exportsEntry(exp: any, key: string): any {
    if (exp === undefined || exp === null) return undefined;
    const isMap = typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
    if (!isMap) return key === "." ? exp : undefined;
    if (key in exp) return exp[key];
    for (const [k, v] of Object.entries(exp)) {
        const star = k.indexOf("*");
        if (star < 0) continue;
        const [pre, post] = [k.slice(0, star), k.slice(star + 1)];
        if (!key.startsWith(pre) || !key.endsWith(post) || key.length < pre.length + post.length) continue;
        const hit = key.slice(pre.length, key.length - post.length);
        return JSON.parse(JSON.stringify(v).split("*").join(hit));
    }
    return undefined;
}

function clean(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

function swapJs(p: string): string[] {
    const m = /\.([mc]?)js$/.exec(p);
    return m ? [p.slice(0, -m[0].length) + `.d.${m[1]}ts`] : [];
}

/** candidate declaration files (paths inside the package, in order) for a package URL's `sub` per its package.json */
export function typesCandidates(pkg: any, sub: string): string[] {
    const out: string[] = [];
    const add = (p: string | undefined) => {
        if (typeof p === "string" && p && !out.includes(clean(p))) out.push(clean(p));
    };
    if (!sub) {
        add(pkg?.types);
        add(pkg?.typings);
        add(exportsTypes(exportsEntry(pkg?.exports, ".")));
        if (typeof pkg?.main === "string") {
            const main = clean(pkg.main);
            for (const p of /\.d\.[mc]?ts$/.test(main) ? [main] : swapJs(main).length ? swapJs(main) : [`${main}.d.ts`, `${main}/index.d.ts`]) add(p);
        }
        add("index.d.ts");
        return out;
    }
    const bareSub = sub.replace(/\.[mc]?js$/, "");
    add(exportsTypes(exportsEntry(pkg?.exports, `./${sub}`)));
    if (bareSub !== sub) add(exportsTypes(exportsEntry(pkg?.exports, `./${bareSub}`)));
    if (/\.d\.[mc]?ts$/.test(sub)) add(sub);
    for (const p of swapJs(sub)) add(p);
    add(`${sub}.d.ts`);
    add(`${sub}/index.d.ts`);
    add(`${bareSub}.d.mts`);
    add(`${bareSub}.d.cts`);
    return out;
}

/** declaration files TypeScript would look for at `path` (a file's relative import, joined) */
export function declarationCandidates(path: string): string[] {
    if (/\.d\.[mc]?ts$/.test(path)) return [path];
    const swapped = swapJs(path);
    if (swapped.length) return swapped;
    if (/\.json$/.test(path)) return [];
    return [`${path}.d.ts`, `${path}/index.d.ts`, `${path}.d.mts`, `${path}.d.cts`];
}

/** the declaration file TypeScript finds by itself for `sub` (no package.json pointer needed), or undefined for a package root */
export function naturalDeclaration(sub: string): string[] {
    if (!sub) return [];
    if (/\.d\.[mc]?ts$/.test(sub)) return [sub];
    const swapped = swapJs(sub);
    if (swapped.length) return swapped;
    return [`${sub}.d.ts`, `${sub}/index.d.ts`];
}

/** the declaration stub for a module without typings (`any`) */
export function typingsStub(spec: string): string {
    return `// Wiretrick found no TypeScript declarations for ${spec}\ndeclare const mod: any;\nexport = mod;\n`;
}

/** where a stub for `sub` goes (inside the package folder) */
export function stubPath(sub: string): string {
    if (!sub) return "index.d.ts";
    if (/\.json$/.test(sub)) return sub.replace(/\.json$/, ".d.json.ts");
    return swapJs(sub)[0] ?? `${sub}.d.ts`;
}

/** `@types` package name for a package (`@s/x` → `@types/s__x`) */
export function typesPackageName(name: string): string {
    return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

/** normalize a `/`-separated path (".", ".." segments) */
export function normalizePath(path: string): string {
    const out: string[] = [];
    for (const seg of path.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
    }
    return out.join("/");
}

/** relative path from folder `from` to `to` (both root-relative), starting with `./` or `../` */
export function relativePath(from: string, to: string): string {
    const a = from.split("/").filter(Boolean);
    const b = to.split("/").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const up = a.length - i;
    return (up ? "../".repeat(up) : "./") + b.slice(i).join("/");
}

/**
 * An import of a package URL failed (bad URL, download failure, the
 * library threw while loading). Never stubbed: the importer fails to
 * compile, positioned at its import line — like a data file error.
 */
export class PackageImportError extends Error {
    fatalImport = true;
}

/** requested or final URL → the module's final URL */
export function finalUrl(pkgs: PackageModules | undefined, url: string): string | undefined {
    if (!pkgs) return undefined;
    return pkgs.aliases[url] ?? (pkgs.modules[url] ? url : undefined);
}

/** final URLs of the modules a package URL loads (itself and its requires, transitively) */
export function packageClosure(pkgs: PackageModules, urls: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const queue = [...urls].map((u) => finalUrl(pkgs, u)).filter((u): u is string => !!u);
    while (queue.length) {
        const u = queue.pop()!;
        if (out.has(u) || !pkgs.modules[u]) continue;
        out.add(u);
        for (const t of Object.values(pkgs.modules[u].requires)) if (!t.startsWith("!")) queue.push(t);
    }
    return out;
}

const PROCESS = { env: { NODE_ENV: "production" }, browser: true, versions: {}, argv: [], platform: "browser" };

/**
 * `require` of package URLs over downloaded modules. Each module runs once
 * per loader, as CommonJS like Node does (`this` = `module.exports`,
 * sloppy mode); cyclic requires get the partial exports. A library's
 * failed nested require throws a plain Error when it runs (so optional
 * `try { require("x") } catch {}` works); a script's import that can't
 * load throws a PackageImportError.
 */
export function makePackageLoader(pkgs: PackageModules | undefined): (url: string) => any {
    const cache = new Map<string, { exports: any }>();
    const run = (url: string): any => {
        const hit = cache.get(url);
        if (hit) return hit.exports;
        const mod = pkgs?.modules[url];
        if (!mod) throw new Error(`cannot import "${url}": it wasn't downloaded`);
        const module = { exports: {} as any };
        cache.set(url, module);
        const require = (spec: string): any => {
            const to = mod.requires[spec];
            if (to === undefined) throw new Error(`cannot find module "${spec}" (required by ${url})`);
            if (to.startsWith("!")) throw new Error(to.slice(1));
            return run(to);
        };
        try {
            // eslint-disable-next-line no-new-func
            const fn = new Function("require", "module", "exports", "process", "global", `${mod.js}\n//# sourceURL=${url}`);
            fn.call(module.exports, require, module, module.exports, PROCESS, globalThis);
        } catch (e) {
            cache.delete(url);
            throw e;
        }
        return module.exports;
    };
    return (spec) => {
        const p = parsePackageUrl(spec);
        if (typeof p === "string") throw new PackageImportError(p);
        const failed = pkgs?.failed?.[spec];
        if (failed !== undefined) throw new PackageImportError(`cannot import "${spec}": ${failed}`);
        const url = finalUrl(pkgs, spec);
        if (!url) throw new PackageImportError(`cannot import "${spec}": not downloaded yet — save the script to download it`);
        try {
            return run(url);
        } catch (e: any) {
            if (e instanceof PackageImportError) throw e;
            throw new PackageImportError(`cannot import "${spec}": ${e?.message ?? e}`);
        }
    };
}
