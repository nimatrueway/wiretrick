/**
 * Export…/Import… zip: laid out like the synced scripts folder, so a zip
 * and a synced folder look the same:
 *
 *   settings.yaml          globals + each script's enabled state and params
 *   Debug header.ts        a script (its name is its path minus ".ts")
 *   ui/Panel.tsx
 *   mock/helpers.ts
 *   mock/rate-limits.json  data files, by path
 *   mock/empty/            an empty folder (a folder entry)
 *
 * Import also takes a zip of the synced folder itself (one top folder
 * holding settings.yaml, tsconfig.json or wt-api.d.ts is unwrapped); the
 * support files folder sync writes, dot entries and node_modules are skipped.
 */
import { parseDocument, isMap, isScalar, type YAMLMap } from "yaml";
import { readZipEntries, writeZip } from "./zip";
import { SETTINGS_FILE, SCHEMA_FILE, parseSettings, type SettingsDoc } from "./settingsYaml";
import { API_DTS_FILE, TSCONFIG_FILE } from "./generatedFiles";
import { dataFilePathProblem, folderPathProblem, scriptFileName, scriptNameFromFile, scriptNameProblem } from "./scriptName";
import { isInFolder } from "./folders";

export const EXPORT_ZIP_NAME = "wiretrick-export.zip";

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
    /** settings.yaml text; null when the zip has none */
    settings: string | null;
    /** `file`: the path in the zip (`mock/helpers.ts`) */
    scripts: { name: string; file: string; code: string }[];
    dataFiles: { path: string; text: string }[];
    /** empty folders */
    folders: string[];
    /** files that are none of the above (not counting folder sync's support files) */
    ignored: string[];
}

const GENERATED = new Set([API_DTS_FILE, TSCONFIG_FILE, SCHEMA_FILE]);
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

/** the export zip: scripts at their file paths, data files, empty folders and settings.yaml */
export function buildExportZip(c: { settings?: string | null; scripts: { name: string; code: string }[]; dataFiles: { path: string; text: string }[]; folders?: string[] }, date?: Date): Uint8Array {
    const files: Record<string, string> = {};
    if (c.settings != null) files[SETTINGS_FILE] = c.settings;
    for (const f of c.folders ?? []) files[f + "/"] = "";
    for (const s of c.scripts) files[scriptFileName(s.name)] = s.code;
    for (const d of c.dataFiles) files[d.path] = d.text;
    return writeZip(files, date);
}

/** what an export zip (or a zipped scripts folder) holds */
export async function readExportZip(buf: ArrayBuffer): Promise<ExportContents> {
    const skip = (p: string) => p.split("/").some((s) => s.startsWith(".") || s === "__MACOSX" || s === "node_modules");
    const raw = await readZipEntries(buf, (p) => !skip(p));
    let files = raw.files;
    let dirs = raw.folders;
    const all = [...Object.keys(files), ...dirs];
    const top = all.length ? all[0].split("/")[0] : "";
    if (top && all.every((p) => p === top || p.startsWith(top + "/")) && [SETTINGS_FILE, TSCONFIG_FILE, API_DTS_FILE].some((f) => files[`${top}/${f}`])) {
        const cut = top.length + 1;
        files = Object.fromEntries(Object.entries(files).map(([p, b]) => [p.slice(cut), b]));
        dirs = dirs.filter((d) => d !== top).map((d) => d.slice(cut));
    }
    const utf8 = new TextDecoder();
    const out: ExportContents = { settings: null, scripts: [], dataFiles: [], folders: [], ignored: [] };
    for (const [p, bytes] of Object.entries(files)) {
        if (p === SETTINGS_FILE) out.settings = utf8.decode(bytes);
        else if (GENERATED.has(p)) continue;
        else if (isScriptFile(p) && !scriptNameProblem(scriptNameFromFile(p))) out.scripts.push({ name: scriptNameFromFile(p), file: p, code: utf8.decode(bytes) });
        else if (!dataFilePathProblem(p)) out.dataFiles.push({ path: p, text: utf8.decode(bytes) });
        else out.ignored.push(p);
    }
    const paths = [...out.scripts.map((s) => s.file), ...out.dataFiles.map((d) => d.path)];
    out.folders = emptyFolders(dirs.filter((d) => d && !folderPathProblem(d)), paths);
    return out;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * settings.yaml cut down to the globals and these scripts' sections (the
 * others are removed line by line, so the rest stays byte-for-byte).
 */
export function settingsForScripts(text: string, names: string[]): string {
    let doc;
    try {
        doc = parseDocument(text);
    } catch {
        return text;
    }
    if (doc.errors.length || !isMap(doc.contents)) return text;
    const pair: any = doc.contents.items.find((p: any) => isScalar(p.key) && p.key.value === "params");
    if (!pair || !isMap(pair.value)) return text;
    const params = pair.value as YAMLMap;
    const keep = new Set(names);
    const items = params.items as any[];
    const dropped = items.filter((p) => !isScalar(p.key) || !keep.has(String(p.key.value)));
    if (!dropped.length) return text;
    const want = items.filter((p) => !dropped.includes(p)).map((p) => String(p.key.value));
    const structural = () => {
        for (const p of dropped) params.delete(p.key);
        if (!params.items.length) doc.delete("params");
        return doc.toString({ lineWidth: 0 });
    };
    if (params.flow) return structural();
    const nl = text.endsWith("\n");
    const lines = (nl ? text.slice(0, -1) : text).split("\n");
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length - 1;
    const blank = (i: number) => i >= 0 && i < lines.length && lines[i].trim() === "";
    const cut = new Set<number>();
    const starts = items.map((p) => lineOf(p.key.range[0]));
    let lastEnd = lineOf(pair.key.range[0]) + 1;
    items.forEach((p, i) => {
        const start = starts[i];
        const ind = indentOf(lines[start]);
        const limit = i + 1 < starts.length ? starts[i + 1] : lines.length;
        let end = start + 1;
        while (end < limit && (blank(end) || indentOf(lines[end]) > ind)) end++;
        while (end > start + 1 && blank(end - 1)) end--;
        lastEnd = end;
        if (!dropped.includes(p)) return;
        for (let k = start; k < end; k++) cut.add(k);
        // and one blank line around it: the separator from its neighbour
        if (blank(start - 1) && !cut.has(start - 1)) cut.add(start - 1);
        else if (blank(end)) cut.add(end);
    });
    if (!want.length) {
        const at = lineOf(pair.key.range[0]);
        for (let k = at; k < lastEnd; k++) cut.add(k);
        if (blank(at - 1)) cut.add(at - 1);
    }
    const out = lines.filter((_, i) => !cut.has(i)).join("\n") + (nl ? "\n" : "");
    try {
        const got = Object.keys(parseSettings(out).params);
        if (JSON.stringify(got) === JSON.stringify(want)) return out;
    } catch {}
    return structural();
}

/** the parts of a settings.yaml an import applies: its globals and these scripts' sections */
export function importedSettingsDoc(text: string, names: string[]): SettingsDoc {
    const doc = parseSettings(text);
    const keep = new Set(names);
    return { settings: doc.settings, params: Object.fromEntries(Object.entries(doc.params).filter(([n]) => keep.has(n))) };
}
