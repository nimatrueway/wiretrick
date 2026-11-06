/** a package from local files (a chosen folder or a .zip) */
import { crawl, filesHash, type CrawledPackage } from "./packageSource";

export { isPackageFile, unzipPackage } from "./packageSource";

/** the scripts and bundles (metadata.json) a set of files has, shallowest first (a folder's own before its subfolders') */
export function startsIn(paths: string[]): string[] {
    const depth = (p: string) => p.split("/").length;
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
    const bundles = new Set(paths.filter((p) => /(^|\/)metadata\.json$/i.test(p)).map(dirOf));
    // a bundle's own scripts install with it, not alone
    const inBundle = (p: string) => [...bundles].some((d) => p.startsWith(d));
    return paths
        .filter((p) => /(^|\/)metadata\.json$/i.test(p) || (/\.tsx?$/i.test(p) && !/\.d\.ts$/i.test(p) && !inBundle(p)))
        .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** an entry or metadata.json and what it brings, out of `files` */
export async function localPackage(files: Record<string, string>, start: string): Promise<CrawledPackage & { revision: string }> {
    const c = await crawl(start, async (p) => files[p] ?? null);
    return { ...c, revision: await filesHash(c.files) };
}
