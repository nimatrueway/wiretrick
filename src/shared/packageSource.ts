/**
 * Where a package comes from, and reading its files: the install page
 * (first install, local files) and the background (updates) share this.
 *
 * A package is a script, or a bundle — a metadata.json listing scripts
 * (see packageMetadata) — plus every file they import by a relative path,
 * followed transitively. Sources:
 *   - GitHub: a file (`github.com/o/r/blob/ref/x.ts`, `…/metadata.json`,
 *     `raw.githubusercontent.com/o/r/ref/…`) or a folder (`github.com/o/r/tree/ref/dir`,
 *     `github.com/o/r`; see pickStart); pinned to the commit the ref points at
 *   - gist: `gist.github.com/user/id` (see pickStart), pinned to the
 *     gist's revision
 *   - any other http(s) or file:// URL of the script or metadata.json; the
 *     files are fetched next to it
 *   - a .zip URL (a release asset, `github.com/o/r/archive/…zip`): its
 *     root's package (see pickStart; a zip of one folder is that folder)
 *
 * A `*.tangitweak.ts` URL opened in a tab installs (a share link, like
 * GreaseMonkey's `.user.js`).
 */
import { builtinSpec } from "./builtinSpecs";
import { isManifestPath, MANIFEST_FILE, parseManifest, type Manifest } from "./packageMetadata";
import { isUrlSpec } from "./packageImports";
import { bytesToImageDataUrl, importPath, importSpecs, isDataSpec, isImageDataPath, isRelativeIconSpec, metadataIconSpec } from "./scriptImports";
import { readZipEntries } from "./zip";

export type PackageSource =
    | { kind: "github"; owner: string; repo: string; ref: string; path: string; tree: boolean }
    | { kind: "gist"; id: string; file?: string }
    | { kind: "url"; url: string }
    | { kind: "zip"; url: string };

