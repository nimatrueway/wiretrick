/**
 * Public `wt` API typings — shipped into the editor as an extra lib and
 * written into the VS Code folder so scripts get full IntelliSense.
 */

declare namespace Wiretrick {
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

    /** Options for wt.onDom (2nd argument). */
    interface DomOptions {
        /**
         * WHEN the onDom handler runs, relative to the page's own loading.
         * Default: "DOMContentLoaded".
         *
         * HOW IT GETS THERE — in every frame (top page AND iframes) the
         * extension injects a small hook at document_start. The hook asks
         * the background for the scripts whose `match` covers THAT FRAME'S
         * URL, compiles them, and then schedules each script's handler
         * according to its own `when`:
         *
         * "document_start"
         *   Runs as soon as the script is compiled, while the HTML is still
         *   being parsed. `document.documentElement` exists; `document.head`
         *   and `document.body` are usually still null, so querySelector
         *   finds (almost) nothing. Use it to get in AHEAD of page code:
         *   stub or wrap globals (`window.fetch`, `navigator.*`), set up a
         *   MutationObserver on `document`, add capture-phase listeners.
         *   Race caveat: in the MV2 build the script arrives within ~1ms
         *   and reliably beats the page's scripts. In the MV3 build a cold
         *   service worker can take ~50-100ms to answer, so inline
         *   `<script>`s early in the page MAY already have run. Don't rely
         *   on winning that race for correctness — use a network handler
         *   (modifyResponse) when you must change what page code sees.
         *
         * "DOMContentLoaded" (default)
         *   The whole HTML is parsed and queryable, and `defer`/module
         *   scripts have run. Images, stylesheets and iframes may still be
         *   loading, and frameworks (React, Vue, ...) may not have hydrated
         *   yet — a framework can re-render and overwrite your change. The
         *   right choice for most title/text/attribute tweaks. If the page
         *   is already past this point when the script arrives (slow
         *   bundle, bfcache restore), the handler runs immediately.
         *
         * "document_end"
         *   Exactly the same moment as "DOMContentLoaded" — an alias that
         *   matches the content-script `run_at` spelling.
         *
         * "document_idle"
         *   After the window `load` event: every subresource (images,
         *   stylesheets, iframes, async scripts) has finished. Best for
         *   reading final layout/sizes or tweaking content that a page
         *   script builds during load. The slowest choice — one hanging
         *   image or ad iframe delays it. If `load` already fired, runs
         *   immediately. Note: unlike Chrome's content-script
         *   "document_idle" (which can fire before `load`), this ALWAYS
         *   waits for `load`.
         *
         * APPLIES TO EVERY VALUE:
         * - Runs ONCE per document load, per matching frame. SPA route
         *   changes (pushState) and framework re-renders do NOT re-run it —
         *   start a MutationObserver inside the handler to keep re-applying.
         * - Editing and saving the script while the page is open re-runs
         *   the handler IMMEDIATELY, regardless of `when` (live update) —
         *   so make handlers idempotent (safe to run twice).
         * - One onDom per script: a later wt.onDom call replaces the
         *   earlier one, including its `when`. Each script's `when` is
         *   independent of other scripts'; handlers with the same `when`
         *   run in script-list order.
         * - Async handlers are not awaited; `when` controls only when they
         *   START.
         * - The handler runs in the page's MAIN world (sees page globals).
         *   If the page's CSP forbids eval, it falls back to the
         *   extension's isolated world: same DOM and same timing, but
         *   page-defined globals (e.g. `window.myApp`) are not visible.
         *
         * @example
         * wt.onDom(() => { document.title = "🎯 " + document.title; }); // DOMContentLoaded
         *
         * @example
         * // before page scripts (best effort, see race caveat)
         * wt.onDom(() => {
         *     Object.defineProperty(navigator, "webdriver", { get: () => false });
         * }, { when: "document_start" });
         *
         * @example
         * // after everything loaded, then keep it applied across re-renders
         * wt.onDom(() => {
         *     const apply = () => document.querySelectorAll(".ad").forEach((e) => e.remove());
         *     apply();
         *     new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
         * }, { when: "document_idle" });
         */
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
        /** edit in a textarea; values with newlines are written as YAML block scalars in settings.yaml */
        multiline?: boolean;
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
        /** Interception tier priority list. */
        strategy?: ("auto" | "hook" | "cdp" | "webrequest" | "process")[];
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
 * Firefox, and on Chromium require "cdp" or "process" in the strategy list (a warning is logged
 * otherwise and the result is ignored).
 */
declare const wt: {
    /**
     * Intercept a request before it is sent. Return { respond }, { redirect },
     * { cancel }, { headers } or a combination. May be async — see the
     * stacking/async notes above (on Chrome the async result is honored in
     * the cdp tier, strategy: ["hook", "cdp"]).
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
     * wt.onRequest((ctx) => {
     *     if (ctx.url.includes("/user")) return {
     *         respond: { body: { id: 1, name: "Mock" }, mime: "application/json" },
     *     };
     * });
     */
    onRequest(
        handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.RequestResult | void | Promise<Wiretrick.RequestResult | void>
    ): void;

    /**
     * Inspect / modify response headers. May be async — see the stacking /
     * async notes above.
     */
    onResponseHeaders(
        handler: (ctx: Wiretrick.ResponseHeaderCtx) => Wiretrick.ResponseHeaderResult | void | Promise<Wiretrick.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, Uint8Array, or
     * { file: "<path or data url>" }. Return nothing to leave the body alone.
     * May be async — the awaited result fulfills the response (hook tier
     * short-circuits the page's fetch/XHR; cdp tier fulfills the network
     * response).
     */
    replaceResponse(
        handler: (ctx: Wiretrick.ReplaceCtx) => string | Uint8Array | { file: string } | null | void | Promise<string | Uint8Array | { file: string } | null | void>
    ): void;

    /**
     * Stream-transform the response body. The transform receives the original
     * body (string or bytes) and returns the new body.
     * On Firefox this is network-level (filterResponseData). On Chromium it runs
     * via the JS network hook (page-initiated requests), CDP when
     * strategy: ["cdp"] is set, or the local helper with strategy: ["process"].
     */
    modifyResponse(
        transform: (
            ctx: Wiretrick.BodyCtx,
            body: string | Uint8Array
        ) => string | Uint8Array | Promise<string | Uint8Array>
    ): void;

    /** Per-script key/value storage. */
    storage: Wiretrick.Storage;

    /** Log to the manager's log panel for the current tab. */
    log(...args: unknown[]): void;

    /**
     * Run a handler in the page (MAIN world) — the resilient way to change
     * titles, text, and DOM content. Works no matter how the response
     * arrived (service-worker-served HTML, cached pages, hydration).
     *
     * Runs once per document load in every frame whose URL matches the
     * script's `match` — by default at DOMContentLoaded.
     *
     * @param handler  (ctx) => void — same ctx shape as onRequest (`url`
     *                 is the frame's URL). May be async (not awaited).
     * @param opts.when  When to run: "DOMContentLoaded" (default) |
     *   "document_start" | "document_end" | "document_idle". See
     *   {@link Wiretrick.DomOptions.when} for exact timing, the MV3
     *   document_start race, SPA/re-render behavior and live-update re-runs.
     *
     * @example
     * wt.onDom(() => { document.title = "🎯 " + document.title; });
     *
     * @example
     * wt.onDom(() => {
     *     const el = document.querySelector("h1");
     *     if (el) el.textContent = "Intercepted";
     * }, { when: "document_idle" }); // after everything settled
     */
    onDom(
        handler: (ctx: Wiretrick.RequestCtx) => void | Promise<void>,
        opts?: Wiretrick.DomOptions
    ): void;

    /**
     * Declarative script definition — the ONLY way to activate a script:
     * sets the meta (match/include/strategy) and declares adjustable
     * parameters. Sources without it are importable library modules.
     *
     * Returns the resolved parameter values (stored UI values merged over
     * your defaults), typed from your `params` defs — so the script never
     * hard-codes toggles; users change them from the ⚙ dialog in the popup
     * or the manager.
     *
     * @example
     * const cfg = wt.declareScript({
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
     * wt.onRequest((ctx) => cfg.enabled ? { respond: { status: Number(cfg.status), body: { error: cfg.note } } } : undefined);
     */
    declareScript<T extends Record<string, Wiretrick.ParamDef>>(
        def: Wiretrick.ScriptDef<T>
    ): Wiretrick.ParamsOf<T>;
};
