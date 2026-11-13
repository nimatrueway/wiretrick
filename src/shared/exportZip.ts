/**
 * Export…/Import… zip: laid out like the synced scripts folder, so a zip
 * and a synced folder look the same:
 *
 *   settings.json          globals + each script's enabled state and params
 *   Debug header.ts        a script (its name is its path minus ".ts")
 *   ui/Panel.tsx
 *   mock/helpers.ts
 *   mock/rate-limits.json  data files, by path
 *   mock/empty/            an empty folder (a folder entry)
 *
 * Import also takes a zip of the synced folder itself (one top folder
 * holding settings.json, tsconfig.json or tt-api.d.ts is unwrapped); the
 * support files folder sync writes, dot entries and node_modules are skipped.
 */
import { readZipEntries, writeZip } from "./zip";
import { SETTINGS_FILE, SCHEMA_FILE, parseSettings, serializeSettingsDoc, type SettingsDoc } from "./settingsJson";
import { API_DTS_FILE, PACKAGE_JSON_FILE, TSCONFIG_FILE } from "./generatedFiles";
import { bytesToImageDataUrl, imageDataUrlToBytes, isImageDataPath } from "./scriptImports";
import { badValue, isPlainObject } from "./storeOps";
import { dataFilePathProblem, folderPathProblem, scriptFileName, scriptNameFromFile, scriptNameProblem, scriptPathKey } from "./scriptName";
import { isInFolder } from "./folders";

export const EXPORT_ZIP_NAME = "tangitweak-export.zip";
export const STORES_FILE = "stores.json";

const MANIFEST = "metadata.json";

/**
 * The package folders an Import… zip brings a version of: each folder with
 * a metadata.json, and the zip's one folder when everything is in it (what
 * Export Package… makes).
 */
export function packageRoots(zip: Pick<ExportContents, "settings" | "scripts" | "dataFiles" | "folders">): string[] {
    const roots = new Map<string, string>();
    const add = (f: string) => void (f && !roots.has(f.toLowerCase()) && roots.set(f.toLowerCase(), f));
    for (const d of zip.dataFiles) if (d.path.toLowerCase().endsWith("/" + MANIFEST)) add(d.path.slice(0, -MANIFEST.length - 1));
    const paths = [...zip.scripts.map((s) => s.file), ...zip.dataFiles.map((d) => d.path), ...zip.folders];
    const top = paths.length ? paths[0].split("/")[0] : "";
    if (zip.settings === null && top && paths.every((p) => p.includes("/") && p.split("/")[0].toLowerCase() === top.toLowerCase())) add(top);
    // a package inside another is part of it
    return [...roots.values()].filter((r, _, all) => !all.some((o) => o !== r && isInFolder(r, o)));
}

/** of `existing` paths, those inside the zip's package folders that the zip doesn't have: the imported version deleted them */
export function filesGoneFrom(zip: Pick<ExportContents, "settings" | "scripts" | "dataFiles" | "folders">, existing: string[]): string[] {
    const roots = packageRoots(zip);
    const has = new Set([...zip.scripts.map((s) => s.file), ...zip.dataFiles.map((d) => d.path)].map((p) => p.toLowerCase()));
    return existing.filter((p) => roots.some((r) => isInFolder(p, r)) && !has.has(p.toLowerCase()));
}

export interface ExportContents {
    /** settings.json text; null when the zip has none */
    settings: string | null;
    /** tangitweak-stores.json text; null when the zip has none */
    stores?: string | null;
    /** `file`: the path in the zip (`mock/helpers.ts`) */
    scripts: { name: string; file: string; code: string }[];
    dataFiles: { path: string; text: string }[];
    /** empty folders */
    folders: string[];
    /** files that are none of the above (not counting folder sync's support files) */
    ignored: string[];
}

const GENERATED = new Set([API_DTS_FILE, TSCONFIG_FILE, PACKAGE_JSON_FILE, SCHEMA_FILE]);
const isScriptFile = (p: string) => (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)) || /\.tsx$/.test(p);

/** the folders with nothing in them: no path and no other folder inside */
export function emptyFolders(folders: string[], paths: string[]): string[] {
    const seen = new Set<string>();
    return folders.filter((f) => {
        const k = f.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return !paths.some((p) => isInFolder(p, f)) && !folders.some((o) => isInFolder(o, f));
    });
}

/** the export zip: scripts at their file paths, data files, empty folders, settings.json and optional tangitweak-stores.json */
export function buildExportZip(
    c: { settings?: string | null; stores?: string | null; scripts: { name: string; code: string }[]; dataFiles: { path: string; text: string }[]; folders?: string[] },
    date?: Date
): Uint8Array {
    const files: Record<string, string | Uint8Array> = {};
    if (c.settings != null) files[SETTINGS_FILE] = c.settings;
    if (c.stores != null) files[STORES_FILE] = c.stores;
    for (const f of c.folders ?? []) files[f + "/"] = "";
    for (const s of c.scripts) files[scriptFileName(s.name)] = s.code;
    for (const d of c.dataFiles) files[d.path] = isImageDataPath(d.path) ? imageDataUrlToBytes(d.text) : d.text;
    return writeZip(files, date);
}

