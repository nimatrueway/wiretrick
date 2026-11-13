/**
 * settings.json ⇄ storage. Text is rendered deterministically from storage
 * (sparse overrides only; `{}` when everything uses defaults), so the Editor,
 * popup and synced folder always converge without patching shadow text.
 */
import { listScripts, loadAllParamValues, setParamValue, setEnabled } from "./engine/scriptStore";
import { scriptFileName, scriptPathKey } from "../shared/scriptName";
import {
    renderSettings,
    parseSettings,
    planSettings,
    DEFAULT_LOG_CAP,
    DEFAULT_LOG_LEVEL,
    DEFAULT_BODY_CAP,
    BODY_CAP_KEY,
    isTextTypes,
    isBodyCap,
    type GlobalSettings,
    type ScriptSettingsState,
    type SettingsDoc,
    type SettingsPlan,
} from "../shared/settingsJson";
import { DEFAULT_TEXT_TYPES } from "../shared/bodyKind";

function storageGet(keys: string[]): Promise<Record<string, any>> {
    return new Promise((r) => chrome.storage.local.get(keys, (d) => r(d || {})));
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((r) => chrome.storage.local.set(items, () => r()));
}

function storageRemove(key: string): Promise<void> {
    return new Promise((r) => {
        if (typeof chrome.storage.local.remove === "function") chrome.storage.local.remove(key, () => r());
        else chrome.storage.local.set({ [key]: undefined }, () => r());
    });
}

export async function currentSettingsState(): Promise<{ globals: GlobalSettings; scripts: ScriptSettingsState[] }> {
    const g = await storageGet(["resLogLevel", "resLogCap", TEXT_TYPES_KEY, BODY_CAP_KEY]);
    const stored = await loadAllParamValues();
    const scripts = (await listScripts()).map((s) => ({
        name: scriptFileName(s.meta.name),
        declared: s.meta.active !== false,
        enabled: s.enabled,
        defs: s.paramDefs ?? {},
        values: stored[s.id] ?? {},
    }));
    const globals: GlobalSettings = { logLevel: g.resLogLevel ?? DEFAULT_LOG_LEVEL, logCap: g.resLogCap ?? DEFAULT_LOG_CAP };
    if (isTextTypes(g[TEXT_TYPES_KEY])) globals.textTypes = g[TEXT_TYPES_KEY];
    if (isBodyCap(g[BODY_CAP_KEY])) globals.bodyCap = g[BODY_CAP_KEY];
    return { globals, scripts };
}

/** chrome.storage key of textTypes (absent: DEFAULT_TEXT_TYPES) */
export const TEXT_TYPES_KEY = "resTextTypes";

export function settingsTextParses(text: string): boolean {
    try {
        parseSettings(text);
        return true;
    } catch {
        return false;
    }
}

export async function getSettingsText(): Promise<string> {
    const { globals, scripts } = await currentSettingsState();
    return renderSettings(globals, scripts);
}

async function applyPlan(plan: SettingsPlan): Promise<void> {
    const ids = new Map((await listScripts()).map((s) => [scriptPathKey(s.meta.name), s.id]));
    for (const p of plan.scripts) {
        const id = ids.get(scriptPathKey(p.name));
        if (!id) continue;
        for (const [k, v] of Object.entries(p.params)) await setParamValue(id, k, v);
        if (p.enabled !== undefined) await setEnabled(id, p.enabled);
    }
    const patch: Record<string, any> = {};
    if (plan.globals.logLevel) patch.resLogLevel = plan.globals.logLevel;
    if (plan.globals.logCap) patch.resLogCap = plan.globals.logCap;
    if (Object.keys(patch).length) await storageSet(patch);
    if (plan.globals.textTypes) {
        if (JSON.stringify(plan.globals.textTypes) === JSON.stringify(DEFAULT_TEXT_TYPES)) await storageRemove(TEXT_TYPES_KEY);
        else await storageSet({ [TEXT_TYPES_KEY]: plan.globals.textTypes });
    }
    if (plan.globals.bodyCap) {
        if (plan.globals.bodyCap === DEFAULT_BODY_CAP) await storageRemove(BODY_CAP_KEY);
        else await storageSet({ [BODY_CAP_KEY]: plan.globals.bodyCap });
    }
}

/** Apply settings.json text to storage (a full-file edit: omitted entries reset to defaults). */
export async function applySettingsText(text: string): Promise<{ error?: string }> {
    let doc: SettingsDoc;
    try {
        doc = parseSettings(text);
    } catch (e: any) {
        return { error: String(e?.message || e).split("\n")[0] };
    }
    const { globals, scripts } = await currentSettingsState();
    await applyPlan(planSettings(doc, globals, scripts));
    return {};
}

/** Apply a structured settings document (Import… of a zip's settings.json). */
export async function applySettingsDoc(doc: SettingsDoc): Promise<{ error?: string }> {
    const { globals, scripts } = await currentSettingsState();
    await applyPlan(planSettings(doc, globals, scripts));
    return {};
}
