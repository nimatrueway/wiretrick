/**
 * Shared per-strategy plumbing: which handler routes a strategy owns, and MV2
 * in-page compilation of the scripts that own them (MV3 compiles in the
 * sandbox instead — see compileHost).
 */
import { compileScript, makeModuleResolver, makeScriptOverrides, type CompiledScript } from "../../../shared/compile";
import { effectiveStrategy, type RouteMeta, type Strategy } from "../../../shared/route";
import type { ResMeta } from "../../../shared/metaParser";
import { scriptLogLine } from "../../../shared/scriptLog";
import { log } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { dataFilesSnapshot } from "../dataFiles";

export interface ScriptLike {
    id: string;
    code: string;
    enabled: boolean;
    meta: ResMeta;
}

export interface OwnedRoute {
    id: string;
    name: string;
    route: RouteMeta;
}

/** enabled scripts' request routes (onDocument excluded) whose effective strategy is `tier` */
export function ownedRoutes(scripts: ScriptLike[], tier: Strategy): OwnedRoute[] {
    const out: OwnedRoute[] = [];
    for (const s of scripts) {
        if (!s.enabled || !s.meta.active) continue;
        for (const r of s.meta.routes || []) {
            if (r.kind !== "onDocument" && effectiveStrategy(r) === tier) out.push({ id: s.id, name: s.meta.name, route: r });
        }
    }
    return out;
}

export interface CompiledEntry {
    id: string;
    name: string;
    compiled: CompiledScript;
}

/**
 * MV2: compile the enabled scripts `want` selects, with real params and
 * imports. `name` is the STORED script name (log attribution).
 */
export function compileMv2(scripts: ScriptLike[], paramValues: { [scriptId: string]: Record<string, any> } | undefined, want: (s: ScriptLike) => boolean): CompiledEntry[] {
    let resolveFrom: (importer: string) => (spec: string) => any = () => (spec) => {
        throw new Error(`cannot import "${spec}" before the module registry is ready`);
    };
    const overridesFor = (s: { id: string; name: string; code: string }) =>
        makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, level, source, text) => log(-1, scriptLogLine(s.name, source, text), level, id), paramValues?.[s.id], (spec) => resolveFrom(s.name)(spec));
    resolveFrom = makeModuleResolver(
        scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
        overridesFor,
        { dataFiles: dataFilesSnapshot() }
    ).resolveFrom;
    const out: CompiledEntry[] = [];
    for (const s of scripts) {
        if (!s.enabled || !want(s)) continue;
        const compiled = compileScript(s.code, overridesFor({ id: s.id, name: s.meta.name, code: s.code }));
        // errored compiles stay in so the strategy logs the error (meta.active is false then)
        if (compiled.meta.active || compiled.error) out.push({ id: s.id, name: s.meta.name, compiled });
    }
    return out;
}

/** does the script own any route on `tier` (from its analyzed meta)? */
export function ownsAny(s: ScriptLike, tier: Strategy): boolean {
    return (s.meta.routes || []).some((r) => r.kind !== "onDocument" && effectiveStrategy(r) === tier);
}