/** filter exported stores `{ [scriptName]: { [storeName]: data } }` down to `scriptNames` and format as JSON (or null if empty) */
export function storesForScripts(all: Record<string, Record<string, any>>, scriptNames: string[]): string | null {
    const wanted = new Set(scriptNames.map(scriptPathKey));
    const filtered: Record<string, Record<string, any>> = {};
    for (const [scriptName, stores] of Object.entries(all || {})) {
        if (!wanted.has(scriptPathKey(scriptName)) || !isPlainObject(stores) || !Object.keys(stores).length) continue;
        filtered[scriptName] = stores;
    }
    return Object.keys(filtered).length ? JSON.stringify(filtered, null, 2) + "\n" : null;
}

/** parse and validate `tangitweak-stores.json` text */
export function parseExportedStores(text: string): Record<string, Record<string, Record<string, any>>> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`invalid JSON (${(e as Error).message})`);
    }
    if (!isPlainObject(parsed)) throw new Error(`${STORES_FILE} must be a JSON object mapping script names to stores`);
    for (const [scriptName, stores] of Object.entries(parsed)) {
        if (!isPlainObject(stores)) throw new Error(`${STORES_FILE}: entry for "${scriptName}" must be an object of stores`);
        for (const [storeName, data] of Object.entries(stores)) {
            if (!isPlainObject(data)) throw new Error(`${STORES_FILE}: store "${storeName}" of "${scriptName}" must be a JSON object`);
            const bad = badValue(data);
            if (bad) throw new Error(`${STORES_FILE}: store "${storeName}" of "${scriptName}": ${bad}`);
        }
    }
    return parsed as Record<string, Record<string, Record<string, any>>>;
}

/** what an export zip (or a zipped scripts folder) holds */
export async function readExportZip(buf: ArrayBuffer): Promise<ExportContents> {
    const skip = (p: string) => p.split("/").some((s) => s.startsWith(".") || s === "__MACOSX" || s === "node_modules");
    const raw = await readZipEntries(buf, (p) => !skip(p));
    let files = raw.files;
    let dirs = raw.folders;
    const all = [...Object.keys(files), ...dirs];
    const top = all.length ? all[0].split("/")[0] : "";
    if (top && all.every((p) => p === top || p.startsWith(top + "/")) && [SETTINGS_FILE, STORES_FILE, TSCONFIG_FILE, API_DTS_FILE].some((f) => files[`${top}/${f}`])) {
        const cut = top.length + 1;
        files = Object.fromEntries(Object.entries(files).map(([p, b]) => [p.slice(cut), b]));
        dirs = dirs.filter((d) => d !== top).map((d) => d.slice(cut));
    }
    const utf8 = new TextDecoder();
    const out: ExportContents = { settings: null, stores: null, scripts: [], dataFiles: [], folders: [], ignored: [] };
    for (const [p, bytes] of Object.entries(files)) {
        if (p === SETTINGS_FILE) out.settings = utf8.decode(bytes);
        else if (p === STORES_FILE) out.stores = utf8.decode(bytes);
        else if (GENERATED.has(p)) continue;
        else if (isScriptFile(p) && !scriptNameProblem(scriptNameFromFile(p))) out.scripts.push({ name: scriptNameFromFile(p), file: p, code: utf8.decode(bytes) });
        else if (!dataFilePathProblem(p)) out.dataFiles.push({ path: p, text: isImageDataPath(p) ? bytesToImageDataUrl(p, bytes) : utf8.decode(bytes) });
        else out.ignored.push(p);
    }
    const paths = [...out.scripts.map((s) => s.file), ...out.dataFiles.map((d) => d.path)];
    out.folders = emptyFolders(dirs.filter((d) => d && !folderPathProblem(d)), paths);
    return out;
}

/**
 * settings.json filtered down to the globals and these scripts' entries.
 */
export function settingsForScripts(text: string, names: string[]): string {
    let doc: SettingsDoc;
    try {
        doc = parseSettings(text);
    } catch {
        return text;
    }
    const keep = new Set(names.map(scriptPathKey));
    const scripts = Object.fromEntries(Object.entries(doc.scripts).filter(([n]) => keep.has(scriptPathKey(n))));
    return serializeSettingsDoc({ globals: doc.globals, scripts });
}

/** the parts of a settings.json an import applies: its globals and these scripts' entries */
export function importedSettingsDoc(text: string, names: string[], hasScriptsInZip = true): SettingsDoc {
    const doc = parseSettings(text);
    if (!hasScriptsInZip) return { ...doc, onlyScripts: Object.keys(doc.scripts) };
    const keep = new Set(names.map(scriptPathKey));
    return {
        globals: doc.globals,
        scripts: Object.fromEntries(Object.entries(doc.scripts).filter(([n]) => keep.has(scriptPathKey(n)))),
        onlyScripts: names,
    };
}
