/** the background's package messages (see engine/packages) */
import type { Analysis, FetchedPackage } from "../../background/engine/packages";
import type { PackageStatus } from "../../shared/packageImports";
import type { InstalledPackage } from "../../shared/packageModel";
import { fetchPackage, parseSource, webNet, type CrawledPackage, type DownloadProgress } from "../../shared/packageSource";

export function send<T>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) =>
        chrome.runtime.sendMessage(msg, (r: any) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (r && typeof r === "object" && typeof r.error === "string") return reject(new Error(r.error));
            resolve(r as T);
        })
    );
}

export type Fetched = FetchedPackage & Pick<CrawledPackage, "missing" | "bare">;

/** read a package from its URL (GitHub, gist, any https or file: URL) */
export async function fetchFrom(source: string, onProgress?: (p: DownloadProgress) => void): Promise<Fetched> {
    const src = parseSource(source);
    if (typeof src === "string") throw new Error(src);
    const p = await fetchPackage(src, webNet, onProgress);
    return { source, entries: p.entries, files: p.files, revision: p.revision, missing: p.missing, bare: p.bare };
}

const plain = (f: Fetched): FetchedPackage => ({ source: f.source, entries: f.entries, files: f.files, revision: f.revision });

export const packagesApi = {
    list: () => send<Record<string, InstalledPackage>>({ type: "listPackages" }),
    analyze: (f: Fetched, updateOf?: string) => send<Analysis>({ type: "packageAnalyze", fetched: plain(f), updateOf }),
    packageStatus: (urls: string[]) => send<{ statuses?: Record<string, PackageStatus> }>({ type: "packageStatus", urls }),
    install: (f: Fetched, enabled: boolean, autoUpdate: boolean) => send<InstalledPackage>({ type: "packageInstall", fetched: plain(f), enabled, autoUpdate }),
    offer: (id: string, f: Fetched, manual: boolean) => send<InstalledPackage | null>({ type: "packageOffer", id, fetched: plain(f), manual }),
    check: (id?: string) => send<Record<string, InstalledPackage>>({ type: "packageCheck", id }),
    apply: (id: string) => send<InstalledPackage>({ type: "packageApply", id }),
    dismiss: (id: string) => send<void>({ type: "packageDismiss", id }),
    rollback: (id: string) => send<InstalledPackage>({ type: "packageRollback", id }),
    setAutoUpdate: (id: string, on: boolean) => send<void>({ type: "packageSetAutoUpdate", id, on }),
    forget: (id: string) => send<void>({ type: "packageForget", id }),
};

/** the stored texts of a package's files, by package path */
export async function installedTexts(pkg: InstalledPackage): Promise<Record<string, string>> {
    const [scripts, data] = await Promise.all([send<{ id: string; code: string }[]>({ type: "listScripts" }), send<{ id: string; text: string }[]>({ type: "listDataFiles" })]);
    const byId = new Map<string, string>();
    for (const s of scripts || []) byId.set(s.id, s.code);
    for (const d of data || []) byId.set(d.id, d.text);
    const out: Record<string, string> = {};
    for (const [rel, f] of Object.entries(pkg.files)) {
        const t = byId.get(f.id);
        if (t !== undefined) out[rel] = t;
    }
    return out;
}
