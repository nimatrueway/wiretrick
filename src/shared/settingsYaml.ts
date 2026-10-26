/**
 * settings.yaml — extension settings + per-script param values + enabled
 * state, as one canonical YAML document generated from storage state.
 *
 * Every option is listed with its description; options still at their
 * default are COMMENTED OUT, only user-set values are live entries:
 *
 *   # yaml-language-server: $schema=./settings.schema.json
 *   settings:
 *     # Minimum log level shown in the panel: debug | info | warn | error
 *     # logLevel: info
 *     # …strategy help (link + pros/cons)…
 *     # defaultStrategy: helper
 *
 *   params:
 *     My Script:
 *       # Run this script
 *       enabled: false
 *       # Value of the x-debug header
 *       # level: warn
 *
 * The modeline lets VS Code's YAML extension validate the file against
 * settings.schema.json (written next to it by folder sync); the same rules
 * are enforced in code here (parseSettings shape checks + planSettings
 * value validation) for the browser manager.
 *
 * Semantics when applying text: a missing/commented option means "default"
 * inside maps that are present — a map whose entries are all commented out
 * (`My Script:` with no children) parses as null and still counts as
 * present, so commenting out every entry resets that section to defaults.
 * A missing file is generated from scratch (renderSettings); an existing
 * parsable file is only patched (settingsYamlPatch.ts) so user formatting
 * survives. `enabled` is reserved in a script's map (shadows a param of
 * that name).
 */
import { parse, stringify, Document, isScalar, Scalar } from "yaml";
import { resolveParamValues, isValidParamValue, paramDefault, type ParamDef } from "./scriptDef";
import { builtinStrategy, STRATEGIES } from "./route";
import { STRATEGY_DOC_URL, STRATEGY_INFO } from "./strategyInfo";
import { DEFAULT_TEXT_TYPES } from "./bodyKind";

export const SETTINGS_FILE = "settings.yaml";
export const SCHEMA_FILE = "settings.schema.json";
/** modeline for the VS Code YAML extension — the schema sits next to the settings file */
export const SCHEMA_MODELINE = `# yaml-language-server: $schema=./${SCHEMA_FILE}`;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_LOG_CAP = 500;
/** Network body capture cap in kB (settings.bodyCap) */
export const DEFAULT_BODY_CAP = 2048;
export const BODY_CAP_MIN = 16;
export const BODY_CAP_MAX = 16384;
/** chrome.storage key of settings.bodyCap (absent: DEFAULT_BODY_CAP) */
export const BODY_CAP_KEY = "resBodyCap";
export const isBodyCap = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= BODY_CAP_MIN && v <= BODY_CAP_MAX;
export const BODY_CAP_DESC = `Network view: kB of each request/response body kept (${BODY_CAP_MIN}..${BODY_CAP_MAX})`;

export interface GlobalSettings {
    logLevel: string;
    logCap: number;
    /** default interception strategy (route.strategy overrides per handler) */
    defaultStrategy: string;
    /** Content-Type globs onResponseBody gets as text; undefined = DEFAULT_TEXT_TYPES */
    textTypes?: string[];
    /** Network body capture cap in kB; undefined = DEFAULT_BODY_CAP */
    bodyCap?: number;
}

/** the strategy settings.yaml falls back to when `defaultStrategy` is absent */
export const defaultStrategySetting = (): string => builtinStrategy();

export const isStrategy = (v: unknown): boolean => typeof v === "string" && (STRATEGIES as string[]).includes(v);

/** a valid settings.textTypes value: a non-empty list of non-empty strings */
export const isTextTypes = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");

export const TEXT_TYPES_DESC = "Content-Types onResponseBody gets as text (globs; `*` = anything). Other bodies are binary and reach only handlers with `binary: true` or `binary: both`.";

export interface ScriptSettingsState {
    name: string;
    /** registers handlers (utilities have no enabled switch) */
    declared: boolean;
    enabled: boolean;
    defs: Record<string, ParamDef>;
    /** raw stored values (unresolved) */
    values: Record<string, any>;
}

export const isObj = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** canonical rendering never folds long lines */
const STRINGIFY_OPTS = { lineWidth: 0 };

/**
 * Render one `key: value` entry (unindented, possibly multi-line for block
 * scalars / sequences) with the yaml library's own escaping and style
 * choices (multi-line strings become `|` block scalars, string lists block
 * sequences). With `block`, a multi-line string is FORCED to a block scalar
 * (the library still falls back to a quoted string when the value can't
 * round-trip as a block scalar — control chars, trailing-whitespace tails).
 */
export function entryLines(key: string, value: any, opts?: { block?: boolean }): string[] {
    if (opts?.block && typeof value === "string" && value.includes("\n")) {
        const doc = new Document({ [key]: value });
        const node = doc.getIn([key], true);
        if (isScalar(node)) (node as any).type = Scalar.BLOCK_LITERAL;
        return doc.toString({ lineWidth: 0 }).trimEnd().split("\n");
    }
    return stringify({ [key]: value }, STRINGIFY_OPTS).trimEnd().split("\n");
}

