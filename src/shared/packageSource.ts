/**
 * Where a package comes from, and reading its files: the install page
 * (first install, local files) and the background (updates) share this.
 *
 * A package is an entry file (`*.wiretrick.ts`) plus every file it
 * imports by a relative path, followed transitively. Sources:
 *   - GitHub: a file (`github.com/o/r/blob/ref/x.wiretrick.ts`,
 *     `raw.githubusercontent.com/o/r/ref/…`) or a folder holding one entry
 *     (`github.com/o/r/tree/ref/dir`, `github.com/o/r`); pinned to the
 *     commit the ref points at
 *   - gist: `gist.github.com/user/id` (its one `*.wiretrick.ts` file),
 *     pinned to the gist's revision
 *   - any other http(s) or file:// URL of the entry; its imports are
 *     fetched next to it
 */
import { builtinSpec } from "./builtinSpecs";
import { isUrlSpec } from "./packageImports";
import { importPath, importSpecs, isDataSpec } from "./scriptImports";

export type PackageSource =
    | { kind: "github"; owner: string; repo: string; ref: string; path: string; tree: boolean }
    | { kind: "gist"; id: string; file?: string }
    | { kind: "url"; url: string };

/** a URL that installs as a package when opened in a tab */
export const ENTRY_URL_RE = /^(https?|file):\/\/[^?#]*\.wiretrick\.tsx?([?#]|$)/i;

/** an entry file's name */
export const ENTRY_FILE_RE = /\.wiretrick\.tsx?$/i;

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
        if (!ENTRY_FILE_RE.test(u.pathname)) return "the URL must end in .wiretrick.ts (the package's entry file)";
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
export const isRemote = (src: PackageSource): boolean => src.kind !== "url" || /^https?:/i.test(src.url);

/** how the reader gets at the network: text of a URL (null: not found), and JSON */
export interface Net {
    text(url: string): Promise<string | null>;
    json(url: string): Promise<any>;
}

/** a source, opened: where its entry is, how to read a path, and the revision it's pinned to */
export interface OpenedSource {
    /** the entry's path, relative to the source's root */
    entry: string;
    read(path: string): Promise<string | null>;
    /** commit / gist revision; undefined: the files' hash (crawl result) */
    revision?: string;
}

const GITHUB_API = "https://api.github.com";

export async function openSource(src: PackageSource, net: Net): Promise<OpenedSource> {
    if (src.kind === "github") {
        const base = `${GITHUB_API}/repos/${src.owner}/${src.repo}`;
        const commit = await net.json(`${base}/commits/${encodeURIComponent(src.ref)}`);
        const sha: string | undefined = commit?.sha;
        if (!sha) throw new Error(`no commit for "${src.ref}" in ${src.owner}/${src.repo}`);
        let entry = src.path;
        if (src.tree) {
            const tree = await net.json(`${base}/git/trees/${sha}?recursive=1`);
            const dir = src.path.replace(/\/$/, "");
            const entries = ((tree?.tree ?? []) as { path: string; type: string }[])
                .filter((t) => t.type === "blob" && ENTRY_FILE_RE.test(t.path) && t.path.slice(0, t.path.lastIndexOf("/") + 1) === (dir ? dir + "/" : ""))
                .map((t) => t.path);
            if (entries.length !== 1)
                throw new Error(
                    entries.length
                        ? `${dir || "the repository"} holds ${entries.length} entry files (${entries.join(", ")}) — open the one to install`
                        : `no *.wiretrick.ts file in ${dir || "the repository's root"}`
                );
            entry = entries[0];
        }
        const raw = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${sha}/`;
        return { entry, revision: sha, read: (p) => net.text(raw + p.split("/").map(encodeURIComponent).join("/")) };
    }
    if (src.kind === "gist") {
        const g = await net.json(`${GITHUB_API}/gists/${src.id}`);
        const files: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> = g?.files ?? {};
        const names = Object.keys(files);
        let entry = src.file;
        if (!entry || !files[entry]) {
            const entries = names.filter((n) => ENTRY_FILE_RE.test(n));
            if (entries.length !== 1)
                throw new Error(entries.length ? `the gist holds ${entries.length} entry files (${entries.join(", ")}) — open the raw URL of the one to install` : "the gist has no *.wiretrick.ts file");
            entry = entries[0];
        }
        const revision: string | undefined = g?.history?.[0]?.version;
        return {
            entry,
            revision,
            read: async (p) => {
                const f = files[p];
                if (!f) return null;
                return f.truncated || f.content === undefined ? (f.raw_url ? net.text(f.raw_url) : null) : f.content;
            },
        };
    }
    // a plain URL: paths are from its origin's root, so `../` imports work
    const u = new URL(src.url);
    const origin = u.protocol === "file:" ? "file://" : u.origin;
    return {
        entry: decodeURIComponent(u.pathname.replace(/^\//, "")),
        read: (p) => net.text(`${origin}/${p.split("/").map(encodeURIComponent).join("/")}`),
    };
}

/** a package's files as read, before they're laid out in the Explorer */
export interface CrawledPackage {
    /** the entry's path in `files` */
    entry: string;
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

/** read the entry and everything it imports by relative path; paths come out relative to the files' common folder */
export async function crawl(entry: string, read: (path: string) => Promise<string | null>): Promise<CrawledPackage> {
    const files: Record<string, string> = {};
    const cache = new Map<string, Promise<string | null>>();
    const get = (p: string) => {
        if (!cache.has(p)) cache.set(p, read(p).catch(() => null));
        return cache.get(p)!;
    };
    const missing: CrawledPackage["missing"] = [];
    const bare: CrawledPackage["bare"] = [];
    // the entry's read error says why (no file access, rate limit…)
    const text = await read(entry);
    if (text === null) throw new Error(`can't read ${entry}`);
    cache.set(entry, Promise.resolve(text));
    files[entry] = text;
    const queue = [entry];
    let bytes = text.length;
    while (queue.length) {
        const from = queue.shift()!;
        if (isDataSpec(from)) continue;
        for (const spec of importSpecs(files[from])) {
            if (isUrlSpec(spec) || builtinSpec(spec)) continue;
            if (!/^\.\.?(\/|$)/.test(spec)) {
                bare.push({ from, spec });
                continue;
            }
            const path = importPath(from, spec);
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
        }
    }
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
    return {
        entry: rel(entry),
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
export async function fetchPackage(src: PackageSource, net: Net): Promise<CrawledPackage & { revision: string }> {
    const o = await openSource(src, net);
    const c = await crawl(o.entry, o.read);
    return { ...c, revision: o.revision ?? (await filesHash(c.files)) };
}

/** the network through fetch (file:// through XHR, which extension pages may read) */
export const webNet: Net = {
    async text(url) {
        if (url.startsWith("file:")) return readFileUrl(url);
        const r = await fetch(url, { cache: "no-store", credentials: "omit" });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.text();
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

function readFileUrl(url: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("GET", url);
        x.onload = () => resolve(x.status === 0 || x.status === 200 ? x.responseText : null);
        // a missing file and no file access look the same: an error
        x.onerror = () => reject(new Error(`can't read ${url} — allow "Access to file URLs" for Wiretrick in the browser's extension settings, or install the folder instead`));
        x.send();
    });
}
