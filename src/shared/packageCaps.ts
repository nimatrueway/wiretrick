/**
 * What a package can do, read off its entries' compiled routes and metadata:
 * the install page shows it, and an update that can do more than the
 * installed version waits for approval instead of applying itself.
 */
import type { ResMeta } from "./metaParser";
import { isUrlSpec, parsePackageUrl } from "./packageImports";
import { importSpecs } from "./scriptImports";

export interface Capabilities {
    /** URL patterns its handlers run on */
    urls: string[];
    /** network strategies it intercepts with */
    strategies: string[];
    /** onPage code in the site's own JavaScript world */
    pageJs: boolean;
    /** draws an overlay */
    overlay: boolean;
    /** an overlay whose code runs in the site's world (`unsafe: true`) */
    unsafe: boolean;
    /** hosts its wt.fetch reaches, as its metadata declares (`connect`) */
    connect: string[];
    /** unpkg packages it imports (names) */
    packages: string[];
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function capabilitiesOf(routes: ResMeta["routes"], connect: string[], codes: string[]): Capabilities {
    const packages: string[] = [];
    for (const code of codes)
        for (const spec of importSpecs(code)) {
            if (!isUrlSpec(spec)) continue;
            const p = parsePackageUrl(spec);
            if (typeof p !== "string") packages.push(p.name);
        }
    return {
        urls: sorted(routes.flatMap((r) => r.url)),
        strategies: sorted(routes.flatMap((r) => (r.strategy ? [r.strategy] : []))),
        pageJs: routes.some((r) => r.kind === "onDocument" && r.world !== "isolated"),
        overlay: routes.some((r) => r.kind === "onOverlay"),
        unsafe: routes.some((r) => r.kind === "onOverlay" && r.world === "page"),
        connect: sorted(connect),
        packages: sorted(packages),
    };
}

const ALL_URLS = /^(<all_urls>|\*:\/\/\*\/\*|\*:\/\/\*(:\*)?\/\*|https?\*?:\/\/\*\/\*|\*)$/;

/** a pattern that matches every site */
export const isAllUrls = (pattern: string): boolean => ALL_URLS.test(pattern.trim());

export type Risk = "high" | "medium" | "low";

/** the capabilities, as lines for people, riskiest first */
export function describeCapabilities(c: Capabilities): { text: string; risk: Risk }[] {
    const out: { text: string; risk: Risk }[] = [];
    if (c.urls.some(isAllUrls)) out.push({ text: "Runs on every site", risk: "high" });
    if (c.unsafe) out.push({ text: "Overlay code runs in the site's own JavaScript (unsafe: true): the site can see and call into it", risk: "high" });
    if (c.strategies.includes("debugger")) out.push({ text: 'Intercepts with the browser debugger (strategy "debugger": a banner shows on the tab)', risk: "high" });
    if (c.pageJs) out.push({ text: "Runs code in the site's own JavaScript world", risk: "medium" });
    if (c.strategies.includes("helper")) out.push({ text: 'Intercepts through the local helper process (strategy "helper")', risk: "medium" });
    const sites = c.urls.filter((u) => !isAllUrls(u));
    if (sites.length) out.push({ text: `Runs on ${sites.join(", ")}`, risk: "low" });
    const nets = c.strategies.filter((s) => s !== "debugger" && s !== "helper");
    if (nets.length) out.push({ text: `Intercepts requests (${nets.join(", ")})`, risk: "low" });
    if (c.overlay && !c.unsafe) out.push({ text: "Draws an overlay over pages", risk: "low" });
    if (c.connect.length) out.push({ text: `Connects to ${c.connect.join(", ")}`, risk: "low" });
    if (c.packages.length) out.push({ text: `Imports ${c.packages.join(", ")} from unpkg`, risk: "low" });
    if (!out.length) out.push({ text: "Registers no handlers (a library)", risk: "low" });
    const rank: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.risk] - rank[b.risk]);
}

/** what `next` can do that `prev` couldn't (empty: same or less) */
export function addedCapabilities(prev: Capabilities, next: Capabilities): string[] {
    const out: string[] = [];
    const prevAll = prev.urls.some(isAllUrls);
    const urls = prevAll ? [] : next.urls.filter((u) => !prev.urls.includes(u));
    if (urls.length) out.push(`runs on ${urls.join(", ")}`);
    const strategies = next.strategies.filter((s) => !prev.strategies.includes(s));
    if (strategies.length) out.push(`intercepts with ${strategies.join(", ")}`);
    if (next.pageJs && !prev.pageJs) out.push("runs code in the site's own JavaScript world");
    if (next.overlay && !prev.overlay) out.push("draws an overlay");
    if (next.unsafe && !prev.unsafe) out.push("runs overlay code in the site's world (unsafe)");
    const connect = next.connect.filter((h) => !prev.connect.includes(h));
    if (connect.length) out.push(`connects to ${connect.join(", ")}`);
    const packages = next.packages.filter((p) => !prev.packages.includes(p));
    if (packages.length) out.push(`imports ${packages.join(", ")}`);
    return out;
}
