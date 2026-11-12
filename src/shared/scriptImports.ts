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
import { scriptFrame } from "./scriptError";
import { isUrlSpec, makePackageLoader, PACKAGE_ORIGIN, parsePackageUrl, type PackageModule, type PackageModules, type PackageStatus } from "./packageImports";
import type { PackageFn } from "./siteCode";

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

const isPackageUrl = (spec: string) => isUrlSpec(spec) && !builtinSpec(spec) && typeof parsePackageUrl(spec) !== "string";

/** the valid package URLs code imports */
export function packageUrls(code: string): string[] {
    return [...new Set([...code.matchAll(IMPORT_RE)].map((m) => m[1]).filter(isPackageUrl))];
}

/** an Editor marker on a URL import: why it can't load, or that it's still on its way */
export interface PackageImportMark extends BadPackageImport {
    severity: "error" | "warning";
}

/**
 * The markers of code's URL imports: the bad ones (errors), and for valid
 * ones what the background says (`statusOf`, undefined: not asked yet) —
 * a download or types still under way is a warning, not a failure.
 */
export function packageImportMarks(code: string, statusOf: (url: string) => PackageStatus | undefined): PackageImportMark[] {
    const out: PackageImportMark[] = badPackageImports(code).map((b) => ({ ...b, severity: "error" }));
    for (const m of code.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (!isPackageUrl(spec)) continue;
        const st = statusOf(spec);
        if (!st || st.state === "ready") continue;
        const offset = m.index! + m[0].length - 1 - spec.length;
        const mark = (severity: "error" | "warning", message: string) => out.push({ offset, length: spec.length, spec, severity, message });
        if (st.state === "downloading") mark("warning", `downloading "${spec}" from unpkg… (its types follow)`);
        else if (st.state === "typing") mark("warning", `fetching the types of "${spec}"…`);
        else if (st.state === "missing") mark("warning", `cannot import "${spec}": not downloaded yet — save the script to download it`);
        else if (st.state === "failed") mark("error", `cannot import "${spec}": ${st.reason}`);
        else mark("warning", `couldn't fetch the types of "${spec}" (${st.reason}) — it still runs; they're retried in a minute`);
    }
    return out.sort((a, b) => a.offset - b.offset);
}

/**
 * Is a TypeScript "Cannot find module" error about a URL import whose
 * own marker (packageImportMarks) explains it better — one that can't
 * load, or whose package (and types) are still on their way?
 */
export function coveredMissingModule(message: string, statusOf: (url: string) => PackageStatus | undefined): boolean {
    const spec = /^Cannot find module '([^']+)'/.exec(message)?.[1];
    return !!spec && isUrlSpec(spec) && !builtinSpec(spec) && statusOf(spec)?.state !== "ready";
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

const IMAGE_MIMES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    avif: "image/avif",
};

/** does the path name a raster image data file (.png, .jpg, .webp, .gif, .ico, .avif)? */
export function isImageDataPath(path: string): boolean {
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
    return !!ext && Object.prototype.hasOwnProperty.call(IMAGE_MIMES, ext);
}

