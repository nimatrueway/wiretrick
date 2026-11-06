/** installed packages (see shared/packageModel), kept live for the Explorer */
import { proxy, ref } from "valtio";
import { entryIds, PACKAGES_KEY, packageName, updateSource, type InstalledPackage } from "../../shared/packageModel";
import { parseSource, sourceLabel } from "../../shared/packageSource";
import { fetchFrom, packagesApi } from "../install/api";

export const packages = proxy({ byId: ref({} as Record<string, InstalledPackage>) as Readonly<Record<string, InstalledPackage>> });

/** the package a tree row belongs to: its folder, or one of its files */
export function packageOf(row: { kind: string; id: string; path: string }): InstalledPackage | undefined {
    const all = Object.values(packages.byId);
    if (row.kind === "folder") return all.find((p) => p.folder && p.folder === row.path);
    return all.find((p) => Object.values(p.files).some((f) => f.id === row.id));
}

/** the row that carries a package's badge: its folder, or (a single file) its entry */
export const badgeRowOf = (p: InstalledPackage): { folder: string } | { id: string } => (p.folder ? { folder: p.folder } : { id: entryIds(p)[0] });

const labelOf = (url: string) => {
    const src = parseSource(url);
    return typeof src === "string" ? url : sourceLabel(src);
};

export function packageTitle(p: InstalledPackage): string {
    const from = updateSource(p);
    return [
        `Package “${packageName(p)}”${p.metadata.version ? ` ${p.metadata.version}` : ""}`,
        p.source ? `from ${labelOf(p.source)}` : "installed from local files",
        from && from !== p.source ? `updates from ${labelOf(from)}` : "",
        p.pending ? "An update waits for your review — right-click → Review Update…" : "",
        p.lastError ? `Last update check failed: ${p.lastError}` : "",
        from ? (p.autoUpdate ? "Updates itself" : "Auto-update is off") : "",
    ]
        .filter(Boolean)
        .join("\n");
}

export const openInstallPage = (query = ""): void => void chrome.tabs.create({ url: chrome.runtime.getURL("install.html") + query });

/** packages installed from file: URLs: read again here (an extension page can read files; the background can't) */
let lastLocalCheck = 0;
async function recheckLocal(): Promise<void> {
    if (Date.now() - lastLocalCheck < 5000) return;
    lastLocalCheck = Date.now();
    for (const p of Object.values(packages.byId)) {
        const from = updateSource(p);
        if (!p.autoUpdate || !/^file:/i.test(from)) continue;
        try {
            const fetched = { ...(await fetchFrom(from)), source: p.source };
            if (fetched.revision !== p.revision && fetched.revision !== p.skipped && fetched.revision !== p.pending?.revision) await packagesApi.offer(p.id, fetched, false);
        } catch {
            // moved or unreadable: the next focus tries again
        }
    }
}

export function watchPackages(): void {
    const apply = (v: Record<string, InstalledPackage> | undefined) => (packages.byId = ref({ ...(v || {}) } as Record<string, InstalledPackage>));
    chrome.storage.local.get(PACKAGES_KEY, (d) => {
        apply(d?.[PACKAGES_KEY]);
        void recheckLocal();
    });
    chrome.storage.onChanged.addListener((c, area) => {
        if (area === "local" && c[PACKAGES_KEY]) apply(c[PACKAGES_KEY].newValue);
    });
    window.addEventListener("focus", () => void recheckLocal());
}
