/**
 * A package's metadata: the JSDoc block at the top of its entry file,
 * readable without running any code (the install page shows it before
 * anything compiles).
 *
 *     /**
 *      * @name GitHub dark mode
 *      * @version 1.2.0
 *      * @description Forces the dark theme on github.com
 *      * @homepage https://github.com/me/scripts
 *      * @connect api.github.com
 *      *\/
 *
 * `@connect` names the hosts the script's wt.fetch calls reach (repeat
 * it, or list several separated by spaces); the install page shows them
 * and an update that adds one asks for approval.
 */

export interface PackageHeader {
    name?: string;
    version?: string;
    description?: string;
    homepage?: string;
    author?: string;
    license?: string;
    connect: string[];
}

/** the header of an entry file (empty when it has none) */
export function parseHeader(code: string): PackageHeader {
    const out: PackageHeader = { connect: [] };
    // only comments and blank lines may come before it
    const m = /^(?:\s|\/\/[^\n]*\n)*\/\*\*([\s\S]*?)\*\//.exec(code);
    if (!m) return out;
    let last: string | null = null;
    for (const raw of m[1].split("\n")) {
        const line = raw.replace(/^\s*\*?\s?/, "").trimEnd();
        const tag = /^@(\w+)\s*(.*)$/.exec(line);
        if (!tag) {
            // a description continues on the lines below its tag
            if (last === "description" && line.trim()) out.description += " " + line.trim();
            else last = null;
            continue;
        }
        const key = tag[1].toLowerCase();
        const value = tag[2].trim();
        last = key;
        if (key === "connect") out.connect.push(...value.split(/[\s,]+/).filter(Boolean));
        else if (key === "name" || key === "version" || key === "description" || key === "homepage" || key === "author" || key === "license") {
            if (value && out[key] === undefined) out[key] = value;
        }
    }
    out.connect = [...new Set(out.connect.map((h) => h.toLowerCase()))];
    return out;
}

/** compare dotted versions ("1.10.0" > "1.9"); non-numeric parts compare as text */
export function compareVersions(a: string | undefined, b: string | undefined): number {
    const pa = (a || "").split(/[.+-]/);
    const pb = (b || "").split(/[.+-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? "0";
        const y = pb[i] ?? "0";
        const nx = /^\d+$/.test(x) ? Number(x) : NaN;
        const ny = /^\d+$/.test(y) ? Number(y) : NaN;
        const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
        if (c) return c < 0 ? -1 : 1;
    }
    return 0;
}
