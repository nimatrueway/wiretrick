/**
 * Script metadata. A script is ACTIVE when it is an entry file (named
 * `*.wiretrick.ts` / `*.wiretrick.tsx`) and its top-level code registers
 * at least one handler (wt.onRequest(route, fn), …); any other file is a
 * library — inert on its own, importable by others.
 */
import { scriptUrls, type RouteMeta } from "./route";
import { isEntryName } from "./scriptName";

export type { Strategy } from "./route";

export interface ResMeta {
    name: string;
    /** wt.about(text) */
    description?: string;
    /** registered at least one handler at top level (else: utility) */
    active: boolean;
    routes: RouteMeta[];
    /** union of route urls — badge / "active on this tab" only, never dispatch */
    match: string[];
    /** handlers a non-entry file registered (they don't run: only *.wiretrick.ts files do) */
    inert?: number;
}

export const DEFAULT_META: ResMeta = {
    name: "Untitled script",
    active: false,
    routes: [],
    match: [],
};

/** Fresh default meta with a fallback display name (e.g. the file name). */
export function defaultMeta(name?: string): ResMeta {
    return { ...DEFAULT_META, routes: [], match: [], name: name || DEFAULT_META.name };
}

/** fill the derived fields from routes; a named file that isn't an entry runs nothing (its handlers count as `inert`) */
export function finishMeta(meta: ResMeta, name?: string): ResMeta {
    if (name !== undefined && meta.routes.length && !isEntryName(name)) {
        meta.inert = meta.routes.length;
        meta.routes = [];
    }
    meta.active = meta.routes.length > 0;
    meta.match = scriptUrls(meta.routes);
    return meta;
}
