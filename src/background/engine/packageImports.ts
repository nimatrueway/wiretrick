/**
 * Package imports, background side: downloads the module graph of every
 * package URL a script imports (and its TypeScript declarations) from
 * unpkg and keeps them in chrome.storage.local, so compiles stay
 * synchronous, offline and deterministic. Pinned versions are immutable:
 * a stored module is never re-fetched. A failed download isn't stored;
 * the next save (or a later compile) retries it.
 *
 *   resPackageModules  { aliases: {requested URL → final URL}, modules: {final URL → {js, requires}} }
 *   resPackageTypings  { files: {path → text}, tops: {package URL → paths it needs} }
 *
 * Typings paths mirror unpkg (`unpkg.com/<name>@<version>/…`) under the
 * typings root; bare type dependencies get `node_modules/<dep>/package.json`
 * pointers into that mirror.
 */
import { transform } from "sucrase";
import { importSpecs } from "../../shared/scriptImports";
import { dlogLevel } from "../../shared/debugLog";
import {
    PACKAGE_MODULES_KEY,
    PACKAGE_ORIGIN,
    PACKAGE_TYPINGS_KEY,
    builtinMessage,
    classifyNested,
    declarationCandidates,
    declarationRefs,
    dependencyRange,
    finalUrl,
    isEsModule,
    isNodeBuiltin,
    isUrlSpec,
    naturalDeclaration,
    normalizePath,
    packageClosure,
    packageRoot,
    parsePackageUrl,
    rangeUrl,
    relativePath,
    requireSpecs,
    splitBare,
    stubPath,
    typesCandidates,
    typesPackageName,
    typingsStub,
    type PackageModule,
    type PackageModules,
    type PackageUrl,
    type StoredTypings,
} from "../../shared/packageImports";

const TIMEOUT_MS = 15000;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_MODULES = 1000;
const MAX_GRAPH_BYTES = 20 * 1024 * 1024;
const MAX_TYPINGS_FILES = 500;
const MAX_TYPINGS_BYTES = 10 * 1024 * 1024;
const RETRY_MS = 60000;
const CONCURRENCY = 8;

let state: { aliases: Record<string, string>; modules: Record<string, PackageModule> } = { aliases: {}, modules: {} };
let typings: StoredTypings = { files: {}, tops: {} };
let loaded: Promise<void> | null = null;
/** package URLs whose download failed (not stored: retried) */
const failed = new Map<string, { reason: string; at: number }>();
const typingsFailedAt = new Map<string, number>();
/** when each package URL was last ensured: a prune racing a save that stores its importer later keeps it */
const ensuredAt = new Map<string, number>();
let snapshot: PackageModules = { aliases: {}, modules: {} };
let sig = "";
let chain: Promise<unknown> = Promise.resolve();
let typingsChain: Promise<unknown> = Promise.resolve();

function hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
    return h.toString(36);
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
}

function rebuildSnapshot(): void {
    const f = Object.fromEntries([...failed].map(([u, x]) => [u, x.reason]));
    snapshot = { aliases: state.aliases, modules: state.modules, failed: f };
    sig = hash(JSON.stringify([Object.keys(state.aliases).sort().map((k) => [k, state.aliases[k]]), Object.keys(state.modules).sort(), Object.entries(f).sort()]));
}

function storageGet(keys: string[]): Promise<Record<string, any>> {
    return new Promise((resolve) =>
        chrome.storage.local.get(keys, (d) => {
            void chrome.runtime.lastError;
            resolve(d || {});
        })
    );
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((resolve) =>
        chrome.storage.local.set(items, () => {
            const err = chrome.runtime.lastError;
            if (err) dlogLevel("packages", "error", `storing package imports failed: ${err.message}`);
            resolve();
        })
    );
}

/** read the store into the snapshot (once per context; `force` re-reads) */
export function loadPackages(force = false): Promise<void> {
    if (!loaded || force)
        loaded = storageGet([PACKAGE_MODULES_KEY, PACKAGE_TYPINGS_KEY]).then((d) => {
            const m = d[PACKAGE_MODULES_KEY];
            state = { aliases: m?.aliases || {}, modules: m?.modules || {} };
            const t = d[PACKAGE_TYPINGS_KEY];
            typings = { files: t?.files || {}, tops: t?.tops || {} };
            rebuildSnapshot();
        });
    return loaded;
}

/** the downloaded modules (and current failures) as the compilers see them */
export function packagesSnapshot(): PackageModules {
    return snapshot;
}

