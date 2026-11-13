/**
 * settings.json — extension settings and per-script overrides as a minimal,
 * sparse JSON document (like VS Code's settings.json).
 *
 * Only non-default values are written (`{}` when everything uses defaults).
 * Omitting a key (or clearing the file to `{}`) resets it to its default:
 *
 *   {
 *     "logLevel": "debug",
 *     "scripts": {
 *       "bonsai/index.tsx": {
 *         "enabled": false,
 *         "env": "staging"
 *       }
 *     }
 *   }
 */
import { isParamDef, isParamGroup, isValidParamValue, paramDefault, resolveParamValues, type ParamTree } from "./scriptDef";
import { DEFAULT_TEXT_TYPES } from "./bodyKind";
import { scriptPathKey } from "./scriptName";

export const SETTINGS_FILE = "settings.json";
export const SCHEMA_FILE = "settings.schema.json";
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_LOG_CAP = 500;
/** Network body capture cap in kB (bodyCap) */
export const DEFAULT_BODY_CAP = 2048;
export const BODY_CAP_MIN = 16;
export const BODY_CAP_MAX = 16384;
/** chrome.storage key of bodyCap (absent: DEFAULT_BODY_CAP) */
export const BODY_CAP_KEY = "resBodyCap";
export const isBodyCap = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= BODY_CAP_MIN && v <= BODY_CAP_MAX;
export const BODY_CAP_DESC = `Network view: kB of each request/response body kept (${BODY_CAP_MIN}..${BODY_CAP_MAX})`;

/** a valid textTypes value: a non-empty list of non-empty strings */
export const isTextTypes = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");
export const TEXT_TYPES_DESC = "Content-Types onResponseBody gets as text (globs; `*` = anything). Other bodies are binary and reach only handlers with `binary: true` or `binary: both`.";

export interface GlobalSettings {
    logLevel: string;
    logCap: number;
    /** Content-Type globs onResponseBody gets as text; undefined = DEFAULT_TEXT_TYPES */
    textTypes?: string[];
    /** Network body capture cap in kB; undefined = DEFAULT_BODY_CAP */
    bodyCap?: number;
}

export interface ScriptSettingsState {
    name: string;
    /** registers handlers (libraries have no enabled switch) */
    declared: boolean;
    enabled: boolean;
    defs: ParamTree;
    /** raw stored values (unresolved) */
    values: Record<string, any>;
}

export interface SettingsDoc {
    globals: Partial<GlobalSettings>;
    scripts: Record<string, Record<string, any>>;
    /** when set (partial zip import), only these scripts are reconciled; others stay untouched */
    onlyScripts?: string[];
}

export interface SettingsPlan {
    globals: Partial<GlobalSettings>;
    scripts: { name: string; enabled?: boolean; params: Record<string, any> }[];
}

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function nonDefaultParams(defs: ParamTree, vals: Record<string, any> | undefined, skipEnabled: boolean): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, node] of Object.entries(defs)) {
        if (skipEnabled && k === "enabled") continue;
        if (isParamDef(node)) {
            const v = vals?.[k];
            if (v !== undefined && !same(v, paramDefault(node))) out[k] = v;
        } else if (isParamGroup(node)) {
            const sub = nonDefaultParams(node, vals?.[k], false);
            if (Object.keys(sub).length) out[k] = sub;
        }
    }
    return out;
}

/** Build the sparse JSON object representing non-default settings and script overrides. */
export function buildSettingsObject(g: GlobalSettings, scripts: ScriptSettingsState[]): Record<string, any> {
    const out: Record<string, any> = {};
    if (g.logLevel !== DEFAULT_LOG_LEVEL) out.logLevel = g.logLevel;
    if (g.logCap !== DEFAULT_LOG_CAP) out.logCap = g.logCap;
    if (g.bodyCap !== undefined && g.bodyCap !== DEFAULT_BODY_CAP) out.bodyCap = g.bodyCap;
    if (g.textTypes !== undefined && !same(g.textTypes, DEFAULT_TEXT_TYPES)) out.textTypes = g.textTypes;

    const scriptsMap: Record<string, Record<string, any>> = {};
    for (const s of scripts) {
        const entry: Record<string, any> = {};
        if (s.declared && !s.enabled) entry.enabled = false;
        Object.assign(entry, nonDefaultParams(s.defs, resolveParamValues(s.defs, s.values), true));
        if (Object.keys(entry).length) scriptsMap[s.name] = entry;
    }
    if (Object.keys(scriptsMap).length) out.scripts = scriptsMap;
    return out;
}

export function renderSettings(g: GlobalSettings, scripts: ScriptSettingsState[]): string {
    return JSON.stringify(buildSettingsObject(g, scripts), null, 2) + "\n";
}

