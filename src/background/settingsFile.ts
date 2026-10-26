/**
 * settings.yaml ⇄ storage. Text is always generated from storage, so the
 * manager's virtual file, the popup and the synced folder converge on one
 * source of truth.
 */
import { listScripts, loadAllParamValues, setParamValue, setEnabled, onScriptRenamed } from "./engine/scriptStore";
import { patchSettings, renameSettingsSection } from "../shared/settingsYamlPatch";
import {
    renderSettings, parseSettings, planSettings,
    DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, DEFAULT_BODY_CAP, BODY_CAP_KEY, defaultStrategySetting, isStrategy, isTextTypes, isBodyCap,
    type GlobalSettings, type ScriptSettingsState, type SettingsDoc, type SettingsPlan,
} from "../shared/settingsYaml";
import { DEFAULT_TEXT_TYPES } from "../shared/bodyKind";

function storageGet(keys: string[]): Promise<Record<string, any>> {
    return new Promise((r) => chrome.storage.local.get(keys, (d) => r(d || {})));
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((r) => chrome.storage.local.set(items, () => r()));
}

export async function currentSettingsState(): Promise<{ globals: GlobalSettings; scripts: ScriptSettingsState[] }> {
    const g = await storageGet(["resLogLevel", "resLogCap", STRATEGY_KEY, TEXT_TYPES_KEY, BODY_CAP_KEY]);
    const stored = await loadAllParamValues();
    const scripts = (await listScripts()).map((s) => ({
        name: s.meta.name,
        declared: s.meta.active !== false,
        enabled: s.enabled,
        defs: s.paramDefs ?? {},
        values: stored[s.id] ?? {},
    }));
    const defaultStrategy = isStrategy(g[STRATEGY_KEY]) ? g[STRATEGY_KEY] : defaultStrategySetting();
    const globals: GlobalSettings = { logLevel: g.resLogLevel ?? DEFAULT_LOG_LEVEL, logCap: g.resLogCap ?? DEFAULT_LOG_CAP, defaultStrategy };
    if (isTextTypes(g[TEXT_TYPES_KEY])) globals.textTypes = g[TEXT_TYPES_KEY];
    if (isBodyCap(g[BODY_CAP_KEY])) globals.bodyCap = g[BODY_CAP_KEY];
    return { globals, scripts };
}

/** chrome.storage key of settings.defaultStrategy (absent: per-browser default) */
export const STRATEGY_KEY = "resStrategy";

/** chrome.storage key of settings.textTypes (absent: DEFAULT_TEXT_TYPES) */
export const TEXT_TYPES_KEY = "resTextTypes";

/** chrome.storage key of the last applied settings.yaml text */
export const SETTINGS_TEXT_KEY = "resSettingsText";
const TEXT_KEY = SETTINGS_TEXT_KEY;

// a renamed script keeps its settings section (values, comments)
onScriptRenamed(async (oldName, newName) => {
    const text = (await storageGet([TEXT_KEY]))[TEXT_KEY];
    if (typeof text !== "string") return;
    const next = renameSettingsSection(text, oldName, newName);
    if (next !== text) await storageSet({ [TEXT_KEY]: next });
});

/** does this settings.yaml text parse? */
export function settingsTextParses(text: string): boolean {
    try {
        parseSettings(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Current settings.yaml. Patches `existing` (the synced file / editor text;
 * default: the last applied text) in place so user formatting survives;
 * regenerates canonically only when there is no parsable base.
 */
export async function getSettingsText(existing?: string): Promise<string> {
    const { globals, scripts } = await currentSettingsState();
    const base = existing ?? (await storageGet([TEXT_KEY]))[TEXT_KEY];
    return (typeof base === "string" ? patchSettings(base, globals, scripts) : null) ?? renderSettings(globals, scripts);
}

/** The synced file was (re)written with this exact text — it becomes the manager's text too. */
export async function rememberSettingsText(text: string): Promise<void> {
    const cur = (await storageGet([TEXT_KEY]))[TEXT_KEY];
    if (cur !== text) await storageSet({ [TEXT_KEY]: text });
}

async function applyPlan(plan: SettingsPlan): Promise<void> {
    const ids = new Map((await listScripts()).map((s) => [s.meta.name, s.id]));
    for (const p of plan.scripts) {
        const id = ids.get(p.name)!;
        for (const [k, v] of Object.entries(p.params)) await setParamValue(id, k, v);
        if (p.enabled !== undefined) await setEnabled(id, p.enabled);
    }
    const patch: Record<string, any> = {};
    if (plan.globals.logLevel) patch.resLogLevel = plan.globals.logLevel;
    if (plan.globals.logCap) patch.resLogCap = plan.globals.logCap;
    if (plan.globals.defaultStrategy) patch[STRATEGY_KEY] = plan.globals.defaultStrategy;
    if (Object.keys(patch).length) await storageSet(patch);
    if (plan.globals.textTypes) {
        // back at the defaults: forget the list, so a future default change applies
        if (JSON.stringify(plan.globals.textTypes) === JSON.stringify(DEFAULT_TEXT_TYPES)) await new Promise<void>((r) => chrome.storage.local.remove(TEXT_TYPES_KEY, () => r()));
        else await storageSet({ [TEXT_TYPES_KEY]: plan.globals.textTypes });
    }
    if (plan.globals.bodyCap) {
        if (plan.globals.bodyCap === DEFAULT_BODY_CAP) await new Promise<void>((r) => chrome.storage.local.remove(BODY_CAP_KEY, () => r()));
        else await storageSet({ [BODY_CAP_KEY]: plan.globals.bodyCap });
    }
}

/** Apply text to storage (a full-file edit: everything in it applies). Syntax errors leave all state untouched. */
export async function applySettingsText(text: string): Promise<{ error?: string }> {
    let doc;
    try {
        doc = parseSettings(text);
    } catch (e: any) {
        return { error: String(e?.message || e).split("\n")[0] };
    }
    const { globals, scripts } = await currentSettingsState();
    await applyPlan(planSettings(doc, globals, scripts));
    await storageSet({ [TEXT_KEY]: text });
    return {};
}

/**
 * Apply a structured settings document (import bundle path). Unlike
 * applySettingsText, the stored base text is then re-canonicalized —
 * patching the previous base when parsable — so a bundle's minimal
 * settings shape doesn't freeze the file into that shape.
 */
export async function applySettingsDoc(doc: SettingsDoc): Promise<{ error?: string }> {
    const { globals, scripts } = await currentSettingsState();
    await applyPlan(planSettings(doc, globals, scripts));
    await storageSet({ [TEXT_KEY]: await getSettingsText() });
    return {};
}
