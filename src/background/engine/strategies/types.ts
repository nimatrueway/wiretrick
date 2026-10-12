/**
 * The interception strategy seam — the only MV2/MV3-sensitive layer.
 * Everything above this (pipeline, runtime, editor) is strategy-agnostic.
 */

export interface WebRequestDetailsLike {
    url: string;
    method: string;
    tabId: number;
    type: string;
    requestId: string;
    requestHeaders?: { name: string; value?: string }[];
    responseHeaders?: { name: string; value?: string }[];
    statusCode?: number;
    statusLine?: string;
}

export interface HeaderChanges {
    set?: { [name: string]: string };
    remove?: string[];
}

export type HookDisposition =
    | { kind: "allow" }
    | { kind: "redirect"; url: string }
    | { kind: "cancel" }
    | { kind: "headers"; changes: HeaderChanges }
    /** Chrome: body transform needed for a resource the hook can't see —
     *  let it proceed while the CDP strategy intercepts the response. */
    | { kind: "needsCdp" };

export interface BodyScriptInfo {
    scriptId: string;
    /** full script source — hook/proxy compile it locally so closures survive */
    code: string;
    meta: import("../../../shared/metaParser").ResMeta;
}

export interface InterceptionStrategy {
    readonly name: string;

    /** True if this strategy can stream-modify bodies in this browser. */
    supportsBodyModification(): boolean;

    /**
     * Decide what to do with a request before it goes out.
     * Called for every request; must return synchronously.
     */
    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): HookDisposition;

    /** Apply response header changes, if any. */
    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): HeaderChanges | null;

    /** Apply request header changes, if any. */
    handleBeforeSendHeaders(details: WebRequestDetailsLike, tabUrl: string | null): HeaderChanges | null;

    /**
     * Fetch + transform a body server-side (used by the Tier-B proxy worker
     * to obtain the transform for an original URL).
     */
    getTransformsForUrl(url: string, tabUrl: string | null): BodyScriptInfo[];

    /** free per-request caches for a request that will never complete normally */
    pruneRequest?(requestId: string): void;

    dispose(): void;
}
