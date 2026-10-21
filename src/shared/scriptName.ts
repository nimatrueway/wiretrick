/**
 * A script's name is its file name in the scripts folder (minus ".ts").
 * Anything a file name may hold on every OS is allowed; only what Windows,
 * macOS or Linux reject is excluded.
 */

/** forbidden somewhere: Windows `<>:"/\|?*` + control chars (and `/` everywhere) */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows device names, with or without an extension */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export const MAX_NAME = 100;

/** drop forbidden characters as the user types */
export function cleanScriptName(raw: string): string {
    return raw.replace(FORBIDDEN, "").slice(0, MAX_NAME);
}

/** why a (trimmed) name can't be used, or "" when it's fine */
export function scriptNameProblem(name: string): string {
    if (!name) return "name is empty";
    if (name.replace(FORBIDDEN, "") !== name) return 'names can\'t contain < > : " / \\ | ? *';
    if (/[. ]$/.test(name)) return "names can't end with a dot or space";
    if (RESERVED.test(name)) return `"${name}" is a reserved file name on Windows`;
    return "";
}

/** script name → file name; identical for any valid name */
export function scriptFileName(name: string): string {
    let base = (name || "").replace(FORBIDDEN, "_").replace(/[. ]+$/, "").slice(0, MAX_NAME);
    if (!base) base = "script";
    if (RESERVED.test(base)) base += "_";
    return base + ".ts";
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

/** file name → script name (exact) */
export function scriptNameFromFile(fileName: string): string {
    return fileName.replace(/\.ts$/, "") || "Imported script";
}

/** the old lossy mapping ("Redirect a URL" → "Redirect_a_URL.ts"), for migration */
export function legacyScriptFileName(name: string): string {
    return ((name || "script").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "script") + ".ts";
}