/** signature of the snapshot (MV3: does the sandbox have these modules?) */
export function packagesSig(): string {
    return sig;
}

/** the package URLs the code imports (valid or not) */
export function packageUrlsIn(codes: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const code of codes) for (const s of importSpecs(code)) if (isUrlSpec(s)) out.add(s);
    return out;
}

// ---- fetching ----

let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
        return await fn();
    } finally {
        active--;
        waiting.shift()?.();
    }
}

class HttpError extends Error {
    constructor(
        message: string,
        public status: number
    ) {
        super(message);
    }
}

/** GET a file from unpkg (redirects followed): its final URL and text */
function fetchText(url: string): Promise<{ url: string; text: string }> {
    return limited(async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: ctl.signal, credentials: "omit", redirect: "follow" });
            if (!res.ok) throw new HttpError(`HTTP ${res.status}${res.status === 404 ? " — no such package, version or file" : ""}`, res.status);
            const final = res.url || url;
            if (!final.startsWith(PACKAGE_ORIGIN)) throw new Error(`redirected away from unpkg (${final})`);
            if (/text\/html/i.test(res.headers.get("content-type") || "")) throw new Error("got an HTML page, not a module");
            if (Number(res.headers.get("content-length") || 0) > MAX_FILE) throw new Error("file larger than 5 MB");
            const text = await res.text();
            if (text.length > MAX_FILE) throw new Error("file larger than 5 MB");
            return { url: final, text };
        } catch (e: any) {
            if (e?.name === "AbortError") throw new Error(`timed out after ${TIMEOUT_MS / 1000} s`);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    });
}

const pkgJsons = new Map<string, Promise<any>>();

/** a package version's package.json ({} when it can't be read) */
function packageJson(name: string, version: string): Promise<any> {
    const key = `${name}@${version}`;
    let p = pkgJsons.get(key);
    if (!p) {
        p = fetchText(`${packageRoot({ name, version })}/package.json`)
            .then((r) => JSON.parse(r.text))
            .catch(() => {
                pkgJsons.delete(key);
                return {};
            });
        pkgJsons.set(key, p);
    }
    return p;
}

/** the exact version a dependency range resolves to (unpkg redirects to it) */
async function resolveVersion(name: string, range: string): Promise<string> {
    const url = rangeUrl(name, range, "package.json");
    if (!url) throw new HttpError(`unsupported dependency range "${range}"`, 400);
    const r = await fetchText(url);
    const p = parsePackageUrl(r.url);
    if (typeof p === "string") throw new Error(`unexpected redirect to ${r.url}`);
    if (!pkgJsons.has(`${p.name}@${p.version}`)) pkgJsons.set(`${p.name}@${p.version}`, Promise.resolve(JSON.parse(r.text)));
    return p.version;
}

/** library code → CommonJS run by makePackageLoader */
function toCommonJs(url: string, text: string): string {
    if (/\.json$/i.test(new URL(url).pathname)) {
        JSON.parse(text);
        return `module.exports = ${text};`;
    }
    if (!isEsModule(text)) return text;
    const meta = text.replace(/\bimport\.meta\.url\b/g, JSON.stringify(url)).replace(/\bimport\.meta\b/g, `({ url: ${JSON.stringify(url)} })`);
    return transform(meta, { transforms: ["imports"], filePath: url }).code;
}

