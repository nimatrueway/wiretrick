/**
 * Explorer → Make Package…: turn scripts into a package that can be shared
 * as is (docs/packages.md).
 *   - a script that imports no file of the user's: gets a `wt.metadata({…})`
 *     naming it, and stays where it is
 *   - a script that does: moves, with the files it imports by relative
 *     path, into a folder of its own with a metadata.json (a bundle of one).
 *     Imports are rewritten for the new places; a file that other scripts
 *     still use is copied into the package instead of moved
 *   - a folder: gets a metadata.json listing its scripts (a bundle)
 */
import { builtinSpec } from "./builtinSpecs";
import { MANIFEST_FILE } from "./packageMetadata";
import { entryStem } from "./packageModel";
import { isUrlSpec } from "./packageImports";
import { candidates, SCRIPT_FILE_RE } from "./packageSource";
import { folderOf, importPath, importSpecs, isDataSpec, rewriteImports } from "./scriptImports";

export interface PackagePlan {
    /** the package's folder ("" for a script at the root) */
    folder: string;
    /** the script stays where it is */
    inPlace: boolean;
    /** the script first, then what it imports; `text` is the file's content at `to` */
    files: { from: string; to: string; copy: boolean; text: string }[];
    /** other files whose imports follow a moved file */
    edits: { path: string; text: string }[];
    /** a bundle: the metadata.json to write (the script's own wt.metadata is left alone) */
    manifest?: { path: string; text: string };
    /** imports by bare name: they resolve from the root of the user's scripts, not the package */
    bare: { from: string; spec: string }[];
    /** relative imports that point at no file */
    missing: { from: string; spec: string }[];
}

const isRelative = (spec: string): boolean => /^\.\.?(\/|$)/.test(spec);
const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const join = (folder: string, rest: string): string => (folder ? `${folder}/${rest}` : rest);
const under = (path: string, folder: string): boolean => !folder || path.startsWith(folder + "/");

/** `name`, else `name 2`, `name 3`… (a file's before its extension) — whichever `taken` doesn't hold */
function unique(name: string, taken: (path: string) => boolean, file = true): string {
    if (!taken(name)) return name;
    const m = file ? /^(.*?)((?:\.wiretrick)?\.[^./]+)?$/i.exec(name)! : [name, name];
    for (let i = 2; ; i++) {
        const next = `${m[1]} ${i}${m[2] ?? ""}`;
        if (!taken(next)) return next;
    }
}

