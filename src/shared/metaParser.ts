/**
 * Script metadata types. The ONLY way to declare a script is
 * wt.declareScript({...}) — a source file without it is a library module:
 * inert on its own (never matches, never listed in the popup) but
 * importable by other scripts.
 */

export type Phase = "request" | "response";
export type Strategy = "auto" | "hook" | "cdp" | "webrequest" | "process";

/**
 * strategy accepts a priority list, e.g.
 *   ["hook", "cdp"]   (try the page hook first, then the debugger)
 *   ["cdp"]           (debugger only)
 *   ["auto"]          (engine default: hook, then cdp)
 *   ["process"]       (local helper proxy — Chrome, opt-in, no banner)
 */
export type StrategyList = Strategy[];

export function parseStrategyList(raw: string | StrategyList | undefined): StrategyList {
    if (!raw) return ["auto"];
    if (Array.isArray(raw)) return raw;
    const out = raw
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x): x is Strategy => VALID_STRATEGIES.includes(x as Strategy));
    return out.length ? out : ["auto"];
}

const VALID_STRATEGIES: Strategy[] = ["auto", "hook", "cdp", "webrequest", "process"];

/** strategy names a script lists that the engine doesn't know (ignored) */
export function unknownStrategies(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x && !VALID_STRATEGIES.includes(x as Strategy));
}

export interface ResMeta {
    name: string;
    match: string[];
    include: string[];
    phase: Phase[];
    /** raw strategy value (comma-separated list) */
    strategy: string;
    runAt: string;
    /** true once wt.declareScript ran — undeclared sources are libraries */
    declared: boolean;
}

export const DEFAULT_META: ResMeta = {
    name: "Untitled script",
    match: [],
    include: [],
    phase: ["request", "response"],
    strategy: "auto",
    runAt: "document_start",
    declared: false,
};

/** Fresh default meta with a fallback display name (e.g. the file name). */
export function defaultMeta(name?: string): ResMeta {
    return { ...DEFAULT_META, match: [], include: [], phase: [...DEFAULT_META.phase], name: name || DEFAULT_META.name };
}