/** download the module graph of a package URL into `into` (new modules only); resolves to its final URL */
async function downloadGraph(top: string, into: { aliases: Record<string, string>; modules: Record<string, PackageModule> }): Promise<string> {
    let count = 0;
    let bytes = 0;
    let overCap = "";
    const inflight = new Map<string, Promise<string>>();
    const pending = new Set<Promise<void>>();
    const known = (u: string) => into.modules[u] || state.modules[u];
    const track = (p: Promise<void>) => {
        pending.add(p);
        void p.finally(() => pending.delete(p));
    };
    const fetchModule = (requested: string): Promise<string> => {
        const alias = into.aliases[requested] ?? state.aliases[requested] ?? (known(requested) ? requested : undefined);
        if (alias && known(alias)) return Promise.resolve(alias);
        let p = inflight.get(requested);
        if (!p) {
            p = (async () => {
                const r = await fetchText(requested);
                if (r.url !== requested) into.aliases[requested] = r.url;
                // another specifier redirected to the same file first
                if (known(r.url)) return r.url;
                if (++count > MAX_MODULES) throw new Error((overCap = `the package needs more than ${MAX_MODULES} modules`));
                if ((bytes += r.text.length) > MAX_GRAPH_BYTES) throw new Error((overCap = "the package is larger than 20 MB"));
                const mod: PackageModule = { js: toCommonJs(r.url, r.text), requires: {} };
                into.modules[r.url] = mod;
                track(resolveRequires(r.url, mod));
                return r.url;
            })();
            inflight.set(requested, p);
        }
        return p;
    };
    const resolveNested = async (spec: string, from: string): Promise<string> => {
        if (spec.startsWith("node:")) throw new Error(builtinMessage(spec));
        const c = classifyNested(spec, from);
        if ("error" in c) throw new Error(c.error);
        if ("url" in c) return fetchModule(c.url);
        const owner = parsePackageUrl(from);
        const own = typeof owner === "string" ? undefined : owner;
        const range = own && own.name === c.bare ? own.version : own ? dependencyRange(await packageJson(own.name, own.version), c.bare) : undefined;
        if (range === undefined && isNodeBuiltin(spec)) throw new Error(builtinMessage(spec));
        const url = rangeUrl(c.bare, range, c.sub);
        if (!url) throw new Error(`cannot import "${spec}": unsupported dependency range "${range}"`);
        return fetchModule(url);
    };
    const resolveRequires = async (url: string, mod: PackageModule) => {
        await Promise.all(
            requireSpecs(mod.js).map(async (spec) => {
                try {
                    mod.requires[spec] = await resolveNested(spec, url);
                } catch (e: any) {
                    const msg = String(e?.message ?? e);
                    mod.requires[spec] = "!" + (msg.startsWith("cannot import") || msg.includes("Node.js built-in") ? msg : `cannot import "${spec}" (required by ${url}): ${msg}`);
                }
            })
        );
    };
    const final = await fetchModule(top);
    while (pending.size) await Promise.all([...pending]);
    if (overCap) throw new Error(overCap);
    return final;
}

// ---- ensure / prune ----

/**
 * Download every package URL the code imports that isn't stored yet (a
 * no-op when all are). Failed downloads are retried when `retry` is set
 * (a save) or a minute later. Resolves to whether anything changed.
 */
export async function ensurePackages(codes: Iterable<string>, opts?: { retry?: boolean }): Promise<boolean> {
    await loadPackages();
    const tops = [...packageUrlsIn(codes)].filter((u) => typeof parsePackageUrl(u) !== "string");
    for (const u of tops) ensuredAt.set(u, Date.now());
    const due = (u: string) => !finalUrl(state, u) && (opts?.retry || !failed.has(u) || Date.now() - failed.get(u)!.at > RETRY_MS);
    let changed = false;
    if (tops.some(due))
        changed = await serial(async () => {
            const todo = tops.filter(due);
            if (!todo.length) return false;
            const into = { aliases: {} as Record<string, string>, modules: {} as Record<string, PackageModule> };
            await Promise.all(
                todo.map(async (u) => {
                    const own = { aliases: {} as Record<string, string>, modules: {} as Record<string, PackageModule> };
                    try {
                        const f = await downloadGraph(u, own);
                        if (f !== u) own.aliases[u] = f;
                        Object.assign(into.aliases, own.aliases);
                        Object.assign(into.modules, own.modules);
                        failed.delete(u);
                        dlogLevel("packages", "info", `downloaded ${u}`);
                    } catch (e: any) {
                        failed.set(u, { reason: `download failed (${e?.message ?? e})`, at: Date.now() });
                        dlogLevel("packages", "warn", `downloading ${u} failed: ${e?.message ?? e}`);
                    }
                })
            );
            state = { aliases: { ...state.aliases, ...into.aliases }, modules: { ...state.modules, ...into.modules } };
            if (Object.keys(into.modules).length || Object.keys(into.aliases).length) await storageSet({ [PACKAGE_MODULES_KEY]: state });
            rebuildSnapshot();
            return true;
        });
    ensureTypings(tops);
    return changed;
}

