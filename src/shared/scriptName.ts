/**
 * A script's name is its file path in the scripts folder (minus ".ts"),
 * segments separated by `/` (`mock/helpers` is helpers.ts in the mock
 * folder); a data file's path keeps its `.json`. Anything a file name may
 * hold on every OS is allowed in a segment; only what Windows, macOS or
 * Linux reject is excluded.
 */

/** forbidden in a segment somewhere: Windows `<>:"/\|?*` + control chars (and `/` everywhere) */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
/** forbidden in a name (a path: `/` separates its folders) */
const FORBIDDEN_IN_PATH = /[<>:"\\|?*\u0000-\u001f]/g;
/** Windows device names, with or without an extension */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** longest file or folder name (one segment) */
export const MAX_NAME = 100;
/** longest name including its folders */
export const MAX_PATH = 400;

/** drop forbidden characters as the user types (`/` stays: it moves the script into a folder) */
export function cleanScriptName(raw: string): string {
    return raw
        .replace(FORBIDDEN_IN_PATH, "")
        .split("/")
        .map((seg) => seg.slice(0, MAX_NAME))
        .join("/")
        .slice(0, MAX_PATH);
}

function segmentProblem(seg: string, folder: boolean): string {
    if (!seg) return "folder names can't be empty (no leading, trailing or double /)";
    if (seg === "." || seg === "..") return `"${seg}" can't be a file or folder name`;
    if (folder && seg.startsWith(".")) return "folder names can't start with a dot";
    if (seg.replace(FORBIDDEN, "") !== seg) return 'names can\'t contain < > : " \\ | ? *';
    if (/[. ]$/.test(seg)) return "names can't end with a dot or space";
    if (RESERVED.test(seg)) return `"${seg}" is a reserved file name on Windows`;
    if (seg.length > MAX_NAME) return `names are at most ${MAX_NAME} characters per folder level`;
    return "";
}

function pathProblem(path: string, lastIsFolder: boolean): string {
    if (path.length > MAX_PATH) return `paths are at most ${MAX_PATH} characters`;
    const segs = path.split("/");
    for (let i = 0; i < segs.length; i++) {
        const p = segmentProblem(segs[i], lastIsFolder || i < segs.length - 1);
        if (p) return p;
    }
    return "";
}

/** why a (trimmed) name can't be used, or "" when it's fine */
export function scriptNameProblem(name: string): string {
    if (!name) return "name is empty";
    return pathProblem(name, false);
}

/**
 * JSON files that configure tooling rather than hold data: package.json,
 * package-lock.json, tsconfig*.json and jsconfig.json anywhere, and the
 * settings.schema.json Wiretrick keeps at the root of the synced folder.
 * They are never data files (folder sync skips them).
 */
export function isConfigJsonPath(path: string): boolean {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return /^(package\.json|package-lock\.json|tsconfig.*\.json|jsconfig\.json)$/i.test(base) || /^settings\.schema\.json$/i.test(path);
}

/** why a data file path (`mock/rate-limits.json`) can't be used, or "" */
export function dataFilePathProblem(path: string): string {
    if (!path) return "path is empty";
    if (!/\.json$/i.test(path)) return "data files are .json files";
    if (/(^|\/)\.json$/i.test(path)) return "data file names can't be just .json";
    if (/(^|\/)\./.test(path)) return "data file names can't start with a dot";
    if (isConfigJsonPath(path)) return "that name is reserved for tooling config (package.json, tsconfig.json…)";
    return pathProblem(path, false);
}

/** why a folder path (`mock/api`) can't be used, or "" */
export function folderPathProblem(path: string): string {
    if (!path) return "folder name is empty";
    return pathProblem(path, true);
}

/** script name → file path (per-segment sanitized); identical for any valid name */
export function scriptFileName(name: string): string {
    const segs = (name || "").split("/");
    const out = segs.map((seg, i) => {
        let base = seg.replace(FORBIDDEN, "_").replace(/[. ]+$/, "").slice(0, MAX_NAME);
        if (!base || base === ".") base = i === segs.length - 1 ? "script" : "_";
        if (RESERVED.test(base)) base += "_";
        return base;
    });
    return out.join("/") + ".ts";
}

/**
 * Identity of a script's file on any disk: macOS and Windows file systems
 * ignore case, so "Foo" and "foo" would share (and overwrite) one file.
 */
export function scriptFileKey(name: string): string {
    return scriptFileName(name).toLowerCase();
}

/** `base`, or `base (2)`, `base (3)`… — the first whose file doesn't clash with `taken` */
export function uniqueScriptName(base: string, taken: string[]): string {
    const keys = new Set(taken.map(scriptFileKey));
    if (!keys.has(scriptFileKey(base))) return base;
    for (let i = 2; ; i++) {
        const next = `${base} (${i})`;
        if (!keys.has(scriptFileKey(next))) return next;
    }
}

/** file path → script name (exact) */
export function scriptNameFromFile(fileName: string): string {
    return fileName.replace(/\.ts$/, "") || "Imported script";
}
