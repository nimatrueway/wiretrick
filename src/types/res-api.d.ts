/**
 * Public `res` API typings — shipped into the editor as an extra lib and
 * written into the VS Code folder so scripts get full IntelliSense.
 */

declare namespace ResOverride {
    interface HeaderPair {
        name: string;
        value?: string;
    }

    interface RequestCtx {
        /** Full request URL. */
        url: string;
        method: string;
        /** URL of the top-level document that initiated the request. */
        tabUrl: string;
        /** webRequest resource type: main_frame, script, image, xmlhttprequest, ... */
        resourceType: string;
        /** Request headers as a plain object. */
        requestHeaders: { [name: string]: string };
    }

    interface HeaderMod {
        /** Set (or overwrite) these headers. */
        set?: { [name: string]: string };
        /** Remove these headers (case-insensitive). */
        remove?: string[];
    }

    interface RequestResult {
        /** Redirect the request to another URL. */
        redirect?: string;
        /** Block the request entirely. */
        cancel?: boolean;
        /** Modify request headers (applied on the way out). */
        headers?: HeaderMod;
    }

    interface ResponseHeaderCtx extends RequestCtx {
        /** HTTP status line, e.g. "HTTP/1.1 200 OK". */
        statusLine: string;
        /** Response headers as they came from the network. */
        responseHeaders: HeaderPair[];
    }

    interface ResponseHeaderResult {
        headers?: HeaderMod;
    }

    interface ReplaceCtx extends RequestCtx {
        /** Content-Type reported by the server, if known. */
        mime?: string;
    }

    interface BodyCtx extends ReplaceCtx {
        /** Response status code, when available. */
        status?: number;
    }

    interface Storage {
        get(key: string): Promise<any>;
        set(key: string, value: any): Promise<void>;
    }
}

/**
 * The global script API. Register exactly one handler per hook; the last
 * registration wins. Handlers for onRequest / onResponseHeaders must be
 * synchronous (Chrome's blocking webRequest cannot await promises).
 */
declare const res: {
    /**
     * Intercept a request before it is sent. Return { redirect }, { cancel },
     * { headers } or any combination.
     */
    onRequest(
        handler: (ctx: ResOverride.RequestCtx) => ResOverride.RequestResult | void
    ): void;

    /**
     * Inspect / modify response headers. Synchronous only.
     */
    onResponseHeaders(
        handler: (ctx: ResOverride.ResponseHeaderCtx) => ResOverride.ResponseHeaderResult | void
    ): void;

    /**
     * Replace the response body completely. Return a string, Uint8Array, or
     * { file: "<path or data url>" }. Return nothing to leave the body alone.
     */
    replaceResponse(
        handler: (ctx: ResOverride.ReplaceCtx) => string | Uint8Array | { file: string } | null | void
    ): void;

    /**
     * Stream-transform the response body. The transform receives the original
     * body (string or bytes) and returns the new body.
     * On Firefox this is network-level (filterResponseData). On Chrome it runs
     * via the JS network hook (page-initiated requests), the extension proxy
     * (other resources), or CDP when @strategy cdp is set.
     */
    modifyResponse(
        transform: (
            ctx: ResOverride.BodyCtx,
            body: string | Uint8Array
        ) => string | Uint8Array | Promise<string | Uint8Array>
    ): void;

    /** Per-script key/value storage. */
    storage: ResOverride.Storage;

    /** Log to the manager's log panel for the current tab. */
    log(...args: unknown[]): void;

    /**
     * Run at DOM-ready in the page (MAIN world). Use this for DOM and
     * document.title changes — especially on sites whose HTML is served
     * from a service worker (webRequest/CDP never see that response) or
     * where hydration re-renders your transformed markup.
     */
    onDom(handler: (ctx: ResOverride.RequestCtx) => void): void;
};