/** drop stored modules and typings no script imports any more */
export async function prunePackages(codes: Iterable<string>): Promise<void> {
    await loadPackages();
    const live = packageUrlsIn(codes);
    for (const [u, at] of ensuredAt) {
        if (Date.now() - at < RETRY_MS) live.add(u);
        else ensuredAt.delete(u);
    }
    await serial(async () => {
        for (const u of [...failed.keys()]) if (!live.has(u)) failed.delete(u);
        const keep = packageClosure(state, live);
        const modules = Object.fromEntries(Object.entries(state.modules).filter(([u]) => keep.has(u)));
        const aliases = Object.fromEntries(Object.entries(state.aliases).filter(([, f]) => keep.has(f)));
        const dropped = Object.keys(state.modules).length - Object.keys(modules).length + Object.keys(state.aliases).length - Object.keys(aliases).length;
        state = { aliases, modules };
        if (dropped) await storageSet({ [PACKAGE_MODULES_KEY]: state });
        rebuildSnapshot();
    });
    await (typingsChain = typingsChain.then(async () => {
        const tops = Object.fromEntries(Object.entries(typings.tops).filter(([u]) => live.has(u)));
        if (Object.keys(tops).length === Object.keys(typings.tops).length) return;
        const used = new Set(Object.values(tops).flat());
        typings = { files: Object.fromEntries(Object.entries(typings.files).filter(([p]) => used.has(p))), tops };
        await storageSet({ [PACKAGE_TYPINGS_KEY]: typings });
    }));
}

// ---- typings ----

/** fetch (in the background) the typings of downloaded package URLs that have none yet */
function ensureTypings(tops: string[]): void {
    const due = (u: string) => !typings.tops[u] && !!finalUrl(state, u) && Date.now() - (typingsFailedAt.get(u) ?? 0) > RETRY_MS;
    if (!tops.some(due)) return;
    typingsChain = typingsChain.then(async () => {
        let changed = false;
        for (const u of tops.filter(due)) {
            try {
                const files = await crawlTypings(u, typings.files);
                typings = { files: { ...typings.files, ...Object.fromEntries(files) }, tops: { ...typings.tops, [u]: [...files.keys()].sort() } };
                changed = true;
                typingsFailedAt.delete(u);
            } catch (e: any) {
                typingsFailedAt.set(u, Date.now());
                dlogLevel("packages", "warn", `fetching the typings of ${u} failed: ${e?.message ?? e}`);
            }
        }
        if (changed) await storageSet({ [PACKAGE_TYPINGS_KEY]: typings });
    });
}

/** resolves once pending typings downloads are stored (tests) */
export function packageTypingsIdle(): Promise<void> {
    return typingsChain.then(() => {});
}

/** the stored typings (tests, folder sync reads storage directly) */
export function packageTypings(): StoredTypings {
    return typings;
}

const dirOf = (p: { name: string; version: string }) => `unpkg.com/${p.name}@${p.version}`;

/** typings path → owning package (`unpkg.com/<name>@<version>/…`) */
function ownerOf(path: string): PackageUrl | undefined {
    const p = parsePackageUrl(`https://${path}`);
    return typeof p === "string" ? undefined : p;
}

/**
 * The declaration files a package URL needs (path → text), crawled from
 * its types entry: relative references, `/// <reference>`s and bare
 * type dependencies. Files already in `existing` are reused, not fetched.
 */
