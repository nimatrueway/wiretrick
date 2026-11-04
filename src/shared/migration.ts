/**
 * One-time rewrite of scripts and settings.yaml written for the old script
 * API names (pure functions; the background runner is
 * background/migration.ts). There are no runtime aliases: anything this
 * misses (or a script pasted later) fails to compile against the current
 * wt-api.d.ts. Every rewrite is idempotent, so a profile at any older
 * version gets all of them (v1 and v2) in one pass.
 *
 * v1: process/cdp/hook/webrequest strategies → helper/debugger/page/…,
 *     wt.describe → wt.about, wt.modifyResponse → wt.onResponseBody,
 *     cancel: → block:, types: → resourceTypes:.
 * v2: strategy webRequest → extension, wt.onDom → wt.onDocument, the
 *     onRequest result `respond:` → `replaceResponse:` (and the renamed
 *     Wiretrick.* types), onDocument `when: "DOMContentLoaded"` →
 *     `when: "document_end"` (same timing; only after `when:`, so
 *     `addEventListener("DOMContentLoaded", …)` is left alone).
 * v3: settings `defaultStrategy` (and v0's `strategy`) removed — every
 *     handler names its own strategy. Scripts aren't rewritten: a handler
 *     without one fails to load and shows in Problems.
 *
 * Accepted risk: the rewrite is regex based, not syntax aware. In a script
 * that uses `wt.`, every `cancel:` becomes `block:`, every `types:` becomes
 * `resourceTypes:`, every `respond:` becomes `replaceResponse:` (also a
 * `cond ? respond : x` ternary) and every "webRequest" string literal
 * becomes "extension" — also an unrelated object key or string of that
 * name outside a handler route/result (rare in interception scripts; the
 * original is kept as a backup and the change is logged). A shorthand
 * `{ respond }` result isn't recognized.
 */
/** bumped when a new rewrite is added */
export const MIGRATION_VERSION = 4;

/** old strategy value → current one */
export const OLD_STRATEGIES: Record<string, string> = { process: "helper", cdp: "debugger", hook: "page", webrequest: "extension", webRequest: "extension" };

/** an old strategy value mapped to the current name; anything else unchanged */
export function mapStrategy(v: string): string {
    return OLD_STRATEGIES[v] ?? v;
}

/** renamed Wiretrick.* types (v2) */
const OLD_TYPES: Record<string, string> = {
    RespondOptions: "ReplacementOptions",
    DomRouteOptions: "DocumentRouteOptions",
    DomRoute: "DocumentRoute",
    DomOptions: "DocumentOptions",
};

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
    // v1
    rule(/\bwt\.describe\b/g, "wt.about", "wt.describe → wt.about");
    rule(/\bwt\.modifyResponse\b/g, "wt.onResponseBody", "wt.modifyResponse → wt.onResponseBody");
    rule(
        /\b(strategy\s*:\s*)(["'`])(process|cdp|hook|webrequest)\2/g,
        (_m, pre, q, v) => `${pre}${q}${OLD_STRATEGIES[v]}${q}`,
        (m) => `strategy "${m[3]}" → "${OLD_STRATEGIES[m[3]]}"`
    );
    rule(/\bcancel(\s*):/g, (_m, sp) => `block${sp}:`, "cancel: → block:");
    rule(/\btypes(\s*):/g, (_m, sp) => `resourceTypes${sp}:`, "types: → resourceTypes:");
    // v2
    rule(/(["'`])webRequest\1/g, (_m, q) => `${q}extension${q}`, 'strategy "webRequest" → "extension"');
    rule(/\bwt\.onDom\b/g, "wt.onDocument", "wt.onDom → wt.onDocument");
    rule(/\b(when\s*:\s*)(["'`])DOMContentLoaded\2/g, (_m, pre, q) => `${pre}${q}document_end${q}`, 'when "DOMContentLoaded" → "document_end"');
    rule(/\brespond(\s*):/g, (_m, sp) => `replaceResponse${sp}:`, "respond: → replaceResponse:");
    rule(
        /\bWiretrick\.(RespondOptions|DomRouteOptions|DomRoute|DomOptions)\b/g,
        (_m, t) => `Wiretrick.${OLD_TYPES[t]}`,
        (m) => `Wiretrick.${m[1]} → Wiretrick.${OLD_TYPES[m[1]]}`
    );
    return { code, changes };
}

const DOC_START = /^(\s*)# Interception strategy for every handler/;
/** comment lines of a generated strategy documentation block (after its first line) */
const DOC_LINE = /^\s*#\s*(An unavailable strategy|Compatibility:|\w+: \+ |\w+( \| \w+)+\s*$|(defaultStrategy|strategy|default)\s*:)/;
const STRATEGY_KEY_LINE = /^\s+(#\s*)?(strategy|defaultStrategy)\s*:/;

/**
 * settings.yaml: the removed `defaultStrategy` (or v0 `strategy`) setting
 * — its generated documentation block and any live or commented entry —
 * is dropped; everything else (other comments, order, formatting) is kept.
 * Flow-style `settings: { … }` is left alone.
 */
export function migrateSettingsText(text: string): string {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const out: string[] = [];
    let inSettings = false;
    let inDoc = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^[^\s#]/.test(line)) inSettings = /^settings\s*:\s*(#.*)?$/.test(line);
        if (inSettings && DOC_START.test(line)) {
            inDoc = true;
            continue;
        }
        if (inDoc && DOC_LINE.test(line)) continue;
        inDoc = false;
        if (inSettings && STRATEGY_KEY_LINE.test(line)) continue;
        out.push(line);
    }
    return out.join(eol);
}