/** a URL that installs as a package when opened in a tab */
export const ENTRY_URL_RE = /^(https?|file):\/\/[^?#]*\.tangitweak\.tsx?([?#]|$)/i;

/** hash suffix marking any package/bundle URL (such as a GitHub repo or folder) as an install link */
export const INSTALL_HASH = "#tangitweak:install";
export const INSTALL_HASH_RE = /#tangitweak:install$/i;

export const stripInstallHash = (url: string): string => url.trim().replace(INSTALL_HASH_RE, "");

/** the package URL to open in `install.html` when a tab visits or clicks `url`, or null */
export function installTargetUrl(url: string): string | null {
    if (!url || /#tt-raw$/i.test(url)) return null;
    if (INSTALL_HASH_RE.test(url)) {
        const clean = stripInstallHash(url);
        return /^(https?|file):\/\//i.test(clean) ? clean : null;
    }
    if (/^https?:\/\/(gist\.)?github\.com\//i.test(url)) return null; // GitHub's own page for the file
    return ENTRY_URL_RE.test(url) ? url : null;
}

/** a share link's script name */
export const ENTRY_FILE_RE = /\.tangitweak\.tsx?$/i;

/** a script's file name */
export const SCRIPT_FILE_RE = /\.tsx?$/i;

/** the source a URL names, or why it can't be one */
export function parseSource(input: string): PackageSource | string {
    let u: URL;
    try {
        u = new URL(input.trim());
    } catch {
        return "not a URL";
    }
    const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const host = u.hostname.toLowerCase();
    if (/^(https?|file):$/.test(u.protocol) && /\.zip$/i.test(u.pathname)) {
        u.hash = "";
        return { kind: "zip", url: u.href };
    }
    if (host === "github.com" || host === "www.github.com") {
        const [owner, repo, mode, ref, ...rest] = seg;
        if (!owner || !repo) return "a GitHub URL needs the owner and repository";
        if (!mode) return { kind: "github", owner, repo: repo.replace(/\.git$/, ""), ref: "HEAD", path: "", tree: true };
        if ((mode === "blob" || mode === "raw") && ref && rest.length) return { kind: "github", owner, repo, ref, path: rest.join("/"), tree: false };
        if (mode === "tree" && ref) return { kind: "github", owner, repo, ref, path: rest.join("/"), tree: true };
        return "open a file (…/blob/…) or folder (…/tree/…) of the repository";
    }
    if (host === "raw.githubusercontent.com") {
        const [owner, repo, ...rest] = seg;
        // refs/heads/x/… and refs/tags/x/… name the ref in three segments
        const n = rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") ? 3 : 1;
        if (!owner || !repo || rest.length <= n) return "not a raw GitHub file URL";
        return { kind: "github", owner, repo, ref: rest.slice(0, n).join("/"), path: rest.slice(n).join("/"), tree: false };
    }
    if (host === "gist.github.com") {
        const id = seg.length >= 2 ? seg[1] : seg[0];
        if (!id || !/^[0-9a-f]+$/i.test(id)) return "not a gist URL";
        return { kind: "gist", id };
    }
    if (host === "gist.githubusercontent.com") {
        // /user/id/raw[/revision]/file
        const [, id, raw, ...rest] = seg;
        if (!id || raw !== "raw") return "not a raw gist URL";
        return { kind: "gist", id, file: rest.length ? rest[rest.length - 1] : undefined };
    }
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") {
        if (!SCRIPT_FILE_RE.test(u.pathname) && !isManifestPath(u.pathname)) return "the URL must end in .ts (a script), metadata.json (a bundle) or .zip";
        u.hash = "";
        return { kind: "url", url: u.href };
    }
    return `${u.protocol} URLs aren't supported`;
}

/** short text naming a source */
export function sourceLabel(src: PackageSource): string {
    if (src.kind === "github") return `github.com/${src.owner}/${src.repo}${src.path ? "/" + src.path : ""}${src.ref === "HEAD" ? "" : ` @ ${src.ref}`}`;
    if (src.kind === "gist") return `gist ${src.id}`;
    return src.url.replace(/^https?:\/\//, "");
}

/** a source updates in the background (a local file only when the Editor reads it) */
export const isRemote = (src: PackageSource): boolean => (src.kind !== "url" && src.kind !== "zip") || /^https?:/i.test(src.url);

/** progress reported while downloading a package's archive or files */
export interface DownloadProgress {
    /** completed units (files or bytes), when `total` is known */
    done?: number;
    /** total units (files or bytes), when known; omit for an indeterminate bar */
    total?: number;
    /** short progress detail, e.g. "3 / 12 files" or "420 KB / 1.8 MB" */
    detail?: string;
}

/** how the reader gets at the network: text or bytes of a URL (null: not found), and JSON (`auth`: include browser session cookies) */
export interface Net {
    text(url: string, auth?: boolean): Promise<string | null>;
    bytes(url: string, onBytes?: (loaded: number, total?: number) => void, auth?: boolean): Promise<ArrayBuffer | null>;
    json(url: string): Promise<any>;
}

/** the files a package can use */
export const isPackageFile = (path: string): boolean => /\.(tsx?|json|svg|md|png|jpe?g|gif|webp|ico|avif)$/i.test(path) && !/(^|\/)(node_modules|\.git)\//.test(path);

/** read a browser `File` as package content (raster images become `data:image/...;base64,...`) */
export async function readPackageBrowserFile(path: string, file: File): Promise<string> {
    return isImageDataPath(path) ? bytesToImageDataUrl(path, new Uint8Array(await file.arrayBuffer())) : file.text();
}

async function unzipPackageArchive(buf: ArrayBuffer, subPath?: string): Promise<{ files: Record<string, string>; topFolder?: string; comment: string }> {
    const sub = subPath?.replace(/\/$/, "");
    let parsed: Awaited<ReturnType<typeof readZipEntries>>;
    try {
        parsed = await readZipEntries(buf, isPackageFile);
    } catch (e: any) {
        if (!sub || !/more than 20 MB/i.test(String(e?.message || e))) throw e;
        // Large monorepo: decompress only package files inside `sub/`
        parsed = await readZipEntries(buf, (name) => {
            const slash = name.indexOf("/");
            const rel = slash < 0 ? name : name.slice(slash + 1);
            return isPackageFile(rel) && (rel === sub || rel.startsWith(sub + "/"));
        });
    }
    const { files: raw, comment } = parsed;
    const utf8 = new TextDecoder();
    const files: Record<string, string> = {};
    for (const [p, bytes] of Object.entries(raw)) files[p] = isImageDataPath(p) ? bytesToImageDataUrl(p, bytes) : utf8.decode(bytes);
    const tops = new Set(Object.keys(files).map((p) => (p.includes("/") ? p.split("/")[0] : "")));
    if (tops.size !== 1 || tops.has("")) return { files, comment };
    const topFolder = [...tops][0];
    const cut = topFolder.length + 1;
    return { files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p.slice(cut), t])), topFolder, comment };
}

