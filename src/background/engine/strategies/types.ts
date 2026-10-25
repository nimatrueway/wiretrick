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
    /** onBeforeRequest with the "requestBody" extraInfoSpec */
    requestBody?: { raw?: { bytes?: ArrayBuffer; file?: string }[]; formData?: { [name: string]: string[] }; error?: string } | null;
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
    /** full script source — the hook compiles it locally so closures survive */
    code: string;
    meta: import("../../../shared/metaParser").ResMeta;
}

export type MaybePromise<T> = T | Promise<T>;

export interface InterceptionStrategy {
    readonly name: string;

    /** True if this strategy can stream-modify bodies in this browser. */
    supportsBodyModification(): boolean;

    /**
     * Decide what to do with a request before it goes out.
     * May return a promise on Firefox (blocking webRequest accepts them).
     */
    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HookDisposition>;

    /** Apply response header changes, if any (promise on Firefox). */
    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null>;

    /** Apply request header changes, if any (promise on Firefox). */
    handleBeforeSendHeaders(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null>;

    /** free per-request caches for a request that will never complete normally */
    pruneRequest?(requestId: string): void;

    dispose(): void;
}
