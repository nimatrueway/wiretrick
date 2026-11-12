/**
 * A package's metadata. A single script declares it in its code, read when
 * it compiles:
 *
 *     tt.metadata({ name: "GitHub dark mode", version: "1.2.0", connect: ["api.github.com"] });
 *
 * A bundle — scripts that install and update together — is a folder with a
 * metadata.json at its root, which lists them:
 *
 *     { "name": "GitHub tweaks", "version": "2.0.0",
 *       "scripts": ["dark.ts", "pr-tools.ts"] }
 *
 * `connect` names the hosts the scripts' tt.fetch calls reach; the install
 * page shows them and an update that adds one asks for approval.
 * `updateURL` is where updates come from instead of where it was installed
 * from (any source parseSource reads); a package from local files with
 * one updates too.
 */
import { parseSource } from "./packageSource";

export interface PackageMetadata {
    name?: string;
    version?: string;
    description?: string;
    /** relative .svg/.png/… path, data: URL, https:// URL, or inline <svg> */
    icon?: string;
    homepage?: string;
    author?: string;
    license?: string;
    /** where updates come from (a script, metadata.json or .zip URL, a GitHub file or folder, a gist) */
    updateURL?: string;
    connect: string[];
}

/** a bundle's metadata.json */
export interface Manifest extends PackageMetadata {
    /** its entry files, relative to the manifest's folder */
    scripts: string[];
}

export const MANIFEST_FILE = "metadata.json";

/** a bundle's manifest (at any folder depth) */
export const isManifestPath = (path: string): boolean => path === MANIFEST_FILE || path.endsWith("/" + MANIFEST_FILE);

const TEXT_KEYS = ["name", "version", "description", "icon", "homepage", "author", "license", "updateURL"] as const;

/** validate tt.metadata's argument or a manifest's fields (unknown keys are ignored: a newer script may add some) */
export function readMetadata(raw: unknown, where: string): PackageMetadata {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
    const r = raw as Record<string, unknown>;
    const out: PackageMetadata = { connect: [] };
    for (const k of TEXT_KEYS) {
        const v = r[k];
        if (v === undefined) continue;
        if (typeof v !== "string") throw new Error(`${where}: "${k}" must be a string`);
        if (v.trim()) out[k] = v.trim();
    }
    if (out.updateURL) {
        const src = parseSource(out.updateURL);
        if (typeof src === "string") throw new Error(`${where}: "updateURL" — ${src}`);
    }
    if (r.connect !== undefined) {
        if (!Array.isArray(r.connect) || r.connect.some((h) => typeof h !== "string")) throw new Error(`${where}: "connect" must be a list of host names`);
        out.connect = [...new Set((r.connect as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean))];
    }
    return out;
}

/** a bundle's metadata.json, or why it isn't one */
export function parseManifest(text: string, where = MANIFEST_FILE): Manifest {
    let raw: any;
    try {
        raw = JSON.parse(text);
    } catch (e: any) {
        throw new Error(`${where} isn't valid JSON: ${e?.message || e}`);
    }
    const m = readMetadata(raw, where);
    const list = raw.scripts;
    if (!Array.isArray(list) || !list.length || list.some((x: unknown) => typeof x !== "string"))
        throw new Error(`${where}: "scripts" must list the bundle's scripts`);
    const scripts = (list as string[]).map((p) => p.trim().replace(/^\.\//, ""));
    for (const p of scripts)
        if (!/\.tsx?$/i.test(p) || p.startsWith("/") || p.split("/").includes(".."))
            throw new Error(`${where}: "${p}" in "scripts" isn't a .ts or .tsx file in the bundle's folder`);
    return { ...m, scripts: [...new Set(scripts)] };
}

/** metadata.json's JSON schema: the Editor's completions and checks */
export const MANIFEST_SCHEMA = {
    type: "object",
    required: ["scripts"],
    properties: {
        name: { type: "string", description: "The bundle's name, shown when installing and in the Explorer" },
        version: { type: "string", description: 'Dotted version ("1.2.0"); an update to a lower one waits for review' },
        description: { type: "string", description: "One line about what it does" },
        icon: { type: "string", description: "Icon shown in the Explorer and popup: a relative .svg/.png/… file path in this folder, a data: or https:// URL, or inline <svg>" },
        homepage: { type: "string", description: "A link shown when installing" },
        author: { type: "string" },
        license: { type: "string" },
        updateURL: {
            type: "string",
            description: "Where updates come from instead of where it was installed from: a metadata.json, script or .zip URL, a GitHub folder or file, a gist (an update that changes it waits for review)",
        },
        connect: { type: "array", items: { type: "string" }, uniqueItems: true, description: "Hosts the scripts' tt.fetch calls reach; an update that adds one waits for review" },
        scripts: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: "\\.tsx?$" },
            description: "The bundle's scripts (.ts / .tsx), relative to this folder — they install and update together, with what they import",
        },
    },
};

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