async function crawlTypings(top: string, existing: Record<string, string>): Promise<Map<string, string>> {
    const p = parsePackageUrl(top) as PackageUrl;
    const files = new Map<string, string>();
    const missing = new Set<string>();
    const pending = new Set<Promise<void>>();
    const deps = new Map<string, { version: string; types?: string }>();
    const depSubs = new Set<string>();
    let bytes = 0;
    let capped = false;
    const track = (fn: () => Promise<void>) => {
        const t = fn();
        pending.add(t);
        void t.finally(() => pending.delete(t));
    };
    const add = (path: string, text: string): boolean => {
        if (files.has(path)) return true;
        if (files.size >= MAX_TYPINGS_FILES || bytes + text.length > MAX_TYPINGS_BYTES) {
            capped = true;
            return false;
        }
        bytes += text.length;
        files.set(path, text);
        return true;
    };
    const decl = async (path: string): Promise<boolean> => {
        if (files.has(path)) return true;
        if (missing.has(path)) return false;
        let text = existing[path];
        if (text === undefined) {
            try {
                const r = await fetchText(`https://${path}`);
                if (r.url !== `https://${path}`) throw new HttpError("redirected", 404);
                text = r.text;
            } catch (e) {
                if (e instanceof HttpError && e.status === 404) {
                    missing.add(path);
                    return false;
                }
                throw e;
            }
        }
        if (files.has(path)) return true;
        if (!add(path, text)) return false;
        track(() => scan(path, text!));
        return true;
    };
    const firstDecl = async (paths: string[]): Promise<string | undefined> => {
        for (const c of paths) if (await decl(c)) return c;
        return undefined;
    };
    /** a package's own declarations for `sub` */
    const ownTypes = async (name: string, version: string, sub: string) =>
        firstDecl(typesCandidates(await packageJson(name, version), sub).map((c) => `${dirOf({ name, version })}/${normalizePath(c)}`));
    /** declarations for a package's `sub`: its own, else its `@types` package (same major, then latest) */
    const entryFor = async (name: string, version: string, sub: string): Promise<string | undefined> => {
        const own = await ownTypes(name, version, sub);
        if (own || name.startsWith("@types/")) return own;
        const tn = typesPackageName(name);
        for (const range of [version.split(".")[0], "latest"]) {
            try {
                const e = await ownTypes(tn, await resolveVersion(tn, range), sub);
                if (e) return e;
            } catch (e) {
                if (!(e instanceof HttpError && e.status === 404)) throw e;
            }
        }
        return undefined;
    };
    const pointer = (folder: string, fields: Record<string, string>, entry: string | undefined) =>
        add(`${folder}/package.json`, JSON.stringify({ ...fields, ...(entry ? { types: relativePath(folder, entry) } : {}) }, null, 2) + "\n");
    const sources = new Map<string, Promise<{ name: string; version: string }>>();
    /** the package (the dependency itself or its `@types`) and version a bare type dependency comes from */
    const sourceOf = (name: string, from: string) => {
        let s = sources.get(name);
        if (!s)
            sources.set(
                name,
                (s = (async () => {
                    // another package URL's crawl already chose one
                    const prior = existing[`node_modules/${name}/package.json`];
                    const types = prior ? JSON.parse(prior).types : undefined;
                    const o = typeof types === "string" ? ownerOf(normalizePath(`node_modules/${name}/${types}`)) : undefined;
                    if (o) return { name: o.name === typesPackageName(name) ? o.name : name, version: o.version };
                    const owner = ownerOf(from);
                    if (owner?.name === name) return { name, version: owner.version };
                    const pkg = owner ? await packageJson(owner.name, owner.version) : {};
                    let range = dependencyRange(pkg, name);
                    let src = name;
                    const tr = range === undefined ? dependencyRange(pkg, typesPackageName(name)) : undefined;
                    if (tr !== undefined) [range, src] = [tr, typesPackageName(name)];
                    return { name: src, version: await resolveVersion(src, range ?? "latest") };
                })())
            );
        return s;
    };
    const typeDep = async (spec: string, from: string) => {
        if (spec === "node" || isUrlSpec(spec) || isNodeBuiltin(spec) || depSubs.has(spec)) return;
        if (!("bare" in classifyNested(spec, PACKAGE_ORIGIN))) return;
        depSubs.add(spec);
        const { name, sub } = splitBare(spec);
        try {
            const src = await sourceOf(name, from);
            const e = src.name === name ? await entryFor(name, src.version, sub) : await ownTypes(src.name, src.version, sub);
            const dep = deps.get(name) ?? { version: src.version };
            deps.set(name, dep);
            if (!sub) dep.types = e;
            else if (e) pointer(`node_modules/${name}/${sub}`, {}, e);
        } catch (e) {
            // a dependency without (findable) typings: its imports stay unresolved
            if (!(e instanceof HttpError && e.status < 500)) throw e;
        }
    };
    const scan = async (path: string, text: string) => {
        const { specs, paths, types } = declarationRefs(text);
        const folder = path.slice(0, path.lastIndexOf("/"));
        const rel = async (spec: string) => firstDecl(declarationCandidates(normalizePath(`${folder}/${spec}`)));
        await Promise.all([
            ...specs.map((s) => (/^\.\.?(\/|$)/.test(s) ? rel(s) : typeDep(s, path))),
            ...paths.map((s) => rel(/^\.\.?\//.test(s) ? s : `./${s}`)),
            ...types.map((s) => typeDep(s, path)),
        ]);
    };

    const dir = dirOf(p);
    const entry = await entryFor(p.name, p.version, p.sub);
    while (pending.size) await Promise.all([...pending]);
    if (!p.sub) {
        if (!entry) add(`${dir}/index.d.ts`, typingsStub(top));
        pointer(dir, { name: p.name, version: p.version }, entry ?? `${dir}/index.d.ts`);
    } else if (!entry) add(`${dir}/${stubPath(p.sub)}`, typingsStub(top));
    else if (!naturalDeclaration(p.sub).some((n) => `${dir}/${n}` === entry)) pointer(`${dir}/${p.sub}`, {}, entry);
    for (const [name, d] of deps) pointer(`node_modules/${name}`, { name, version: d.version }, d.types);
    if (capped) dlogLevel("packages", "warn", `the typings of ${top} were cut off at ${MAX_TYPINGS_FILES} files / 10 MB`);
    return files;
}
