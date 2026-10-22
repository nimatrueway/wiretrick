/**
 * One-time rewrite of scripts and settings.yaml written for the old script
 * API names (pure functions; the background runner is
 * background/migration.ts). There are no runtime aliases: anything this
 * misses (or a script pasted later) fails to compile against the current
 * wt-api.d.ts.
 *
 * Accepted risk: the rewrite is regex based, not syntax aware. In a script
 * that uses `wt.`, every `cancel:` becomes `block:` and every `types:`
 * becomes `resourceTypes:` — also an unrelated object key of that name
 * outside a handler route/result (rare in interception scripts; the
 * original is kept as a backup and the change is logged).
 */
import { globalOptionLines, defaultStrategySetting, type GlobalSettings } from "./settingsYaml";

/** bumped when a new rewrite is added */
export const MIGRATION_VERSION = 1;

/** old strategy value → current one */
export const OLD_STRATEGIES: Record<string, string> = { process: "helper", cdp: "debugger", hook: "page", webrequest: "webRequest" };

/** an old strategy value mapped to the current name; anything else unchanged */
export function mapStrategy(v: string): string {
    return OLD_STRATEGIES[v] ?? v;
}

export interface ScriptMigration {
    code: string;
    /** human-readable list of what changed ("wt.describe → wt.about", …); empty: untouched */
    changes: string[];
}

/** Rewrite a script's source to the current API names. Only scripts that use `wt.` are touched. */
export function migrateScriptSource(code: string): ScriptMigration {
    if (!/\bwt\./.test(code)) return { code, changes: [] };
    const changes: string[] = [];
    const rule = (re: RegExp, to: string | ((...m: string[]) => string), label: string | ((m: string[]) => string)): void => {
        code = code.replace(re, (...m: any[]) => {
            const l = typeof label === "string" ? label : label(m);
            if (!changes.includes(l)) changes.push(l);
            return typeof to === "string" ? to : to(...m);
        });
    };
    rule(/\bwt\.describe\b/g, "wt.about", "wt.describe → wt.about");
    rule(/\bwt\.modifyResponse\b/g, "wt.onResponseBody", "wt.modifyResponse → wt.onResponseBody");
    rule(
        /\b(strategy\s*:\s*)(["'`])(process|cdp|hook|webrequest)\2/g,
        (_m, pre, q, v) => `${pre}${q}${OLD_STRATEGIES[v]}${q}`,
        (m) => `strategy "${m[3]}" → "${OLD_STRATEGIES[m[3]]}"`
    );
    rule(/\bcancel(\s*):/g, (_m, sp) => `block${sp}:`, "cancel: → block:");
    rule(/\btypes(\s*):/g, (_m, sp) => `resourceTypes${sp}:`, "types: → resourceTypes:");
    return { code, changes };
}

const OLD_DOC_START = /^(\s*)# Interception strategy for every handler/;
/** comment lines of the old generated strategy documentation (after its first line) */
const OLD_DOC_LINE = /^\s*#\s*(An unavailable strategy|Compatibility:|\s*(process|hook|webrequest|cdp):|(process|hook|webrequest|cdp)( \| \w+)+\s*$|strategy:|default:\s*["']?(process|hook|webrequest|cdp)\b)/;
/** the old block lists the old strategy names (the current one starts the same) */
const OLD_DOC_NAMES = /^\s*#\s+(process|hook|webrequest|cdp):/;
const LIVE_KEY = /^(\s+)strategy(\s*:)(.*)$/;
const COMMENTED_KEY = /^(\s*#\s*)strategy(\s*:)(.*)$/;

/** old strategy names in a YAML value (before any trailing comment) */
function mapValue(rest: string): string {
    const hash = rest.search(/\s#/);
    const v = hash < 0 ? rest : rest.slice(0, hash);
    const tail = hash < 0 ? "" : rest.slice(hash);
    return v.replace(/\b(process|cdp|hook|webrequest)\b/g, (n) => OLD_STRATEGIES[n]) + tail;
}

/**
 * settings.yaml: `settings.strategy` → `settings.defaultStrategy` (value
 * mapped). The generated strategy documentation above it is regenerated
 * (it names the old strategies); everything else — other comments, order,
 * formatting — is kept. Flow-style `settings: { … }` is left alone.
 */
export function migrateSettingsText(text: string): string {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    let inSettings = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^[^\s#]/.test(line)) inSettings = /^settings\s*:\s*(#.*)?$/.test(line);
        if (!inSettings) {
            out.push(line);
            continue;
        }
        const doc = OLD_DOC_START.exec(line);
        let j = i + 1;
        while (doc && j < lines.length && OLD_DOC_LINE.test(lines[j])) j++;
        if (doc && lines.slice(i + 1, j).some((l) => OLD_DOC_NAMES.test(l))) {
            // the old generated block: description lines, optional live entry
            let value: string | undefined;
            const live = j < lines.length ? LIVE_KEY.exec(lines[j]) : null;
            if (live && live[1] === doc[1]) {
                value = mapValue(live[3].replace(/\s#.*$/, "")).trim().replace(/^["']|["']$/g, "");
                j++;
            }
            const g = { defaultStrategy: value ?? defaultStrategySetting() } as GlobalSettings;
            out.push(...globalOptionLines("defaultStrategy", g).map((l) => doc[1] + l));
            i = j - 1;
            continue;
        }
        const live = LIVE_KEY.exec(line);
        if (live) {
            out.push(`${live[1]}defaultStrategy${live[2]}${mapValue(live[3])}`);
            continue;
        }
        const commented = COMMENTED_KEY.exec(line);
        if (commented) {
            out.push(`${commented[1]}defaultStrategy${commented[2]}${mapValue(commented[3])}`);
            continue;
        }
        out.push(line);
    }
    return out.join(eol);
}