/** the specifier that imports `target` from the file at `from`, written in the style of `was` (extension or not) */
export function relativeSpec(from: string, target: string, was: string): string {
    const a = folderOf(from).split("/").filter(Boolean);
    const b = target.split("/");
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    let spec = [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
    if (!spec.startsWith(".")) spec = "./" + spec;
    if (!isDataSpec(target)) {
        if (/\.js$/i.test(was)) spec = spec.replace(/\.tsx?$/i, ".js");
        else if (!/\.tsx?$/i.test(was)) spec = spec.replace(/\.tsx?$/i, "");
    }
    return spec;
}

/** the object literal of the code's `wt.metadata({…})` call: [index of "{", index after "}"] */
function metadataObject(code: string): [number, number] | undefined {
    const m = /\bwt\s*\.\s*metadata\s*\(\s*\{/.exec(code);
    if (!m) return undefined;
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let quote = "";
    for (let i = start; i < code.length; i++) {
        const c = code[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = "";
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return [start, i + 1];
    }
    return undefined;
}

/** the script's code with a `wt.metadata({…})` naming it (unchanged when it names itself) */
export function withMetadata(code: string, name: string, connect: string[] = []): string {
    const at = metadataObject(code);
    const body = at ? code.slice(at[0] + 1, at[1] - 1) : "";
    const has = (key: string) => new RegExp(`(^|[{,\\s])["']?${key}["']?\\s*:`).test(body);
    if (has("name")) return code;
    const keys = [
        `name: ${JSON.stringify(name)}`,
        ...(has("version") ? [] : [`version: "1.0.0"`]),
        ...(has("connect") || !connect.length ? [] : [`connect: [${connect.map((c) => JSON.stringify(c)).join(", ")}]`]),
    ];
    if (!keys.length) return code;
    if (!at) {
        const call = `wt.metadata({ ${keys.join(", ")} });\n`;
        // after the imports
        let end = 0;
        for (const m of code.matchAll(/^import\b[\s\S]*?["'][^"'\n]+["'][ \t]*;?[ \t]*$/gm)) end = m.index! + m[0].length;
        return end ? `${code.slice(0, end)}\n\n${call}${code.slice(end).replace(/^\n+/, "\n")}` : `${call}\n${code}`;
    }
    let inner: string;
    if (!body.trim()) inner = ` ${keys.join(", ")} `;
    else if (/^[ \t]*\n/.test(body)) {
        const indent = /\n([ \t]*)/.exec(body)![1];
        inner = keys.map((k) => `\n${indent}${k},`).join("") + body;
    } else inner = ` ${keys.join(", ")},${body.startsWith(" ") ? body : " " + body}`;
    return code.slice(0, at[0] + 1) + inner + code.slice(at[1] - 1);
}

/** a new metadata.json's text */
export function manifestText(name: string, scripts: string[], connect: string[] = []): string {
    return JSON.stringify({ name, version: "1.0.0", description: "", ...(connect.length ? { connect } : {}), scripts }, null, 4) + "\n";
}

/** hosts the code's wt.fetch calls name in a literal URL */
export function fetchHosts(codes: string[]): string[] {
    const out = new Set<string>();
    for (const code of codes) for (const m of code.matchAll(/\bwt\.fetch\s*\(\s*["'`]https?:\/\/([^/:"'`\s$?#]+)/g)) out.add(m[1].toLowerCase());
    return [...out].sort();
}

/**
 * How to make the script at `entry` a package. `files` holds every file of
 * the user's scripts (path → text: scripts with their .ts/.tsx, data
 * files); `folders` the folders that exist, empty ones included.
 */
export function makePackagePlan(entry: string, files: Record<string, string>, folders: string[] = []): PackagePlan {
    const lower = new Map(Object.keys(files).map((p) => [p.toLowerCase(), p]));
    const bare: PackagePlan["bare"] = [];
    const missing: PackagePlan["missing"] = [];
    /** what each file's specifiers point at (relative ones that resolve) */
    const targets = new Map<string, Map<string, string>>();
    const resolve = (from: string): Map<string, string> => {
        let out = targets.get(from);
        if (out) return out;
        targets.set(from, (out = new Map()));
        if (isDataSpec(from)) return out;
        for (const spec of importSpecs(files[from])) {
            if (!isRelative(spec)) continue;
            const path = importPath(from, spec);
            const hit = (path === null ? [] : candidates(path)).map((c) => lower.get(c.toLowerCase())).find((p) => p !== undefined);
            if (hit) out.set(spec, hit);
        }
        return out;
    };

    // the entry and what it imports, in the order they're reached
    const set = [entry];
    for (let i = 0; i < set.length; i++) {
        const from = set[i];
        if (isDataSpec(from)) continue;
        const found = resolve(from);
        for (const spec of importSpecs(files[from])) {
            if (isUrlSpec(spec) || builtinSpec(spec)) continue;
            if (!isRelative(spec)) bare.push({ from, spec });
            else if (!found.has(spec)) missing.push({ from, spec });
            else if (!set.includes(found.get(spec)!)) set.push(found.get(spec)!);
        }
    }
    const inSet = new Set(set);

    const dir = folderOf(entry);
    const connect = fetchHosts(set.filter((p) => !isDataSpec(p)).map((p) => files[p]));
    const name = entryStem(entry) || "package";
    // nothing to take along: the script names itself
    if (set.length === 1) {
        const text = withMetadata(files[entry], name, connect);
        return { folder: dir, inPlace: true, files: [{ from: entry, to: entry, copy: false, text }], edits: [], bare, missing };
    }
    // its folder holds nothing else (and is no bundle yet): it becomes the bundle
    const others = Object.keys(files).some((p) => under(p, dir) && !set.includes(p));
    const inPlace = !!dir && !others && set.every((p) => under(p, dir));

    // copied: a file something outside the package (or a copy's original, which stays) still imports
    const outside = Object.keys(files).filter((p) => !inSet.has(p));
    const copied = new Set<string>();
    if (!inPlace)
        for (let grew = true; grew; ) {
            grew = false;
            for (const p of set.slice(1))
                if (!copied.has(p) && [...outside, ...copied].some((o) => [...resolve(o).values()].includes(p))) {
                    copied.add(p);
                    grew = true;
                }
        }

    let folder = dir;
    const to = new Map<string, string>();
    if (inPlace) for (const p of set) to.set(p, p);
    else {
        const takenFolders = new Set([...folders, ...Object.keys(files).flatMap((p) => p.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/")))].map((f) => f.toLowerCase()));
        folder = unique(join(dir, name), (f) => takenFolders.has(f.toLowerCase()) || lower.has(f.toLowerCase()), false);
        const used = new Set<string>();
        for (const p of set) {
            const want = join(folder, under(p, dir) ? p.slice(dir ? dir.length + 1 : 0) : base(p));
            const path = unique(want, (x) => used.has(x.toLowerCase()));
            used.add(path.toLowerCase());
            to.set(p, path);
        }
    }

    const rewritten = (from: string, at: string, moved: (target: string) => boolean): string =>
        isDataSpec(from)
            ? files[from]
            : rewriteImports(files[from], (spec) => {
                  const t = resolve(from).get(spec);
                  return t === undefined || !moved(t) ? undefined : relativeSpec(at, to.get(t)!, spec);
              });

    const out = set.map((p) => ({ from: p, to: to.get(p)!, copy: copied.has(p), text: inPlace ? files[p] : rewritten(p, to.get(p)!, (t) => inSet.has(t)) }));
    const manifest = { path: join(folder, MANIFEST_FILE), text: manifestText(name, [out[0].to.slice(folder.length + 1)], connect) };

    // files that stay put but import one that moves (the entry, typically)
    const edits: PackagePlan["edits"] = [];
    if (!inPlace)
        for (const p of outside) {
            const text = rewritten(p, p, (t) => inSet.has(t) && !copied.has(t));
            if (text !== files[p]) edits.push({ path: p, text });
        }
    return { folder, inPlace, files: out, edits, manifest, bare, missing };
}

export interface FolderPackagePlan {
    /** the metadata.json to write */
    manifest: { path: string; text: string };
    /** the bundle's scripts: those under the folder no other file there imports */
    scripts: string[];
    /** relative imports of files outside the folder: a bundle can't take them */
    outside: { from: string; spec: string }[];
    bare: { from: string; spec: string }[];
    missing: { from: string; spec: string }[];
}

/** How to make `folder` a bundle: a metadata.json listing its scripts. `files` as in makePackagePlan. */
export function makeFolderPackagePlan(folder: string, files: Record<string, string>): FolderPackagePlan {
    const lower = new Map(Object.keys(files).map((p) => [p.toLowerCase(), p]));
    const inside = Object.keys(files).filter((p) => under(p, folder)).sort();
    const imported = new Set<string>();
    const outside: FolderPackagePlan["outside"] = [];
    const bare: FolderPackagePlan["bare"] = [];
    const missing: FolderPackagePlan["missing"] = [];
    for (const from of inside) {
        if (isDataSpec(from)) continue;
        for (const spec of importSpecs(files[from])) {
            if (isUrlSpec(spec) || builtinSpec(spec)) continue;
            if (!isRelative(spec)) {
                bare.push({ from, spec });
                continue;
            }
            const path = importPath(from, spec);
            const hit = (path === null ? [] : candidates(path)).map((c) => lower.get(c.toLowerCase())).find((p) => p !== undefined);
            if (!hit) missing.push({ from, spec });
            else if (!under(hit, folder)) outside.push({ from, spec });
            else if (hit !== from) imported.add(hit);
        }
    }
    const scripts = inside.filter((p) => SCRIPT_FILE_RE.test(p) && !imported.has(p));
    const connect = fetchHosts(inside.filter((p) => !isDataSpec(p)).map((p) => files[p]));
    const name = base(folder) || "package";
    return { manifest: { path: join(folder, MANIFEST_FILE), text: manifestText(name, scripts.map((p) => p.slice(folder.length + 1)), connect) }, scripts, outside, bare, missing };
}

/** Folders the Explorer shows as packages: those holding a metadata.json (folder → its path) */
export function packageFolders(paths: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of paths) if (p.toLowerCase().endsWith("/" + MANIFEST_FILE)) out.set(folderOf(p), p);
    return out;
}
