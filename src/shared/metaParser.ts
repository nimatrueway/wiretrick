/**
 * ==ResScript== metadata block parser.
 *
 * // ==ResScript==
 * // @name       Mock /api/user
 * // @match      *://app.example.com/*
 * // @phase      request,response
 * // @strategy   auto
 * // ==/ResScript==
 */

export type Phase = "request" | "response";
export type Strategy = "auto" | "hook" | "proxy" | "cdp" | "webrequest";

/**
 * @strategy accepts a comma-separated priority list, e.g.
 *   @strategy hook,cdp       (try the page hook first, then the debugger)
 *   @strategy cdp            (debugger only)
 *   @strategy auto           (engine default: hook → proxy → cdp)
 * A single name is just a one-element list.
 */
export type StrategyList = Strategy[];

export function parseStrategyList(raw: string | StrategyList | undefined): StrategyList {
    if (!raw) return ["auto"];
    if (Array.isArray(raw)) return raw;
    const valid: Strategy[] = ["auto", "hook", "proxy", "cdp", "webrequest"];
    const out = raw
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x): x is Strategy => valid.includes(x as Strategy));
    return out.length ? out : ["auto"];
}

export interface ResMeta {
    name: string;
    match: string[];
    include: string[];
    phase: Phase[];
    /** raw @strategy value (comma-separated list) */
    strategy: string;
    runAt: string;
}

export const DEFAULT_META: ResMeta = {
    name: "Untitled script",
    match: [],
    include: [],
    phase: ["request", "response"],
    strategy: "auto",
    runAt: "document_start",
};

const VALID_PHASES: Phase[] = ["request", "response"];
const VALID_STRATEGIES: Strategy[] = ["auto", "hook", "proxy", "cdp", "webrequest"];

function sanitizeStrategyList(raw: string): string {
    const parts = parseStrategyList(raw).filter((x) => VALID_STRATEGIES.includes(x));
    return parts.length ? parts.join(",") : "auto";
}

export function parseMeta(code: string): ResMeta {
    const meta: ResMeta = { ...DEFAULT_META, match: [], include: [], phase: [] };

    const blockMatch = code.match(/\/\/\s*==ResScript==\s*\n([\s\S]*?)\/\/\s*==\/ResScript==/);
    if (!blockMatch) {
        // No metadata block: still honor bare `// @key value` directives so
        // lightweight scripts work, and derive a name from the first line.
        const firstLine = code.trim().split("\n")[0] || "";
        const firstRaw = firstLine.replace(/^\/\/\s*/, "");
        if (firstRaw && !firstRaw.startsWith("@")) {
            meta.name = firstRaw.slice(0, 60) || meta.name;
        }
        const lines = code.split("\n").filter((l) => !/^\s*\/\//.test(l) || /^\s*\/\/\s*@\S+/.test(l));
        for (const line of lines) {
            const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.*)$/);
            if (!m) continue;
            const key = m[1].toLowerCase();
            const value = m[2].trim();
            if (key === "match" && value) meta.match.push(value);
            if (key === "include" && value) meta.include.push(value);
            if (key === "name" && value) meta.name = value;
            if (key === "phase") {
                for (const p of value.split(",")) {
                    const ph = p.trim().toLowerCase() as Phase;
                    if (VALID_PHASES.includes(ph) && !meta.phase.includes(ph)) {
                        meta.phase.push(ph);
                    }
                }
            }
            if (key === "strategy") {
                meta.strategy = sanitizeStrategyList(value);
            }
        }
        if (meta.phase.length === 0) {
            meta.phase = [...DEFAULT_META.phase];
        }
        return meta;
    }

    const lines = blockMatch[1].split("\n");
    for (const line of lines) {
        const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        switch (key) {
            case "name":
                meta.name = value;
                break;
            case "match":
                if (value) meta.match.push(value);
                break;
            case "include":
                if (value) meta.include.push(value);
                break;
            case "phase": {
                for (const p of value.split(",")) {
                    const ph = p.trim().toLowerCase() as Phase;
                    if (VALID_PHASES.includes(ph) && !meta.phase.includes(ph)) {
                        meta.phase.push(ph);
                    }
                }
                break;
            }
            case "strategy":
                meta.strategy = sanitizeStrategyList(value);
                break;
            case "run-at":
                meta.runAt = value;
                break;
            default:
                // unknown keys are ignored for forward compatibility
                break;
        }
    }

    if (meta.phase.length === 0) {
        meta.phase = [...DEFAULT_META.phase];
    }
    return meta;
}
