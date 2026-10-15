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

    interface RespondOptions {
        /** Response body: string, bytes, or any object (JSON-serialized). */
        body: string | Uint8Array | object;
        /** Response status. Default 200. */
        status?: number;
        /** Content-Type. Default guessed from the request URL extension. */
        mime?: string;
        /** Extra response headers. */
        headers?: { set?: { [name: string]: string } };
    }

    interface RequestResult {
        /** Respond immediately without contacting the network (terminal). */
        respond?: RespondOptions;
        /** Redirect the request to another URL (terminal). */
        redirect?: string;
        /** Block the request entirely (terminal). */
        cancel?: boolean;
        /** Modify request headers (non-terminal; applied on the way out). */
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
        when?: "DOMContentLoaded" | "document_start" | "document_end" | "document_idle";
    }

    // ---- declareScript: declarative meta + typed parameters ----

    interface ParamDefBoolean {
        type: "boolean";
        default?: boolean;
        description?: string;
    }
    interface ParamDefNumber {
        type: "number";
        default?: number;
        description?: string;
        /** optional bounds — the UI clamps typed values */
        min?: number;
        max?: number;
        /** step for the number input (default 1; use e.g. 0.1 for decimals) */
        step?: number;
    }
    interface ParamDefString {
        type: "string";
        default?: string;
        description?: string;
    }
    interface ParamDefEnum {
        type: "enum";
        choices: string[];
        default?: string;
        description?: string;
    }
    interface ParamDefStringList {
        type: "stringList";
        default?: string[];
        description?: string;
    }
    type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList;

    type ParamValue<D extends ParamDef> = D extends ParamDefBoolean
        ? boolean
        : D extends ParamDefNumber
          ? number
          : D extends ParamDefString
            ? string
            : D extends ParamDefEnum
              ? D["choices"][number]
              : D extends ParamDefStringList
                ? string[]
                : never;

    /** Resolved parameter values, typed from the defs you passed. */
    type ParamsOf<T extends Record<string, ParamDef>> = {
        readonly [K in keyof T]: ParamValue<T[K]>;
    };

    interface ScriptDef<T extends Record<string, ParamDef> = Record<string, ParamDef>> {
        /** URL patterns the script activates on. */
        match?: string[];
        include?: string[];
        /** Interception tier priority list (overrides @strategy). */
        strategy?: ("auto" | "hook" | "proxy" | "cdp" | "webrequest")[];
        /** Which interception events run (default: both). */
        phase?: ("request" | "response")[];
        /** Default onDom timing (overrides @run-at). */
        runAt?: "document_start" | "document_end" | "document_idle" | "DOMContentLoaded";
        /**
         * Adjustable parameters — editable from the popup's ⚙ dialog and
         * the manager without touching the script. Returned typed.
         */
        params?: T;
    }
}

/**
 * The global script API.
 *
 * STACKING (multiple scripts matching one request) — scripts run in list
 * order (top to bottom in the manager):
 *  - onRequest: first script returning a TERMINAL result (redirect/cancel)
 *    wins and stops the chain; non-terminal results (headers-only, void)
 *    don't stop it. Header changes from the winning script apply.
 *  - onResponseHeaders: ALL matching scripts run; `set` applied in order
 *    (later overwrites), `remove` accumulates.
 *  - modifyResponse: transforms COMPOSE — each script's output is the next
 *    script's input, in list order.
 *  - replaceResponse: first script returning a body wins; later ones skip.
 *
 * ASYNC: every hook accepts an async handler (a Promise-returning function).
 * Result handling differs per tier — see the README's "Async handlers"
 * section. Short version: async replaceResponse/modifyResponse/onDom work
 * everywhere; async onRequest/onResponseHeaders are honored natively on
 * Firefox, and on Chrome require 'cdp' in @strategy (a warning is logged
 * otherwise and the result is ignored).
 */