/** a zip's package files, as text (raster images as `data:` URLs); a zip of one folder is that folder's */
export async function unzipPackage(buf: ArrayBuffer): Promise<Record<string, string>> {
    return (await unzipPackageArchive(buf)).files;
}

/** a source, opened: where its entry or metadata.json is, how to read a path, and the revision it's pinned to */
export interface OpenedSource {
    /** the entry's or the bundle's metadata.json's path, relative to the source's root */
    start: string;
    read(path: string): Promise<string | null>;
    /** commit / gist revision; undefined: the files' hash (crawl result) */
    revision?: string;
    /** all files came from an archive (byte progress was already reported) */
    archived?: boolean;
}

const GITHUB_API = "https://api.github.com";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const encodeGitRef = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

/**
 * Fallback for private GitHub repositories (or when unauthenticated api.github.com
 * hits its rate limit): fetches `https://github.com/<owner>/<repo>/archive/<ref>.zip`
 * with browser session cookies (`auth: true`), extracts the 40-char commit SHA from
 * GitHub's zip comment, and serves the repository files from memory.
 */
async function openGitHubArchive(
    src: Extract<PackageSource, { kind: "github" }>,
    net: Net,
    onProgress?: (p: DownloadProgress) => void
): Promise<OpenedSource> {
    const byteProgress = onProgress
        ? (loaded: number, total?: number) => onProgress(total ? { done: loaded, total, detail: `${formatBytes(loaded)} / ${formatBytes(total)}` } : { detail: formatBytes(loaded) })
        : undefined;
    let ref = src.ref;
    let relPath = src.path;
    const archiveOf = (r: string) => `https://github.com/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.repo)}/archive/${encodeGitRef(r)}.zip`;
    let buf = await net.bytes(archiveOf(ref), byteProgress, true);
    // Support slash-containing branch names on folder/file URLs (e.g. tree/feat/x/pkg/dir)
    if (!buf && relPath) {
        const segs = relPath.split("/").filter(Boolean);
        for (let i = 1; i <= Math.min(3, src.tree ? segs.length : segs.length - 1); i++) {
            const tryRef = `${src.ref}/${segs.slice(0, i).join("/")}`;
            const tryBuf = await net.bytes(archiveOf(tryRef), byteProgress, true);
            if (tryBuf) {
                buf = tryBuf;
                ref = tryRef;
                relPath = segs.slice(i).join("/");
                break;
            }
        }
    }
    if (!buf) {
        throw new Error(`can't read github.com/${src.owner}/${src.repo} @ ${src.ref} (if this repository is private, sign in to GitHub in this browser first)`);
    }
    const archiveCap = relPath ? 20 * MAX_BYTES : 4 * MAX_BYTES;
    if (buf.byteLength > archiveCap) {
        if (!src.tree) {
            const rawBase = `https://github.com/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.repo)}/raw/${encodeGitRef(ref)}/`;
            return {
                start: relPath,
                read: async (p) => {
                    const url = rawBase + p.split("/").map(encodeURIComponent).join("/");
                    if (!isImageDataPath(p)) return net.text(url, true);
                    const b = await net.bytes(url, undefined, true);
                    return b ? bytesToImageDataUrl(p, new Uint8Array(b)) : null;
                },
            };
        }
        throw new Error(`the repository archive is over ${archiveCap / 1024 / 1024} MB`);
    }
    let parsed: Awaited<ReturnType<typeof unzipPackageArchive>>;
    try {
        parsed = await unzipPackageArchive(buf, relPath);
    } catch (e: any) {
        if (/not a zip file/i.test(String(e?.message || e))) {
            throw new Error(`github.com/${src.owner}/${src.repo} asked to sign in or authorize SSO — open it in a tab and sign in first`);
        }
        throw e;
    }
    const { files, topFolder, comment } = parsed;
    const commentSha = comment.trim();
    const folderSha = topFolder ? /-([0-9a-f]{40})$/i.exec(topFolder)?.[1] : undefined;
    const sha = /^[0-9a-f]{40}$/i.test(commentSha) ? commentSha.toLowerCase() : folderSha?.toLowerCase();
    let start = relPath;
    if (src.tree) {
        const dir = relPath.replace(/\/$/, "");
        const here = Object.keys(files).filter((p) => p.slice(0, p.lastIndexOf("/") + 1) === (dir ? dir + "/" : ""));
        start = pickStart(here, dir || "the repository", "open the one to install, or list them in a metadata.json");
    }
    return { start, revision: sha, archived: true, read: async (p) => files[p] ?? null };
}

