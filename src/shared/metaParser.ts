/**
 * Script metadata. A script is ACTIVE when its top-level code registers at
 * least one handler (wt.onRequest(route, fn), …); a source that registers
 * nothing is a utility module — inert on its own, importable by others.
 */
import { scriptUrls, type RouteMeta } from "./route";

export type { Strategy } from "./route";

export interface ResMeta {
    name: string;
    /** wt.describe(text) */
    description?: string;
    /** registered at least one handler at top level (else: utility) */
    active: boolean;
    routes: RouteMeta[];
    /** union of route urls — badge / "active on this tab" only, never dispatch */
    match: string[];
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

/** fill the derived fields from routes */
export function finishMeta(meta: ResMeta): ResMeta {
    meta.active = meta.routes.length > 0;
    meta.match = scriptUrls(meta.routes);
    return meta;
}
