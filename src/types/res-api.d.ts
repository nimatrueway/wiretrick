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

    /** Options for the res.onDom hook (see res.onDom docs). */
    interface DomOptions {
        watch?: boolean;
        watchInterval?: number;
        maxRuns?: number;
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
     * Run a handler in the page (MAIN world) when the DOM is ready — the
     * resilient way to change titles, text, and DOM content.
     *
     * WHEN IT RUNS (default): the handler executes exactly once, when
     * `DOMContentLoaded` fires — the full document is parsed and queryable,
     * but stylesheets/images may still be loading and framework hydration
     * (React/Vue) has NOT necessarily finished. If the script bundle arrives
     * after DOMContentLoaded already fired (late bundle, bfcache restore),
     * the handler runs immediately at registration instead.
     *
     * Because it runs as page JS it works no matter how the response
     * arrived — service-worker-served HTML, cached pages, or hydration
     * overwriting a network-tier transform.
     *
     * SPA CAVEAT: pushState soft-navigations do NOT refire
     * DOMContentLoaded. Pass `{ watch: true }` to re-run on DOM mutations.
     *
     * @param handler  (ctx) => void — same ctx shape as onRequest (url,
     *                 method, tabUrl, ...). May be async (fire-and-forget).
     * @param opts     Optional behavior:
     *   watch         — re-run the handler on DOM mutations (childList,
     *                   subtree, characterData). Use for SPA soft navigations
     *                   and hydration re-renders. Default: false.
     *   watchInterval — debounce in ms between watch-triggered runs.
     *                   Default: 250. Higher = less CPU on chatty pages.
     *   maxRuns       — safety cap on total executions per page load.
     *                   Default: 1 without watch, unlimited with watch.
     *
     * @example
     * res.onDom(() => { document.title = "🎯 " + document.title; });
     *
     * @example
     * // SPA: keep re-applying as React re-renders
     * res.onDom(() => {
     *     const el = document.querySelector("h1");
     *     if (el) el.textContent = "Intercepted";
     * }, { watch: true, watchInterval: 500, maxRuns: 100 });
     */
    onDom(
        handler: (ctx: ResOverride.RequestCtx) => void | Promise<void>,
        opts?: ResOverride.DomOptions
    ): void;
};
