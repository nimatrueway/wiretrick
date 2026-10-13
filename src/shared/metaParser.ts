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

export interface ResMeta {
    name: string;
    match: string[];
    include: string[];
    phase: Phase[];
    strategy: Strategy;
    runAt: string;
    /** false (via `@mainframes off`) = never intercept main-frame HTML (no debugger banner) */
    mainFrames: boolean;
}

export const DEFAULT_META: ResMeta = {
    name: "Untitled script",
    match: [],
    include: [],
    phase: ["request", "response"],
    strategy: "auto",
    runAt: "document_start",
    mainFrames: true,
};

const VALID_PHASES: Phase[] = ["request", "response"];
const VALID_STRATEGIES: Strategy[] = ["auto", "hook", "proxy", "cdp", "webrequest"];

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
                const s = value.toLowerCase() as Strategy;
                if (VALID_STRATEGIES.includes(s)) meta.strategy = s;
            }
            if (key === "mainframes") {
                meta.mainFrames = value.toLowerCase() !== "off";
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
            case "strategy": {
                const s = value.toLowerCase() as Strategy;
                if (VALID_STRATEGIES.includes(s)) meta.strategy = s;
                break;
            }
            case "run-at":
                meta.runAt = value;
                break;
            case "mainframes":
                meta.mainFrames = value.toLowerCase() !== "off";
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
