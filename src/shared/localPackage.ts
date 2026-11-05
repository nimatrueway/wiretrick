/** a package from local files (a chosen folder or a .zip) */
import { crawl, ENTRY_FILE_RE, filesHash, type CrawledPackage } from "./packageSource";

/** the files a package can use */
export const isPackageFile = (path: string): boolean => /\.(tsx?|json|svg)$/i.test(path) && !/(^|\/)(node_modules|\.git)\//.test(path);

/** the entries a set of files has, shallowest first (a folder's own entry before its subfolders') */
export function entriesIn(paths: string[]): string[] {
    const depth = (p: string) => p.split("/").length;
    return paths.filter((p) => ENTRY_FILE_RE.test(p)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** `entry` and what it imports, out of `files` */
export async function localPackage(files: Record<string, string>, entry: string): Promise<CrawledPackage & { revision: string }> {
    const c = await crawl(entry, async (p) => files[p] ?? null);
    return { ...c, revision: await filesHash(c.files) };
}