export async function openSource(src: PackageSource, net: Net, onProgress?: (p: DownloadProgress) => void): Promise<OpenedSource> {
    if (src.kind === "github") {
        onProgress?.({});
        const base = `${GITHUB_API}/repos/${src.owner}/${src.repo}`;
        let commit: any;
        try {
            commit = await net.json(`${base}/commits/${encodeURIComponent(src.ref)}`);
        } catch (e: any) {
            if (/HTTP (401|403|404|429)|rate limit/i.test(String(e?.message || e))) {
                return openGitHubArchive(src, net, onProgress);
            }
            throw e;
        }
        const sha: string | undefined = commit?.sha;
        if (!sha) throw new Error(`no commit for "${src.ref}" in ${src.owner}/${src.repo}`);
        let start = src.path;
        if (src.tree) {
            const tree = await net.json(`${base}/git/trees/${sha}?recursive=1`);
            const dir = src.path.replace(/\/$/, "");
            const here = ((tree?.tree ?? []) as { path: string; type: string }[])
                .filter((t) => t.type === "blob" && t.path.slice(0, t.path.lastIndexOf("/") + 1) === (dir ? dir + "/" : ""))
                .map((t) => t.path);
            start = pickStart(here, dir || "the repository", "open the one to install, or list them in a metadata.json");
        }
        const raw = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${sha}/`;
        const readRemote = async (p: string) => {
            const url = raw + p.split("/").map(encodeURIComponent).join("/");
            if (!isImageDataPath(p)) return net.text(url);
            const b = await net.bytes(url);
            return b ? bytesToImageDataUrl(p, new Uint8Array(b)) : null;
        };
        return { start, revision: sha, read: readRemote };
    }
    if (src.kind === "gist") {
        onProgress?.({});
        const g = await net.json(`${GITHUB_API}/gists/${src.id}`);
        const files: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> = g?.files ?? {};
        const names = Object.keys(files);
        const start = src.file && files[src.file] && (SCRIPT_FILE_RE.test(src.file) || isManifestPath(src.file)) ? src.file : pickStart(names, "the gist", "open the raw URL of the one to install, or list them in a metadata.json");
        const revision: string | undefined = g?.history?.[0]?.version;
        return {
            start,
            revision,
            read: async (p) => {
                const f = files[p];
                if (!f) return null;
                if (isImageDataPath(p) && f.raw_url) {
                    const b = await net.bytes(f.raw_url);
                    return b ? bytesToImageDataUrl(p, new Uint8Array(b)) : null;
                }
                return f.truncated || f.content === undefined ? (f.raw_url ? net.text(f.raw_url) : null) : f.content;
            },
        };
    }
    if (src.kind === "zip") {
        onProgress?.({});
        const buf = await net.bytes(src.url, onProgress ? (loaded, total) => onProgress(total ? { done: loaded, total, detail: `${formatBytes(loaded)} / ${formatBytes(total)}` } : { detail: formatBytes(loaded) }) : undefined);
        if (!buf) throw new Error(`can't read ${src.url}`);
        if (buf.byteLength > 4 * MAX_BYTES) throw new Error(`the zip is over ${(4 * MAX_BYTES) / 1024 / 1024} MB`);
        const files = await unzipPackage(buf);
        const start = pickStart(Object.keys(files).filter((p) => !p.includes("/")), "the zip", "list them in a metadata.json at its root");
        return { start, archived: true, read: async (p) => files[p] ?? null };
    }
    // a plain URL: paths are from its origin's root, so `../` imports work
    const u = new URL(src.url);
    const origin = u.protocol === "file:" ? "file://" : u.origin;
    return {
        start: decodeURIComponent(u.pathname.replace(/^\//, "")),
        read: async (p) => {
            const url = `${origin}/${p.split("/").map(encodeURIComponent).join("/")}`;
            if (!isImageDataPath(p)) return net.text(url);
            const b = await net.bytes(url);
            return b ? bytesToImageDataUrl(p, new Uint8Array(b)) : null;
        },
    };
}

/** what a folder's files install as: its metadata.json, else its one *.tangitweak.ts file, else its one script */
export function pickStart(paths: string[], where: string, hint: string): string {
    const manifest = paths.find(isManifestPath);
    if (manifest) return manifest;
    const marked = paths.filter((p) => ENTRY_FILE_RE.test(p));
    if (marked.length === 1) return marked[0];
    const scripts = marked.length ? marked : paths.filter((p) => SCRIPT_FILE_RE.test(p) && !/\.d\.ts$/i.test(p));
    if (scripts.length === 1) return scripts[0];
    throw new Error(scripts.length ? `${where} holds ${scripts.length} scripts (${scripts.join(", ")}) — ${hint}` : `no script or metadata.json in ${where}`);
}

/** a package's files as read, before they're laid out in the Explorer */
export interface CrawledPackage {
    /** its entries' paths in `files` */
    entries: string[];
    /** a bundle's metadata.json (at `files["metadata.json"]`) */
    manifest?: Manifest;
    /** path (relative to the package's root folder) → text */
    files: Record<string, string>;
    /** relative imports that point at no file */
    missing: { from: string; spec: string }[];
    /** imports by bare name: they resolve from the root of the user's scripts, not the package */
    bare: { from: string; spec: string }[];
}

export const MAX_FILES = 200;
export const MAX_BYTES = 5 * 1024 * 1024;

/** the paths a relative import may name, in TypeScript's order */
export function candidates(path: string): string[] {
    if (isDataSpec(path) || /\.tsx?$/i.test(path)) return [path];
    if (/\.js$/i.test(path)) return [path.slice(0, -3) + ".ts", path.slice(0, -3) + ".tsx"];
    return [path + ".ts", path + ".tsx"];
}

/**
 * Read an entry, or a bundle's metadata.json and its entries, and
 * everything they import by relative path; paths come out relative to the
 * files' common folder — a bundle's own folder (importing from outside it
 * is an error).
 */
export async function crawl(start: string, read: (path: string) => Promise<string | null>, onProgress?: (p: DownloadProgress) => void): Promise<CrawledPackage> {
    const files: Record<string, string> = {};
    const cache = new Map<string, Promise<string | null>>();
    const get = (p: string) => {
        if (!cache.has(p)) cache.set(p, read(p).catch(() => null));
        return cache.get(p)!;
    };
    const missing: CrawledPackage["missing"] = [];
    const bare: CrawledPackage["bare"] = [];
    const knownKey = (p: string) => (isDataSpec(p) ? p.toLowerCase() : p.replace(/\.(tsx?|js)$/i, "").toLowerCase());
    const known = new Set<string>([knownKey(start)]);
    let filesDone = 0;
    const report = (hasMore: boolean) => {
        if (!onProgress) return;
        if (known.size <= 1 && !hasMore) {
            onProgress({});
            return;
        }
        const total = Math.max(known.size, filesDone + (hasMore ? 1 : 0));
        onProgress({ done: filesDone, total, detail: `${filesDone} / ${total} files` });
    };
    onProgress?.({});
    // the first read's error says why (no file access, rate limit…)
    const first = async (p: string, what: string) => {
        const t = await read(p);
        if (t === null) throw new Error(`can't read ${what}`);
        cache.set(p, Promise.resolve(t));
        files[p] = t;
        return t;
    };
    let manifest: Manifest | undefined;
    let entries = [start];
    const dir = start.slice(0, start.lastIndexOf("/") + 1);
    if (isManifestPath(start)) {
        manifest = parseManifest(await first(start, start), start);
        filesDone = 1;
        entries = manifest.scripts.map((s) => dir + s);
        for (const e of entries) known.add(knownKey(e));
        const iconPath = isRelativeIconSpec(manifest.icon) ? importPath(start, /^\.\.?(\/|$)/.test(manifest.icon) ? manifest.icon : `./${manifest.icon}`) : null;
        if (iconPath) known.add(knownKey(iconPath));
        report(true);
        for (const e of entries) {
            await first(e, `${e}, listed in ${start}`);
            filesDone++;
            report(true);
        }
        if (iconPath && files[iconPath] === undefined) {
            const t = await get(iconPath);
            if (t !== null) files[iconPath] = t;
            else missing.push({ from: start, spec: manifest.icon! });
            filesDone++;
            report(entries.length > 0);
        }
    } else {
        await first(start, start);
        filesDone = 1;
    }
    const queue = [...entries];
    let bytes = Object.values(files).reduce((n, t) => n + t.length, 0);
    while (queue.length) {
        const from = queue.shift()!;
        if (isDataSpec(from)) continue;
        const iconSpec = metadataIconSpec(files[from]);
        const specs = [...importSpecs(files[from]), ...(iconSpec ? [/^\.\.?(\/|$)/.test(iconSpec) ? iconSpec : `./${iconSpec}`] : [])];
        const freshTargets = new Set<string>();
        for (const spec of specs) {
            if (isUrlSpec(spec) || builtinSpec(spec) || !/^\.\.?(\/|$)/.test(spec)) continue;
            const path = importPath(from, spec);
            if (path === null || candidates(path).some((c) => files[c] !== undefined)) continue;
            const k = knownKey(path);
            if (!known.has(k)) {
                known.add(k);
                freshTargets.add(k);
            }
        }
        if (freshTargets.size) report(true);
        for (const spec of specs) {
            if (isUrlSpec(spec) || builtinSpec(spec)) continue;
            if (!/^\.\.?(\/|$)/.test(spec)) {
                bare.push({ from, spec });
                continue;
            }
            const path = importPath(from, spec);
            const k = path !== null ? knownKey(path) : null;
            let found: string | null = null;
            for (const c of path === null ? [] : candidates(path)) {
                if (files[c] !== undefined) {
                    found = c;
                    break;
                }
                const t = await get(c);
                if (t === null) continue;
                if (Object.keys(files).length >= MAX_FILES) throw new Error(`a package holds at most ${MAX_FILES} files`);
                bytes += t.length;
                if (bytes > MAX_BYTES) throw new Error(`a package holds at most ${MAX_BYTES / 1024 / 1024} MB`);
                files[c] = t;
                queue.push(c);
                found = c;
                break;
            }
            if (found === null) missing.push({ from, spec });
            if (k && freshTargets.delete(k)) {
                filesDone++;
                report(queue.length > 0 || freshTargets.size > 0);
            }
        }
    }
    if (known.size > 1) report(false);
    // relative to the common folder
    const dirs = Object.keys(files).map((p) => p.split("/").slice(0, -1));
    let common = dirs[0];
    for (const d of dirs) {
        let i = 0;
        while (i < common.length && i < d.length && common[i] === d[i]) i++;
        common = common.slice(0, i);
    }
    const cut = common.length ? common.join("/").length + 1 : 0;
    const rel = (p: string) => p.slice(cut);
    if (manifest && cut !== dir.length) {
        const outside = Object.keys(files).filter((p) => !p.startsWith(dir));
        throw new Error(`${start}: the bundle's files must be in its folder — ${outside.join(", ")} ${outside.length > 1 ? "are" : "is"} outside it`);
    }
    return {
        entries: entries.map(rel),
        ...(manifest ? { manifest } : {}),
        files: Object.fromEntries(Object.entries(files).map(([p, t]) => [rel(p), t])),
        missing: missing.map((m) => ({ ...m, from: rel(m.from) })),
        bare: bare.map((b) => ({ ...b, from: rel(b.from) })),
    };
}

/** a hash of the package's files (the revision of a plain URL's package, and how edits are noticed) */
export async function hashText(text: string): Promise<string> {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function filesHash(files: Record<string, string>): Promise<string> {
    return hashText(
        Object.keys(files)
            .sort()
            .map((p) => `${p}\0${files[p]}`)
            .join("\0\0")
    );
}

/** read a source: its pinned files */
export async function fetchPackage(src: PackageSource, net: Net, onProgress?: (p: DownloadProgress) => void): Promise<CrawledPackage & { revision: string }> {
    const o = await openSource(src, net, onProgress);
    const c = await crawl(o.start, o.read, o.archived ? undefined : onProgress);
    return { ...c, revision: o.revision ?? (await filesHash(c.files)) };
}

async function fetchUrl(url: string, auth?: boolean): Promise<Response> {
    const r = await fetch(url, { cache: "no-store", credentials: auth ? "include" : "omit" });
    if (!auth && (r.status === 401 || r.status === 403 || r.status === 404) && /^https?:/i.test(url) && !/^https:\/\/api\.github\.com\//i.test(url)) {
        return fetch(url, { cache: "no-store", credentials: "include" });
    }
    return r;
}

/** the network through fetch (file:// through XHR, which extension pages may read) */
export const webNet: Net = {
    async text(url, auth) {
        if (url.startsWith("file:")) return readFileUrl(url);
        const r = await fetchUrl(url, auth);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.text();
    },
    async bytes(url, onBytes, auth) {
        if (url.startsWith("file:")) return readFileUrl(url, true);
        const r = await fetchUrl(url, auth);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        const len = Number(r.headers?.get?.("content-length") || 0);
        if (!onBytes || !r.body?.getReader) return r.arrayBuffer();
        const reader = r.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            onBytes(loaded, len > 0 ? len : undefined);
        }
        const out = new Uint8Array(loaded);
        let at = 0;
        for (const c of chunks) {
            out.set(c, at);
            at += c.byteLength;
        }
        return out.buffer;
    },
    async json(url) {
        const r = await fetch(url, { cache: "no-store", credentials: "omit", headers: { accept: "application/vnd.github+json" } });
        if (!r.ok) {
            const remaining = r.headers.get("x-ratelimit-remaining");
            throw new Error(remaining === "0" ? "GitHub's API rate limit is used up — try again in an hour" : `${url}: HTTP ${r.status}`);
        }
        return r.json();
    },
};

function readFileUrl(url: string): Promise<string | null>;
function readFileUrl(url: string, binary: true): Promise<ArrayBuffer | null>;
function readFileUrl(url: string, binary = false): Promise<any> {
    return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("GET", url);
        if (binary) x.responseType = "arraybuffer";
        x.onload = () => resolve(x.status === 0 || x.status === 200 ? (binary ? x.response : x.responseText) : null);
        // a missing file and no file access look the same: an error
        x.onerror = () => reject(new Error(`can't read ${url} — allow "Access to file URLs" for TangiTweak in the browser's extension settings, or install the folder instead`));
        x.send();
    });
}
