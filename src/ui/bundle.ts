/**
 * Import/export bundle shape. New bundles are a single YAML document
 * (wiretrick-export.yaml):
 *
 *   # Wiretrick export — scripts + settings
 *   format: wiretrick-bundle
 *   version: 2
 *   exportedAt: 2026-…
 *   settings:            # only non-default globals
 *     logLevel: warn
 *   scripts:
 *     - name: Debug header
 *       enabled: false
 *       params:          # only non-default param values
 *         level: trace
 *       code: |-
 *         wt.onRequest("*://example.com/*", …
 *
 * Import accepts that YAML shape (.yaml/.yml) AND legacy JSON bundles
 * (.json, format version 1): a `settings` object ({ logLevel, logCap }) is
 * still applied. Settings are always YAML.
 */
import { parse, stringify } from "yaml";
import type { SettingsDoc } from "../shared/settingsYaml";
import { fileNameFor } from "./fsBridge";

export interface BundleScript {
    name?: string;
    code: string;
    enabled?: boolean;
    /** non-default param values (new yaml bundles) */
    params?: Record<string, any>;
}

export interface ParsedBundle {
    scripts: BundleScript[];
    /** structured globals (new yaml bundles + legacy json `settings` object) */
    settings?: { logLevel?: string; logCap?: number };
}

export const BUNDLE_FORMAT = "wiretrick-bundle";
/** formats accepted on import (exports from before the rename) */
const LEGACY_BUNDLE_FORMATS = ["rescript-bundle"];

/** File name within the synced folder for a script — or settings.yaml for the virtual settings entry. */
export function syncFileNameFor(selectedId: string, scriptName: string | undefined, settingsId: string, settingsFile: string): string {
    return selectedId === settingsId ? settingsFile : fileNameFor(selectedId, scriptName || "");
}

/** Absolute file path the ↗ VS Code button opens for the current selection. */
export function vscodeTargetPath(folder: string, selectedId: string, scriptName: string | undefined, settingsId: string, settingsFile: string): string {
    return folder.replace(/\/+$/, "") + "/" + syncFileNameFor(selectedId, scriptName, settingsId, settingsFile);
}

/**
 * Build the YAML export. `doc` is the parsed current settings.yaml (only
 * live/non-default values survive the parse, which is exactly what a bundle
 * should carry); each script's `enabled` comes from the script list, its
 * params from the doc's params section (keyed by name).
 */
export function buildBundle(doc: SettingsDoc, scripts: BundleScript[]): string {
    const entries = scripts.map((s) => {
        const entry: Record<string, any> = {};
        if (s.name !== undefined) entry.name = s.name;
        if (s.enabled !== undefined) entry.enabled = s.enabled;
        const p = s.name !== undefined ? doc.params[s.name] : undefined;
        if (p) {
            const { enabled: _enabled, ...rest } = p; // enabled lives on the script entry
            if (Object.keys(rest).length) entry.params = rest;
        }
        entry.code = s.code;
        return entry;
    });
    const out: Record<string, any> = {
        format: BUNDLE_FORMAT,
        version: 2,
        exportedAt: new Date().toISOString(),
    };
    if (doc.settings && Object.keys(doc.settings).length) out.settings = doc.settings;
    out.scripts = entries;
    return "# Wiretrick export — scripts + settings\n" + stringify(out, { lineWidth: 0 });
}

/** Parse bundle text: YAML (new) or JSON (legacy). null when it isn't a wiretrick-bundle. */
export function parseBundleText(text: string): ParsedBundle | null {
    const t = text.trimStart();
    let parsed: any;
    if (t.startsWith("{") || t.startsWith("[")) {
        try {
            parsed = JSON.parse(text);
        } catch {
            return null;
        }
    } else {
        try {
            parsed = parse(text);
        } catch {
            return null;
        }
    }
    if (!parsed || (parsed.format !== BUNDLE_FORMAT && !LEGACY_BUNDLE_FORMATS.includes(parsed.format))) return null;
    const out: ParsedBundle = { scripts: [] };
    if (Array.isArray(parsed.scripts)) {
        out.scripts = parsed.scripts
            .filter((s: any) => s && typeof s === "object" && typeof s.code === "string")
            .map((s: any) => {
                const b: BundleScript = { code: s.code };
                if (typeof s.name === "string") b.name = s.name;
                if (typeof s.enabled === "boolean") b.enabled = s.enabled;
                if (s.params && typeof s.params === "object" && !Array.isArray(s.params)) b.params = s.params;
                return b;
            });
    }
    if (parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)) {
        const settings: { logLevel?: string; logCap?: number } = {};
        if (typeof parsed.settings.logLevel === "string") settings.logLevel = parsed.settings.logLevel;
        if (typeof parsed.settings.logCap === "number") settings.logCap = parsed.settings.logCap;
        if (Object.keys(settings).length) out.settings = settings;
    }
    return out;
}

/**
 * Everything a bundle says about settings as one SettingsDoc (applied via
 * settingsFile.applySettingsDoc): structured globals + per-script params.
 * null when the bundle carries no settings at all.
 *
 * A script's section is created only when the bundle carries param values
 * for it — and then `enabled` is restated too, because planSettings treats
 * a section missing `enabled` as "true" (its default). A script entry with
 * only `enabled` and no params gets NO section: `enabled` is applied when
 * the import saves the script (saveScript), and a bare section would reset
 * every unmentioned param to its default.
 */
export function bundleSettingsDoc(bundle: ParsedBundle): SettingsDoc | null {
    const settings: Record<string, any> = {};
    const params: Record<string, Record<string, any>> = {};
    let any = false;
    if (bundle.settings) {
        Object.assign(settings, bundle.settings);
        any = true;
    }
    for (const s of bundle.scripts) {
        if (!s.name || !s.params || !Object.keys(s.params).length) continue;
        const t: Record<string, any> = { ...s.params };
        if (s.enabled !== undefined) t.enabled = s.enabled;
        params[s.name] = { ...(params[s.name] ?? {}), ...t };
        any = true;
    }
    if (!any) return null;
    return { settings: Object.keys(settings).length ? settings : null, params };
}

/** The part of a bundle the user picked: its settings (globals) and these scripts. */
export function pickBundle(bundle: ParsedBundle, keepSettings: boolean, scriptIndices: number[]): ParsedBundle {
    const out: ParsedBundle = { scripts: scriptIndices.map((i) => bundle.scripts[i]).filter(Boolean) };
    if (keepSettings && bundle.settings) out.settings = bundle.settings;
    return out;
}