/** the key as entryLines renders it (for matching commented entries in existing text) */
export function renderedKeyText(k: string): string {
    const line = stringify({ [k]: null }, STRINGIFY_OPTS).trimEnd();
    return line.endsWith(": null") ? line.slice(0, -": null".length) : line;
}

const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_ ./-]*$/;
/** plain-looking keys that would parse back as non-strings must be quoted */
const SCALARISH_KEY = /^(null|~|true|false|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i;

/** Map key as emitted in generated files (double-quoted unless safely plain). */
export function yamlKey(k: string): string {
    return PLAIN_KEY.test(k) && k.trim() === k && !SCALARISH_KEY.test(k) ? k : JSON.stringify(k);
}

const clean = (s: string): string => s.replace(/\s*\n\s*/g, " ");
const same = (a: any, b: any): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One option at `indent`: description comment + live entry (or commented default). */
export function option(out: string[], indent: number, key: string, desc: string, value: any, def: any, block = false): void {
    const pad = " ".repeat(indent);
    out.push(`${pad}# ${clean(desc)}`);
    if (same(value, def)) {
        for (const l of entryLines(key, def, { block })) out.push(`${pad}# ${l}`);
    } else {
        for (const l of entryLines("default", def, { block })) out.push(`${pad}# ${l}`);
        for (const l of entryLines(key, value, { block })) out.push(pad + l);
    }
}

/**
 * The commented documentation lines for one option at its default
 * (description + commented entry) — used when inserting a newly declared
 * param into an existing file section.
 */
export function commentedDefaultLines(key: string, d: ParamDef | undefined): string[] {
    const out: string[] = [];
    if (key === "enabled" || !d) {
        option(out, 0, "enabled", "Run this script", true, true);
        return out;
    }
    const note = d.type === "enum" ? `${d.description ?? key} (${d.choices.join(" | ")})` : (d.description ?? key);
    option(out, 0, key, note, paramDefault(d), paramDefault(d), d.type === "string" && !!d.multiline);
    return out;
}

export const GLOBAL_KEYS = ["logLevel", "logCap", "defaultStrategy", "textTypes", "bodyCap"] as const;

/**
 * One global setting's documented lines at indent 0 (description comments
 * + live entry, or commented default). Also inserted into an existing file
 * that doesn't mention the key yet, e.g. a setting added by an update.
 */
export function globalOptionLines(key: (typeof GLOBAL_KEYS)[number], g: GlobalSettings): string[] {
    const out: string[] = [];
    if (key === "logLevel") option(out, 0, "logLevel", `Minimum log level shown in the panel: ${LOG_LEVELS.join(" | ")}`, g.logLevel, DEFAULT_LOG_LEVEL);
    else if (key === "logCap") option(out, 0, "logCap", "Log lines kept in the panel (100..10000)", g.logCap, DEFAULT_LOG_CAP);
    else if (key === "bodyCap") option(out, 0, "bodyCap", BODY_CAP_DESC, g.bodyCap ?? DEFAULT_BODY_CAP, DEFAULT_BODY_CAP);
    else if (key === "textTypes") option(out, 0, "textTypes", TEXT_TYPES_DESC, g.textTypes ?? [...DEFAULT_TEXT_TYPES], [...DEFAULT_TEXT_TYPES]);
    else {
        out.push("# Interception strategy for every handler whose route doesn't set `strategy`.");
        out.push("# An unavailable strategy means the handler doesn't run (warned) — no fallback.");
        out.push(`# Compatibility: ${STRATEGY_DOC_URL}`);
        for (const s of STRATEGIES) out.push(`#   ${s}: + ${clean(STRATEGY_INFO[s].pros)} − ${clean(STRATEGY_INFO[s].cons)}`);
        option(out, 0, "defaultStrategy", `${STRATEGIES.join(" | ")}`, g.defaultStrategy, defaultStrategySetting());
    }
    return out;
}

/** Canonical, deterministic text for the given state. */
export function renderSettings(g: GlobalSettings, scripts: ScriptSettingsState[]): string {
    const out: string[] = [
        SCHEMA_MODELINE,
        "# Wiretrick settings — edit and save; options left commented use their default.",
        "",
        "settings:",
    ];
    for (const k of GLOBAL_KEYS) out.push(...globalOptionLines(k, g).map((l) => "  " + l));
    const blocks = scripts.map((s) => scriptBlock(s)).filter((b): b is string[] => !!b);
    if (blocks.length) {
        out.push("", "params:");
        for (let i = 0; i < blocks.length; i++) {
            if (i > 0) out.push(""); // blank line between script sections
            out.push(...blocks[i]);
        }
    }
    return out.join("\n") + "\n";
}

export const scriptKeys = (s: ScriptSettingsState): string[] => Object.keys(s.defs).filter((k) => k !== "enabled");

/** canonical lines of one script's map (null: nothing to list); `indent` = the name line's indent */
export function scriptBlock(s: ScriptSettingsState, indent = 2): string[] | null {
    const keys = scriptKeys(s);
    if (!s.declared && !keys.length) return null;
    const out = [`${" ".repeat(indent)}${yamlKey(s.name)}:`];
    if (s.declared) option(out, indent + 2, "enabled", "Run this script", s.enabled, true);
    const vals = resolveParamValues(s.defs, s.values);
    for (const k of keys) {
        const d = s.defs[k];
        const note = d.type === "enum" ? `${d.description ?? k} (${d.choices.join(" | ")})` : (d.description ?? k);
        option(out, indent + 2, k, note, vals[k], paramDefault(d), d.type === "string" && !!d.multiline);
    }
    return out;
}

export interface SettingsDoc {
    settings: Partial<GlobalSettings> | null; // null: no settings map
    params: Record<string, Record<string, any>>;
}

/**
 * Parse; throws on YAML syntax errors. Structural rules mirror
 * settings.schema.json: `settings` must be a map, `params` a map of maps.
 * A present-but-empty section (`settings:` / `My Script:` with everything
 * commented out) parses as null and counts as an EMPTY map — present — so
 * commenting out every entry resets that section to defaults. Sections of
 * the wrong type (scalar/list) are treated as absent; invalid values are
 * skipped later, in planSettings.
 */
export function parseSettings(text: string): SettingsDoc {
    const raw: any = parse(text);
    const params: SettingsDoc["params"] = {};
    if (isObj(raw) && isObj(raw.params)) {
        for (const [n, v] of Object.entries(raw.params)) {
            if (isObj(v)) params[n] = v;
            else if (v === null) params[n] = {};
        }
    }
    let settings: SettingsDoc["settings"] = null;
    if (isObj(raw) && Object.prototype.hasOwnProperty.call(raw, "settings")) {
        if (isObj(raw.settings)) settings = raw.settings;
        else if (raw.settings === null) settings = {};
    }
    return { settings, params };
}

export interface SettingsPlan {
    globals: Partial<GlobalSettings>;
    scripts: { name: string; enabled?: boolean; params: Record<string, any> }[];
}

/** What must change in `current` for it to match the document (invalid values are skipped). */
export function planSettings(doc: SettingsDoc, current: GlobalSettings, scripts: ScriptSettingsState[]): SettingsPlan {
    const globals: Partial<GlobalSettings> = {};
    if (doc.settings) {
        const lv = doc.settings.logLevel === undefined ? DEFAULT_LOG_LEVEL : doc.settings.logLevel;
        if (typeof lv === "string" && (LOG_LEVELS as readonly string[]).includes(lv) && lv !== current.logLevel) globals.logLevel = lv;
        const cap = doc.settings.logCap === undefined ? DEFAULT_LOG_CAP : doc.settings.logCap;
        if (typeof cap === "number" && Number.isInteger(cap) && cap >= 100 && cap <= 10000 && cap !== current.logCap) globals.logCap = cap;
        const st = doc.settings.defaultStrategy === undefined ? defaultStrategySetting() : doc.settings.defaultStrategy;
        if (isStrategy(st) && st !== current.defaultStrategy) globals.defaultStrategy = st as string;
        const tt = doc.settings.textTypes === undefined ? [...DEFAULT_TEXT_TYPES] : doc.settings.textTypes;
        if (isTextTypes(tt) && !same(tt, current.textTypes ?? DEFAULT_TEXT_TYPES)) globals.textTypes = tt;
        const bc = doc.settings.bodyCap === undefined ? DEFAULT_BODY_CAP : doc.settings.bodyCap;
        if (isBodyCap(bc) && bc !== (current.bodyCap ?? DEFAULT_BODY_CAP)) globals.bodyCap = bc;
    }
    const plans: SettingsPlan["scripts"] = [];
    for (const s of scripts) {
        const t = doc.params[s.name];
        if (!t) continue;
        const plan: SettingsPlan["scripts"][number] = { name: s.name, params: {} };
        if (s.declared) {
            const e = t.enabled === undefined ? true : t.enabled;
            if (typeof e === "boolean" && e !== s.enabled) plan.enabled = e;
        }
        const cur = resolveParamValues(s.defs, s.values);
        for (const [k, d] of Object.entries(s.defs)) {
            if (k === "enabled") continue;
            const v = t[k] === undefined ? paramDefault(d) : t[k];
            if (isValidParamValue(d, v) && JSON.stringify(v) !== JSON.stringify(cur[k])) plan.params[k] = v;
        }
        if (plan.enabled !== undefined || Object.keys(plan.params).length) plans.push(plan);
    }
    return { globals, scripts: plans };
}
