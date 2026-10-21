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
         * **When** the `onDom` handler runs, relative to the page's own loading.
         * Default: `"DOMContentLoaded"`.
         *
         * **How it gets there:** in every frame (top page *and* iframes) the
         * extension injects a small hook at `document_start`. The hook asks
         * the background for the scripts whose `match` covers *that frame's*
         * URL, compiles them, and schedules each script's handler according
         * to its own `when`.
         *
         * | `when` | Fires | DOM state |
         * |---|---|---|
         * | `"document_start"` | as soon as the script is compiled | only `<html>`; `head`/`body` usually `null` |
         * | `"DOMContentLoaded"` *(default)* | HTML fully parsed | whole DOM queryable; images/iframes may still load |
         * | `"document_end"` | same as `DOMContentLoaded` | alias matching the content-script `run_at` spelling |
         * | `"document_idle"` | after window `load` | every subresource finished |
         *
         * **`"document_start"`** — runs while the HTML is still being parsed,
         * so `querySelector` finds (almost) nothing. Use it to get in *ahead*
         * of page code: stub or wrap globals (`window.fetch`, `navigator.*`),
         * observe `document` with a `MutationObserver`, add capture-phase
         * listeners.
         * - *Race caveat:* in the MV2 build the script arrives within ~1 ms and
         *   reliably beats the page's scripts. In the MV3 build a cold service
         *   worker can take ~50–100 ms to answer, so early inline `<script>`s
         *   **may already have run**. Don't rely on winning the race for
         *   correctness — use `modifyResponse` when you must change what page
         *   code sees.
         *
         * **`"DOMContentLoaded"`** — `defer`/module scripts have run; images,
         * stylesheets and iframes may still be loading, and frameworks (React,
         * Vue, …) may not have hydrated yet, so a re-render can overwrite your
         * change. The right choice for most title/text/attribute tweaks. If
         * the page is already past this point when the script arrives (slow
         * bundle, bfcache restore), the handler runs immediately.
         *
         * **`"document_idle"`** — best for reading final layout/sizes or
         * tweaking content that page scripts build during load. The slowest
         * choice: one hanging image or ad iframe delays it. Runs immediately
         * if `load` already fired. Unlike Chrome's content-script
         * `document_idle` (which can fire before `load`), this **always**
         * waits for `load`.
         *
         * **Applies to every value:**
         * - Runs **once** per document load, per matching frame. SPA route
         *   changes (`pushState`) and framework re-renders do *not* re-run it —
         *   start a `MutationObserver` inside the handler to keep re-applying.
         * - Saving the script while the page is open re-runs the handler
         *   **immediately**, regardless of `when` (live update) — make
         *   handlers idempotent.
         * - One `onDom` per script: a later `wt.onDom` call replaces the
         *   earlier one, including its `when`. Each script's `when` is
         *   independent; handlers with the same `when` run in script-list
         *   order.
         * - Async handlers are not awaited; `when` controls only when they
         *   *start*.
         * - The handler runs in the page's MAIN world (sees page globals). If
         *   the page's CSP forbids `eval`, it falls back to the extension's
         *   isolated world: same DOM and timing, but page-defined globals
         *   (e.g. `window.myApp`) are not visible.
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
 * **Stacking** — when several scripts match one request they run in list
 * order (top to bottom in the manager):
 * - `onRequest`: the first script returning a *terminal* result
 *   (`respond`/`redirect`/`cancel`) wins and stops the chain; headers-only
 *   or `void` results don't stop it.
 * - `onResponseHeaders`: **all** matching scripts run; `set` is applied in
 *   order (later overwrites), `remove` accumulates.
 * - `modifyResponse`: transforms **compose** — each script's output is the
 *   next script's input.
 * - `replaceResponse`: the first script returning a body wins; later ones
 *   are skipped.
 *
 * **Async** — every hook accepts a Promise-returning handler. Async
 * `replaceResponse`/`modifyResponse`/`onDom` work everywhere; async
 * `onRequest`/`onResponseHeaders` are honored natively on Firefox, and on
 * Chromium require `"cdp"` or `"process"` in the strategy list (otherwise a
 * warning is logged and the result is ignored). See the README's
 * "Async handlers" section.
 */
declare const wt: {
    /**
     * Intercept a request before it is sent. Return `{ respond }`,
     * `{ redirect }`, `{ cancel }`, `{ headers }` or a combination. May be
     * async (see the stacking/async notes on `wt`).
     *
     * **Terminal** results — the first one wins and stops the script chain:
     * - `respond` — synthesize the response; the network is never contacted.
     *   `body`/`status`/`mime`/`headers` are honored on the hook and cdp
     *   tiers; the webRequest tier serves it as a data-URL redirect (status
     *   becomes 200 there).
     * - `redirect` — continue at another URL.
     * - `cancel` — fail the request.
     *
     * **Non-terminal:** `{ headers }` — applied, and later scripts still run.
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
     * Inspect / modify response headers. All matching scripts run. May be
     * async (see the stacking/async notes on `wt`).
     */
    onResponseHeaders(
        handler: (ctx: Wiretrick.ResponseHeaderCtx) => Wiretrick.ResponseHeaderResult | void | Promise<Wiretrick.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, `Uint8Array`, or
     * `{ file: "<path or data url>" }`; return nothing to leave the body alone.
     *
     * May be async — the awaited result fulfills the response (the hook tier
     * short-circuits the page's fetch/XHR; the cdp tier fulfills the network
     * response).
     */
    replaceResponse(
        handler: (ctx: Wiretrick.ReplaceCtx) => string | Uint8Array | { file: string } | null | void | Promise<string | Uint8Array | { file: string } | null | void>
    ): void;

    /**
     * Transform the response body: receives the original body (string or
     * bytes) and returns the new one. Transforms from multiple scripts
     * compose in list order.
     *
     * Where it runs:
     * - **Firefox** — network level (`filterResponseData`).
     * - **Chromium** — the JS network hook (page-initiated fetch/XHR), CDP
     *   with `strategy: ["cdp"]`, or the local helper with
     *   `strategy: ["process"]`.
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
     * titles, text and DOM content. Works no matter how the response arrived
     * (service-worker-served HTML, cached pages, hydration).
     *
     * Runs once per document load in every frame whose URL matches the
     * script's `match` — by default at `DOMContentLoaded`.
     *
     * @param handler Receives the same `ctx` shape as `onRequest` (`url` is
     * the frame's URL). May be async (not awaited).
     * @param opts Set `when` to `"DOMContentLoaded"` (default), `"document_start"`,
     * `"document_end"` or `"document_idle"`. See {@link Wiretrick.DomOptions.when}
     * for exact timing, the MV3 `document_start` race, SPA/re-render behavior
     * and live-update re-runs.
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
     * Declarative script definition — the **only** way to activate a script:
     * sets the meta (`match`/`include`/`strategy`) and declares adjustable
     * parameters. Sources without it are importable library modules.
     *
     * Returns the resolved parameter values (stored UI values merged over
     * your defaults), typed from your `params` defs — so the script never
     * hard-codes toggles; users change them from the ⚙ dialog in the popup
     * or the manager.
     *
     * @example
     * const cfg = wt.declareScript({
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