export function serializeSettingsDoc(doc: SettingsDoc): string {
    const out: Record<string, any> = {};
    if (doc.globals.logLevel !== undefined && doc.globals.logLevel !== DEFAULT_LOG_LEVEL) out.logLevel = doc.globals.logLevel;
    if (doc.globals.logCap !== undefined && doc.globals.logCap !== DEFAULT_LOG_CAP) out.logCap = doc.globals.logCap;
    if (doc.globals.bodyCap !== undefined && doc.globals.bodyCap !== DEFAULT_BODY_CAP) out.bodyCap = doc.globals.bodyCap;
    if (doc.globals.textTypes !== undefined && !same(doc.globals.textTypes, DEFAULT_TEXT_TYPES)) out.textTypes = doc.globals.textTypes;
    const scriptsMap = Object.fromEntries(Object.entries(doc.scripts).filter(([, v]) => isObj(v) && Object.keys(v).length > 0));
    if (Object.keys(scriptsMap).length) out.scripts = scriptsMap;
    return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Parse `settings.json` text; throws on JSON syntax errors or non-object root.
 * Also accepts `{ settings: { ... }, params: { ... } }` objects for compatibility.
 */
export function parseSettings(text: string): SettingsDoc {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`invalid JSON (${(e as Error).message})`);
    }
    if (!isObj(raw)) throw new Error(`${SETTINGS_FILE} must be a JSON object`);

    const gSrc = isObj(raw.settings) ? { ...raw.settings, ...raw } : raw;
    const globals: Partial<GlobalSettings> = {};
    if ("logLevel" in gSrc) globals.logLevel = gSrc.logLevel;
    if ("logCap" in gSrc) globals.logCap = gSrc.logCap;
    if ("textTypes" in gSrc) globals.textTypes = gSrc.textTypes;
    if ("bodyCap" in gSrc) globals.bodyCap = gSrc.bodyCap;

    const sSrc = isObj(raw.scripts) ? raw.scripts : isObj(raw.params) ? raw.params : {};
    const scripts: Record<string, Record<string, any>> = {};
    for (const [n, v] of Object.entries(sSrc)) {
        if (isObj(v)) scripts[n] = v;
        else if (v === null) scripts[n] = {};
    }
    return { globals, scripts };
}

/** What must change in `current` for storage to match `doc` (invalid values are skipped). */
export function planSettings(doc: SettingsDoc, current: GlobalSettings, scripts: ScriptSettingsState[]): SettingsPlan {
    const globals: Partial<GlobalSettings> = {};
    const lv = doc.globals.logLevel === undefined ? DEFAULT_LOG_LEVEL : doc.globals.logLevel;
    if (typeof lv === "string" && (LOG_LEVELS as readonly string[]).includes(lv) && lv !== current.logLevel) globals.logLevel = lv;
    const cap = doc.globals.logCap === undefined ? DEFAULT_LOG_CAP : doc.globals.logCap;
    if (typeof cap === "number" && Number.isInteger(cap) && cap >= 100 && cap <= 10000 && cap !== current.logCap) globals.logCap = cap;
    const tt = doc.globals.textTypes === undefined ? [...DEFAULT_TEXT_TYPES] : doc.globals.textTypes;
    if (isTextTypes(tt) && !same(tt, current.textTypes ?? DEFAULT_TEXT_TYPES)) globals.textTypes = tt;
    const bc = doc.globals.bodyCap === undefined ? DEFAULT_BODY_CAP : doc.globals.bodyCap;
    if (isBodyCap(bc) && bc !== (current.bodyCap ?? DEFAULT_BODY_CAP)) globals.bodyCap = bc;

    const byKey = new Map<string, Record<string, any>>();
    for (const [k, v] of Object.entries(doc.scripts)) byKey.set(scriptPathKey(k), v);
    const scope = doc.onlyScripts ? new Set(doc.onlyScripts.map(scriptPathKey)) : null;

    const plans: SettingsPlan["scripts"] = [];
    for (const s of scripts) {
        const key = scriptPathKey(s.name);
        if (scope && !scope.has(key)) continue;
        const t = byKey.get(key) ?? {};
        const plan: SettingsPlan["scripts"][number] = { name: s.name, params: {} };
        if (s.declared) {
            const e = t.enabled === undefined ? true : t.enabled;
            if (typeof e === "boolean" && e !== s.enabled) plan.enabled = e;
        }
        const cur = resolveParamValues(s.defs, s.values);
        const planGroup = (defs: ParamTree, docMap: Record<string, any>, curMap: Record<string, any> | undefined, prefix: string, skipEnabled: boolean) => {
            for (const [k, node] of Object.entries(defs)) {
                if (skipEnabled && k === "enabled") continue;
                const full = prefix ? `${prefix}.${k}` : k;
                if (isParamDef(node)) {
                    const v = docMap[k] === undefined ? paramDefault(node) : docMap[k];
                    if (isValidParamValue(node, v) && !same(v, curMap?.[k])) plan.params[full] = v;
                } else if (isParamGroup(node)) {
                    const sub = docMap[k];
                    if (sub === undefined || sub === null) planGroup(node, {}, curMap?.[k], full, false);
                    else if (isObj(sub)) planGroup(node, sub, curMap?.[k], full, false);
                }
            }
        };
        planGroup(s.defs, t, cur, "", true);
        if (plan.enabled !== undefined || Object.keys(plan.params).length) plans.push(plan);
    }
    return { globals, scripts: plans };
}
