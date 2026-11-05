/**
 * Installed packages: a script, or a bundle of scripts (a folder with a
 * metadata.json listing them), with the files they import — installed from
 * a URL, a GitHub repository, a gist or a local folder and recorded so it
 * updates, all files together, from where it came from. The files themselves are ordinary
 * scripts and data files; the record maps each package file to the store
 * item it became (by id: params, stores and the enabled state survive an
 * update) and the hash it had, to tell when the user changed it.
 */
import type { Capabilities } from "./packageCaps";
import type { PackageMetadata } from "./packageMetadata";
import { ENTRY_FILE_RE } from "./packageSource";
import { scriptFileKey } from "./scriptName";

export const PACKAGES_KEY = "wtPackages";

/** what a package is at one revision: its files' texts */
export interface PackageVersion {
    revision: string;
    /** its entries' paths among `files` (a bundle: its metadata.json's scripts) */
    entries: string[];
    files: Record<string, string>;
    metadata: PackageMetadata;
    caps: Capabilities;
}

export interface InstalledFile {
    kind: "script" | "data";
    id: string;
    /** the script name / data file path it was installed as */
    name: string;
    /** of the text installed */
    hash: string;
}

export interface PendingUpdate extends PackageVersion {
    /** why it didn't apply itself (wider capabilities, files changed here, auto-update off, a lower version) */
    reasons: string[];
    /** what it can do that the installed version can't */
    added: string[];
    at: number;
}

export interface InstalledPackage {
    id: string;
    /** the source URL as given (parseSource reads it) */
    source: string;
    /** the folder its files went into; "" = the root (a single file) */
    folder: string;
    entries: string[];
    revision: string;
    metadata: PackageMetadata;
    caps: Capabilities;
    files: Record<string, InstalledFile>;
    autoUpdate: boolean;
    installedAt: number;
    updatedAt: number;
    lastChecked?: number;
    lastError?: string;
    pending?: PendingUpdate;
    /** a revision the user skipped ("Skip this version"): checks don't offer it again */
    skipped?: string;
    /** the version before the last update (Roll back) */
    previous?: PackageVersion;
}

export const isDataPath = (rel: string): boolean => /\.(json|svg)$/i.test(rel);

const join = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);

/** the store item a package file becomes: scripts drop `.ts` (`.tsx` stays), data files keep their path */
export function storeItemOf(folder: string, rel: string): { kind: "script" | "data"; name: string } {
    if (isDataPath(rel)) return { kind: "data", name: join(folder, rel) };
    return { kind: "script", name: join(folder, rel).replace(/\.ts$/i, "") };
}

/** an entry's file name without `.wiretrick.ts` */
export const entryStem = (entry: string): string => entry.replace(/^.*\//, "").replace(ENTRY_FILE_RE, "").replace(/\.tsx?$/i, "");

/** a package's display name: its metadata's name, else its (first) entry's file name without `.wiretrick.ts` */
export function packageName(p: { entries: string[]; metadata: Pick<PackageMetadata, "name"> }): string {
    return p.metadata.name || entryStem(p.entries[0] ?? "") || "package";
}

/** the store id of a package's entries */
export const entryIds = (p: Pick<InstalledPackage, "entries" | "files">): string[] => p.entries.flatMap((e) => (p.files[e] ? [p.files[e].id] : []));

/**
 * Where a package installs: a single file at the root, more in a folder
 * named after the bundle (its metadata.json's name) or the entry
 * (`dark.wiretrick.ts` → `dark/`), then `dark (2)/`… past what's `taken`
 * — script names, data paths and folders.
 */
export function packageFolder(p: { entries: string[]; files: Record<string, string>; bundleName?: string }, taken: string[]): string {
    if (Object.keys(p.files).length === 1) return "";
    const stem = (p.bundleName || entryStem(p.entries[0] ?? "")).replace(/[\\/:*?"<>|]+/g, "-").replace(/^[\s.]+|[\s.]+$/g, "") || "package";
    const keys = new Set(taken.map((t) => scriptFileKey(t.split("/")[0])));
    if (!keys.has(scriptFileKey(stem))) return stem;
    for (let i = 2; ; i++) if (!keys.has(scriptFileKey(`${stem} (${i})`))) return `${stem} (${i})`;
}

/** a root single-file entry's name past the `taken` ones: `x.wiretrick` → `x (2).wiretrick` (still an entry) */
export function uniqueEntryName(name: string, taken: string[]): string {
    const keys = new Set(taken.map(scriptFileKey));
    if (!keys.has(scriptFileKey(name))) return name;
    const m = /^(.*?)(\.wiretrick(?:\.tsx)?)?$/i.exec(name)!;
    for (let i = 2; ; i++) {
        const next = `${m[1]} (${i})${m[2] ?? ""}`;
        if (!keys.has(scriptFileKey(next))) return next;
    }
}

/** the package files whose store item is gone, renamed or edited since it was installed */
export function modifiedFiles(pkg: Pick<InstalledPackage, "files">, current: (f: InstalledFile) => { name: string; hash: string } | undefined): string[] {
    const out: string[] = [];
    for (const [rel, f] of Object.entries(pkg.files)) {
        const cur = current(f);
        if (!cur || cur.name !== f.name || cur.hash !== f.hash) out.push(rel);
    }
    return out.sort();
}
