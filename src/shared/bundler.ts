/**
 * Minimal ES-module bundler for user scripts.
 *
 * A script may use standard TS import syntax to pull in library modules
 * that live in the scripts folder's subdirectories (e.g.
 * `import { x } from "./lib/helpers"`). Each module (entry + libs) is
 * transpiled to CJS with sucrase (types stripped, imports → require,
 * exports → exports assignments) and inlined into a single runnable
 * IIFE with a tiny CommonJS runtime.
 *
 * Rules:
 *  - only static imports (`import … from "…"`); dynamic import() is not bundled
 *  - relative specifiers ("./lib/helpers") resolve against the scripts
 *    folder root, probing .ts/.tsx/.js/.jsx and /index.*
 *  - bare specifiers (npm packages) and URLs are not resolvable — they
 *    compile to a throwing stub with a clear message
 *  - cycles are handled the way Node CJS handles them (partial exports)
 */
import { transform } from "sucrase";

export interface BundleResult {
    code: string;
    /** module ids actually pulled in */
    deps: string[];
    error: string | null;
}

export type LibLookup = (id: string) => string | null;

const EXTS = [".ts", ".tsx", ".js", ".jsx"];

function dirname(id: string): string {
    const i = id.lastIndexOf("/");
    return i === -1 ? "" : id.slice(0, i);
}

function joinRel(dir: string, spec: string): string {
    const parts = dir ? dir.split("/") : [];
    for (const seg of spec.split("/")) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return parts.join("/");
}

function isRelative(spec: string): boolean {
    return spec.startsWith("./") || spec.startsWith("../");
}

function toCjs(code: string, filePath: string): string {
    return transform(code, {
        transforms: ["typescript", "imports"],
        filePath,
    }).code;
}

const REQUIRE_RE = /require\(\s*(['"])([^'"\n]+)\1\s*\)/g;

export async function bundleEntry(entryCode: string, lookup: LibLookup): Promise<BundleResult> {
    const modules = new Map<string, string>();
    const deps: string[] = [];
    let error: string | null = null;

    async function addModule(id: string, source: string): Promise<void> {
        if (modules.has(id)) return;
        let cjs: string;
        try {
            cjs = toCjs(source, id);
        } catch (e: any) {
            error = `module ${id}: ${e.message || e}`;
            return;
        }
        modules.set(id, cjs); // set before recursing (cycles → partial exports)

        const rewrites: [string, string][] = [];
        for (const m of cjs.matchAll(REQUIRE_RE)) {
            const spec = m[2];
            if (!isRelative(spec)) continue;
            const resolved = await resolveId(spec, id, lookup);
            if (resolved === null) {
                rewrites.push([m[0], `(() => { throw new Error("ResScript: cannot resolve import '${spec}' — add the file under the scripts folder (e.g. lib/)"); })()`]);
                error = error || `unresolved import '${spec}' in ${id}`;
            } else {
                rewrites.push([m[0], `require(${JSON.stringify(resolved)})`]);
                deps.push(resolved);
                const src = lookup(resolved);
                if (src !== null) await addModule(resolved, src);
            }
        }
        for (const [from, to] of rewrites) {
            cjs = cjs.split(from).join(to);
        }
        modules.set(id, cjs);
    }

    async function resolveId(spec: string, fromId: string, lk: LibLookup): Promise<string | null> {
        const base = joinRel(dirname(fromId), spec);
        const tryList = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => base + "/index" + e)];
        for (const c of tryList) {
            if (lk(c) !== null) return c;
        }
        return null;
    }

    let entryCjs: string;
    try {
        entryCjs = toCjs(entryCode, "(entry)");
    } catch (e: any) {
        return { code: entryCode, deps: [], error: `entry: ${e.message || e}` };
    }

    const rewrites: [string, string][] = [];
    for (const m of entryCjs.matchAll(REQUIRE_RE)) {
        const spec = m[2];
        if (!isRelative(spec)) continue;
        const resolved = await resolveId(spec, "", lookup);
        if (resolved === null) {
            rewrites.push([m[0], `(() => { throw new Error("ResScript: cannot resolve import '${spec}' — add the file under the scripts folder (e.g. lib/)"); })()`]);
            error = error || `unresolved import '${spec}'`;
        } else {
            rewrites.push([m[0], `require(${JSON.stringify(resolved)})`]);
            deps.push(resolved);
            const src = lookup(resolved);
            if (src !== null) await addModule(resolved, src);
        }
    }
    for (const [from, to] of rewrites) {
        entryCjs = entryCjs.split(from).join(to);
    }

    if (modules.size === 0) {
        // no imports resolved — plain transpiled entry
        return { code: entryCjs, deps: [], error };
    }

    const factories = [...modules.entries()]
        .map(([id, cjs]) => `__f[${JSON.stringify(id)}] = function (exports, require, module) {\n${cjs}\n};`)
        .join("\n");

    const bundle = `(() => {
const __f = {};
const __c = {};
function __rq(id) {
    if (__c[id]) return __c[id].exports;
    const mod = { exports: {} };
    __c[id] = mod;
    __f[id](mod.exports, (s) => __rq(s), mod);
    return mod.exports;
}
${factories}
__f["(entry)"] = function (exports, require, module) {
${entryCjs}
};
__rq("(entry)");
})();`;

    return { code: bundle, deps: [...new Set(deps)], error };
}
