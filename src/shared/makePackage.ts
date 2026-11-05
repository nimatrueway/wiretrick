/**
 * Explorer → Make Package…: turn an entry script into a package — a folder
 * holding the entry and the files it imports by relative path, with a
 * header — that can be shared as is (docs/packages.md). Imports are
 * rewritten for the new places; a file that other scripts still use is
 * copied into the package instead of moved.
 */
import { builtinSpec } from "./builtinSpecs";
import { parseHeader } from "./packageHeader";
import { isUrlSpec } from "./packageImports";
import { candidates, ENTRY_FILE_RE } from "./packageSource";
import { isEntryName } from "./scriptName";
import { folderOf, importPath, importSpecs, isDataSpec, rewriteImports } from "./scriptImports";

export interface PackagePlan {
    /** the package's folder */
    folder: string;
    /** the entry stays where it is: its folder is a package already */
    inPlace: boolean;
    /** the entry first, then what it imports; `text` is the file's content at `to` */
    files: { from: string; to: string; copy: boolean; text: string }[];
    /** other files whose imports follow a moved file */
    edits: { path: string; text: string }[];
    /** the entry had no `@name`: the plan adds a header */
    addsHeader: boolean;
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

/** the entry's code with a header naming it (unchanged when it has a `@name`) */
export function withHeader(code: string, name: string, connect: string[] = []): string {
    const h = parseHeader(code);
    if (h.name) return code;
    const tags = [`@name ${name}`, ...(h.version ? [] : ["@version 1.0.0"]), ...(h.description ? [] : ["@description"]), ...(h.connect.length ? [] : connect.map((c) => `@connect ${c}`))];
    // a JSDoc block at the top that isn't on one line: add to it
    const m = /^((?:\s|\/\/[^\n]*\n)*\/\*\*[^\n]*\n)([\s\S]*?\*\/)/.exec(code);
    if (m && !m[0].slice(m[1].length).startsWith("*/")) return m[1] + tags.map((t) => ` * ${t}\n`).join("") + code.slice(m[1].length);
    return `/**\n${tags.map((t) => ` * ${t}\n`).join("")} */\n` + code;
}

/** hosts the code's wt.fetch calls name in a literal URL */
export function fetchHosts(codes: string[]): string[] {
    const out = new Set<string>();
    for (const code of codes) for (const m of code.matchAll(/\bwt\.fetch\s*\(\s*["'`]https?:\/\/([^/:"'`\s$?#]+)/g)) out.add(m[1].toLowerCase());
    return [...out].sort();
}

/**
 * How to make the entry at `entry` a package. `files` holds every file of
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
    const otherEntry = Object.keys(files).some((p) => p !== entry && ENTRY_FILE_RE.test(p) && under(p, dir));
    const inPlace = !!dir && !otherEntry && set.every((p) => under(p, dir));

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
        const stem = base(entry).replace(ENTRY_FILE_RE, "") || "package";
        const takenFolders = new Set([...folders, ...Object.keys(files).flatMap((p) => p.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/")))].map((f) => f.toLowerCase()));
        folder = unique(join(dir, stem), (f) => takenFolders.has(f.toLowerCase()) || lower.has(f.toLowerCase()), false);
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

    const connect = fetchHosts(set.filter((p) => !isDataSpec(p)).map((p) => files[p]));
    const out = set.map((p) => ({ from: p, to: to.get(p)!, copy: copied.has(p), text: inPlace ? files[p] : rewritten(p, to.get(p)!, (t) => inSet.has(t)) }));
    const header = withHeader(out[0].text, base(entry).replace(ENTRY_FILE_RE, "") || "package", connect);
    const addsHeader = header !== out[0].text;
    out[0].text = header;

    // files that stay put but import one that moves (the entry, typically)
    const edits: PackagePlan["edits"] = [];
    if (!inPlace)
        for (const p of outside) {
            const text = rewritten(p, p, (t) => inSet.has(t) && !copied.has(t));
            if (text !== files[p]) edits.push({ path: p, text });
        }
    return { folder, inPlace, files: out, edits, addsHeader, bare, missing };
}

/**
 * Folders the Explorer shows as packages: each holds one entry (in it,
 * not a subfolder) with a header `@name`, and no other entry below it.
 * Folder → the entry's script name.
 */
export function packageFolders(scripts: { name: string; code: string }[]): Map<string, string> {
    const entries = scripts.filter((s) => isEntryName(s.name));
    const out = new Map<string, string>();
    for (const e of entries) {
        const dir = folderOf(e.name);
        if (!dir || !parseHeader(e.code).name) continue;
        if (entries.some((o) => o !== e && o.name.startsWith(dir + "/"))) continue;
        out.set(dir, e.name);
    }
    return out;
}