declare const res: {
    /**
     * Intercept a request before it is sent. Return { respond }, { redirect },
     * { cancel }, { headers } or a combination. May be async — see the
     * stacking/async notes above (on Chrome the async result is honored in
     * the cdp tier, @strategy hook,cdp).
     *
     * TERMINAL results (first one wins, stops the script chain):
     *   respond  — synthesize the response immediately; the network is never
     *              contacted. body/status/mime/headers all honored on the
     *              hook and cdp tiers; the webRequest tier serves it as a
     *              data-URL redirect (status becomes 200 there).
     *   redirect — continue at another URL.
     *   cancel   — fail the request.
     * NON-terminal: { headers } — applies and lets later scripts run.
     *
     * @example
     * res.onRequest((ctx) => {
     *     if (ctx.url.includes("/user")) return {
     *         respond: { body: { id: 1, name: "Mock" }, mime: "application/json" },
     *     };
     * });
     */
    onRequest(
        handler: (ctx: ResOverride.RequestCtx) => ResOverride.RequestResult | void | Promise<ResOverride.RequestResult | void>
    ): void;

    /**
     * Inspect / modify response headers. May be async — see the stacking /
     * async notes above.
     */
    onResponseHeaders(
        handler: (ctx: ResOverride.ResponseHeaderCtx) => ResOverride.ResponseHeaderResult | void | Promise<ResOverride.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, Uint8Array, or
     * { file: "<path or data url>" }. Return nothing to leave the body alone.
     * May be async — the awaited result fulfills the response (hook tier
     * short-circuits the page's fetch/XHR; cdp tier fulfills the network
     * response).
     */
    replaceResponse(
        handler: (ctx: ResOverride.ReplaceCtx) => string | Uint8Array | { file: string } | null | void | Promise<string | Uint8Array | { file: string } | null | void>
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
     * Run a handler in the page (MAIN world) — the resilient way to change
     * titles, text, and DOM content. Works no matter how the response
     * arrived (service-worker-served HTML, cached pages, hydration).
     *
     * @param handler  (ctx) => void — same ctx shape as onRequest. May be
     *                 async (fire-and-forget).
     * @param opts.when  When to run the handler (mirrors content-script
     *   run_at moments; defaults to "DOMContentLoaded"):
     *
     *   "DOMContentLoaded" (default)
     *       Full DOM is parsed and queryable, but stylesheets/images may
     *       still be loading and framework hydration (React/Vue) has NOT
     *       necessarily finished. The usual choice for title/DOM tweaks.
     *       If the script bundle arrives after DOMContentLoaded already
     *       fired (late bundle, bfcache restore), the handler runs
     *       immediately instead.
     *
     *   "document_start"
     *       Runs immediately at hook install — before the page's scripts
     *       execute and before the DOM body exists. Use to register
     *       observers or stub page APIs ahead of page code. document.body
     *       is NOT available yet.
     *
     *   "document_end"
     *       DOM fully parsed (same moment as DOMContentLoaded in practice);
     *       provided for symmetry with content-script run_at values.
     *
     *   "document_idle"
     *       After the window `load` event — page fully settled, all
     *       resources loaded. Safest moment to measure final state; slowest.
     *       If load already happened, runs immediately.
     *
     * @example
     * res.onDom(() => { document.title = "🎯 " + document.title; });
     *
     * @example
     * res.onDom(() => {
     *     const el = document.querySelector("h1");
     *     if (el) el.textContent = "Intercepted";
     * }, { when: "document_idle" }); // after everything settled
     */
    onDom(
        handler: (ctx: ResOverride.RequestCtx) => void | Promise<void>,
        opts?: { when?: "DOMContentLoaded" | "document_start" | "document_end" | "document_idle" }
    ): void;

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

    /**
     * Declarative script definition — the type-safe way to set the meta
     * (name/match/strategy/runAt) and declare adjustable parameters.
     * Anything you pass here overrides the ==ResScript== comment block.
     *
     * Returns the resolved parameter values (stored UI values merged over
     * your defaults), typed from your `params` defs — so the script never
     * hard-codes toggles; users change them from the ⚙ dialog in the popup
     * or the manager.
     *
     * @example
     * const cfg = res.declareScript({
     *     name: "Force-fail inference",
     *     match: ["*://cloud*.mongodb.com/*"],
     *     strategy: ["hook", "cdp"],
     *     params: {
     *         enabled: { type: "boolean", default: true, description: "Return 500s" },
     *         status:  { type: "enum", choices: ["500", "503"], default: "500" },
     *         note:    { type: "string", default: "API force failed" },
     *         extra:   { type: "stringList", default: [] },
     *     },
     * });
     * res.onRequest((ctx) => cfg.enabled ? { respond: { status: Number(cfg.status), body: { error: cfg.note } } } : undefined);
     */
    declareScript<T extends Record<string, ResOverride.ParamDef>>(
        def: ResOverride.ScriptDef<T>
    ): ResOverride.ParamsOf<T>;
};
