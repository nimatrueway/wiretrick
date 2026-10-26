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
 *   dataFiles:           # JSON data files, by path
 *     - path: mock/rate-limits.json
 *       text: |-
 *         { "max": 10 }
 *   folders:             # explicit (e.g. empty) folders
 *     - mock/empty
 *
 * A script's name is its path (`mock/helpers`). Import accepts that YAML
 * shape (.yaml/.yml).
 */
import { parse, stringify } from "yaml";
import type { SettingsDoc } from "../shared/settingsYaml";
import { fileNameFor } from "./fsBridge";

export interface BundleScript {
    name?: string;
    code: string;
    enabled?: boolean;
    /** non-default param values */
    params?: Record<string, any>;
}

export interface BundleDataFile {
    /** path incl. `.json`, e.g. mock/rate-limits.json */
    path: string;
    text: string;
}

export interface ParsedBundle {
    scripts: BundleScript[];
    dataFiles?: BundleDataFile[];
    folders?: string[];
    /** structured globals */
    settings?: { logLevel?: string; logCap?: number; textTypes?: string[]; bodyCap?: number };
}

export const BUNDLE_FORMAT = "wiretrick-bundle";

/** File name within the synced folder for a script — or settings.yaml for the virtual settings entry. */
export function syncFileNameFor(selectedId: string, scriptName: string | undefined, settingsId: string, settingsFile: string): string {
    return selectedId === settingsId ? settingsFile : fileNameFor(selectedId, scriptName || "");
}

/** Absolute file path the ↗ VS Code button opens for the current selection. */
export function vscodeTargetPath(folder: string, selectedId: string, scriptName: string | undefined, settingsId: string, settingsFile: string): string {
    return folder.replace(/\/+$/, "") + "/" + syncFileNameFor(selectedId, scriptName, settingsId, settingsFile);
}

export type HostOs = "mac" | "windows" | "linux";
export const hostOs = (platform: string): HostOs => (/Mac|iPhone|iPad/.test(platform) ? "mac" : /^Win/.test(platform) ? "windows" : "linux");

/** How to copy a folder's absolute path on this OS (the browser can't read it), and an example path. */
export function copyPathHint(os: HostOs): { hint: string; example: string } {
    if (os === "mac") return { hint: "In Finder, select the folder and press ⌥⌘C (Copy as Pathname), then paste it here.", example: "/Users/you/Wiretrick" };
    if (os === "windows") return { hint: "In File Explorer, select the folder and press Ctrl+Shift+C (or Shift+right-click → Copy as path), then paste it here.", example: "C:\\Users\\you\\Wiretrick" };
    return { hint: "In your file manager, open the folder and press Ctrl+L to show its path, or run pwd in a terminal there, then paste it here.", example: "/home/you/Wiretrick" };
}

/** A pasted folder path, cleaned up: quotes from Windows' Copy as path, a file:// URI some file managers copy, a trailing slash. */
export function cleanFolderPath(raw: string): string {
    let p = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (/^file:\/\//i.test(p)) {
        try {
            p = decodeURIComponent(new URL(p).pathname).replace(/^\/([A-Za-z]:)/, "$1");
        } catch {}
    }
    return p.replace(/(?<=[^/\\:])[/\\]+$/, "");
}

/** What the ↗ button launches: Settings → Open button. */
export type LaunchMode = "vscode" | "vscode-insiders" | "custom" | "off";

/** Display name of the ↗ button's target. */
export function launchAppName(mode: string): string {
    return mode === "vscode-insiders" ? "VS Code Insiders" : mode === "custom" ? "your editor" : "VS Code";
}

/**
 * The URL the ↗ button opens for an absolute file path. "custom" fills a
 * template like React DevTools' "Open in Editor URL" — `{path}` (absolute,
 * starts with "/") and `{line}` (1-based), e.g. `cursor://file{path}:{line}`.
 * null when there's nothing to launch (off, or an empty custom template).
 */
export function editorLaunchUrl(mode: string, template: string, file: string, line = 1): string | null {
    const path = file.split("/").map(encodeURIComponent).join("/");
    if (mode === "off") return null;
    if (mode === "custom") {
        const t = template.trim();
        return t ? t.split("{path}").join(path).split("{line}").join(String(line)) : null;
    }
    return (mode === "vscode-insiders" ? "vscode-insiders://file" : "vscode://file") + path;
}

/**
 * Build the YAML export. `doc` is the parsed current settings.yaml (only
 * live/non-default values survive the parse, which is exactly what a bundle
 * should carry); each script's `enabled` comes from the script list, its
 * params from the doc's params section (keyed by name).
 */
export function buildBundle(doc: SettingsDoc, scripts: BundleScript[], dataFiles: BundleDataFile[] = [], folders: string[] = []): string {
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
    if (dataFiles.length) out.dataFiles = dataFiles.map((d) => ({ path: d.path, text: d.text }));
    if (folders.length) out.folders = [...folders];
    return "# Wiretrick export — scripts + settings\n" + stringify(out, { lineWidth: 0 });
}

/** Parse bundle YAML. null when it isn't a wiretrick-bundle. */
export function parseBundleText(text: string): ParsedBundle | null {
    let parsed: any;
    try {
        parsed = parse(text);
    } catch {
        return null;
    }
    if (!parsed || parsed.format !== BUNDLE_FORMAT) return null;
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
    if (Array.isArray(parsed.dataFiles)) {
        const dataFiles = parsed.dataFiles
            .filter((d: any) => d && typeof d === "object" && typeof d.path === "string" && typeof d.text === "string")
            .map((d: any) => ({ path: d.path, text: d.text }));
        if (dataFiles.length) out.dataFiles = dataFiles;
    }
    if (Array.isArray(parsed.folders)) {
        const folders = parsed.folders.filter((f: any) => typeof f === "string" && f);
        if (folders.length) out.folders = folders;
    }
    if (parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)) {
        const settings: { logLevel?: string; logCap?: number; textTypes?: string[]; bodyCap?: number } = {};
        if (typeof parsed.settings.logLevel === "string") settings.logLevel = parsed.settings.logLevel;
        if (typeof parsed.settings.logCap === "number") settings.logCap = parsed.settings.logCap;
        if (typeof parsed.settings.bodyCap === "number") settings.bodyCap = parsed.settings.bodyCap;
        if (Array.isArray(parsed.settings.textTypes) && parsed.settings.textTypes.every((t: any) => typeof t === "string")) settings.textTypes = parsed.settings.textTypes;
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

/**
 * The part of a bundle the user picked: its settings (globals), these
 * scripts and these data files (indices into bundle.dataFiles). Folders
 * always come along (they only matter when empty).
 */
export function pickBundle(bundle: ParsedBundle, keepSettings: boolean, scriptIndices: number[], dataIndices: number[] = []): ParsedBundle {
    const out: ParsedBundle = { scripts: scriptIndices.map((i) => bundle.scripts[i]).filter(Boolean) };
    const dataFiles = dataIndices.map((i) => bundle.dataFiles?.[i]).filter((d): d is BundleDataFile => !!d);
    if (dataFiles.length) out.dataFiles = dataFiles;
    if (bundle.folders?.length) out.folders = bundle.folders;
    if (keepSettings && bundle.settings) out.settings = bundle.settings;
    return out;
}