/** encode binary image bytes as a canonical `data:image/...;base64,...` URL */
export function bytesToImageDataUrl(path: string, bytes: Uint8Array): string {
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "png";
    const mime = IMAGE_MIMES[ext] ?? "application/octet-stream";
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:${mime};base64,${btoa(bin)}`;
}

/** decode a `data:...;base64,...` URL back into raw bytes (for folder sync and zip export) */
export function imageDataUrlToBytes(text: string): Uint8Array {
    const m = /^data:[^,]*;base64,([\s\S]*)$/.exec(text);
    if (!m) return new TextEncoder().encode(text);
    const bin = atob(m[1].replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** encode inline SVG markup as a safe `data:image/svg+xml` URL for `<img>` */
export function svgToDataUrl(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

/** does the specifier (or path) name a data file (`.json`, `.md`, `.svg` or an image)? */
export function isDataSpec(spec: string): boolean {
    return /\.(json|svg|md|png|jpe?g|gif|webp|ico|avif)$/i.test(spec);
}

/** an `.svg` data file: importing it gives its markup, a string */
export function isSvgPath(path: string): boolean {
    return /\.svg$/i.test(path);
}

/** a `.md` data file: shown/edited as Markdown; importing it gives its text, a string */
export function isMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path);
}

/** what importing a data file gives: an `.svg`'s markup, a `.md`'s text, a raster image's `data:` URL, or a `.json`'s parsed value */
export function dataFileValue(path: string, text: string): any {
    return isSvgPath(path) || isMarkdownPath(path) || isImageDataPath(path) ? text : JSON.parse(text);
}

/** true when `icon` names a workspace/package file path rather than a `data:`/`http(s):` URL or inline `<svg>` */
export function isRelativeIconSpec(icon: string | undefined): icon is string {
    const s = icon?.trim();
    return !!s && !/^(data:|https?:\/\/|<svg[\s>])/i.test(s) && !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

/** literal `icon: "..."` inside a `tt.metadata({ ... })` call */
export function metadataIconValue(code: string): string | undefined {
    const m = /\btt\s*\.\s*metadata\s*\(\s*\{[\s\S]*?\bicon\s*:\s*(["'`])([^"'`\n]+)\1/.exec(code);
    return m ? m[2].trim() : undefined;
}

/** literal `icon: "..."` inside a `tt.metadata({ ... })` call, if relative, so package export/crawl includes the file */
export function metadataIconSpec(code: string): string | undefined {
    const v = metadataIconValue(code);
    return isRelativeIconSpec(v) ? v : undefined;
}

/**
 * Resolve a script or package `icon` (`./icon.svg`, `icon.png`, `data:image/...`,
 * `https://...`, or inline `<svg>...</svg>`) against `baseFolder` and `dataFiles`
 * into an `<img src>` URL; undefined when unset or unresolvable.
 */
export function resolveIconSrc(
    icon: string | undefined,
    baseFolder: string,
    dataFiles: readonly { path: string; text: string }[]
): string | undefined {
    const raw = icon?.trim();
    if (!raw) return undefined;
    if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
    if (/^<svg[\s>]/i.test(raw)) return svgToDataUrl(raw);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
    const relSpec = /^\.\.?(\/|$)/.test(raw) ? raw : `./${raw}`;
    const target = importPath(baseFolder ? `${baseFolder}/_` : "_", relSpec);
    const find = (p: string | null) => (p ? dataFiles.find((d) => d.path.toLowerCase() === p.toLowerCase()) : undefined);
    const hit = find(target) ?? (!/^\.\.?(\/|$)/.test(raw) && baseFolder ? find(importPath("_", `./${raw}`)) : undefined);
    if (!hit) return undefined;
    if (isSvgPath(hit.path)) return svgToDataUrl(hit.text);
    if (isImageDataPath(hit.path) || /^data:image\//i.test(hit.text)) return hit.text;
    return undefined;
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
    /** MV3 onSite: the key of a library's or package module's user-script unit (shared/siteCode.ts) */
    fk?: string;
}

/** what page-world code gets for a built-in import: the module graph still loads, using it throws */
export function pageBuiltin(spec: string): any {
    return unusable(spec, `of the built-in modules it only has valtio's core ("valtio", "valtio/vanilla") — use the others in onPage or onOverlay code`);
}

/** the script modules whose top level is running (makeLibRequire), outermost first, after the script that imported the first */
const loading: string[] = [];

/** a library module's top level is running (makeLibRequire): what it registers is its own script's, not the importer's */
export const libBodyRunning = (): boolean => loading.length > 0;

/**
 * A module stand-in: importing it works, using it throws. Used while an
 * imported module loads (`const Item = memo(…)` at its top level), the error
 * says where and through which imports, so the user can split the module.
 */
function unusable(spec: string, why: string): any {
    const fail = (): never => {
        if (loading.length < 2) throw new Error(`cannot use "${spec}" in onSite code: ${why}`);
        const at = String(new Error().stack || "")
            .split("\n")
            .map(scriptFrame)
            .find((f) => f);
        const where = at ? `${at.name}:${at.line}` : loading[loading.length - 1];
        throw new Error(`cannot use "${spec}" in onSite code: ${where} uses it at its top level, and onSite code imports it (${loading.join(" → ")}) — move what onSite code needs into a module that doesn't use "${spec}"`);
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

export interface LibRequireOptions<L extends ShippedLib = ShippedLib> {
    /** a built-in import (`react`, `valtio`…) from `importer` (default: a module that throws when used) */
    builtin?: (spec: string, importer: string, loadUrl: (url: string) => any) => any;
    /** a `.css` package import's text (the overlay adds a <style>; default: ignored) */
    style?: (css: string, url: string) => void;
    /**
     * The site's world: a package that can't load there (one needing React)
     * still imports, and using it throws, like the built-ins there. The
     * script's onPage/onOverlay code imports it too.
     */
    onSite?: boolean;
    /** a package module's function (default: compiled from its code) */
    packageFn?: (lib: L) => PackageFn;
}

/**
 * Page-side `require` over the shipped libraries, data files and package
 * modules (hook, bridge and overlay): `requireFrom(importer)` resolves like
 * the background does. Libraries and package modules run once (`run`);
 * data files parse fresh per import.
 */
export function makeLibRequire<L extends ShippedLib>(libs: L[], run: (lib: L, require: (spec: string) => any, module: { exports: any }) => void, opts: LibRequireOptions<L> = {}): (importer: string) => (spec: string) => any {
    const pkgs: PackageModules = { aliases: {}, modules: {} };
    const pkgLibs = new Map<string, L>();
    for (const l of libs) {
        if (l.pkg) {
            pkgs.modules[l.name] = l.pkg;
            pkgLibs.set(l.name, l);
        }
        else if (l.alias !== undefined) pkgs.aliases[l.name] = l.alias;
    }
    const builtin = opts.builtin;
    // a downloaded package's own `require("react")` gets the built-in too (one React copy), unless it's React itself
    const loadPackage = makePackageLoader(
        pkgs,
        builtin ? (spec, from) => (builtinSpec(spec) && !/^https:\/\/unpkg\.com\/(react|react-dom|scheduler|valtio)@/.test(from) ? { module: builtin(spec, from, (u) => loadPackage(u)) } : undefined) : undefined,
        { style: opts.style, shared: opts.onSite ? "site" : "page", compile: opts.packageFn ? (url) => opts.packageFn!(pkgLibs.get(url)!) : undefined }
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
            if (isUrlSpec(spec)) {
                if (!opts.onSite) return loadPackage(spec);
                try {
                    return loadPackage(spec);
                } catch (e: any) {
                    const why = String(e?.message ?? e).replace(/^cannot import "[^"]*": /, "");
                    return unusable(spec, `it doesn't load there (${why}) — a package that needs React works in onPage or onOverlay code`);
                }
            }
            if (!r) throw new Error(`cannot import "${spec}" — is the ${isDataSpec(spec) ? "data file" : "library script"} saved?`);
            if (r.kind === "data") return dataFileValue(r.path, scriptLibs.find((l) => l.json !== undefined && l.name === r.path)!.json!);
            if (modules.has(r.name)) return modules.get(r.name);
            const lib = scriptLibs.find((l) => l.json === undefined && l.name === r.name)!;
            const moduleObj = { exports: {} as any };
            modules.set(r.name, moduleObj.exports); // early: cycle protection
            if (!loading.length) loading.push(importer);
            loading.push(lib.name);
            try {
                run(lib, requireFrom(lib.name), moduleObj);
            } finally {
                loading.pop();
                if (loading.length === 1) loading.pop();
            }
            modules.set(r.name, moduleObj.exports);
            return moduleObj.exports;
        };
    return requireFrom;
}
