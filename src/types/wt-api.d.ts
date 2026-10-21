/**
 * Public `wt` API typings — shipped into the editor as an extra lib and
 * written into the VS Code folder so scripts get full IntelliSense.
 */

declare namespace Wiretrick {
    /** A value, or a Promise of it — every handler may be async. */
    type Awaitable<T> = T | Promise<T>;

    /** One response header as received from the network. */
    interface HeaderPair {
        /** Header name, in the server's casing. */
        name: string;
        /** Header value (absent for valueless headers). */
        value?: string;
    }

    /** What every handler learns about the request. */
    interface RequestCtx {
        /** Full request URL, e.g. `"https://api.example.com/v1/user?id=1"`. */
        url: string;
        /** HTTP method in upper case: `"GET"`, `"POST"`, … */
        method: string;
        /** URL of the top-level document that initiated the request. */
        tabUrl: string;
        /**
         * webRequest resource type: `"main_frame"`, `"sub_frame"`,
         * `"script"`, `"stylesheet"`, `"image"`, `"xmlhttprequest"`, …
         */
        resourceType: string;
        /** Request headers as a plain object (`name → value`). */
        requestHeaders: { [name: string]: string };
    }

    /** Header edits. */
    interface HeaderMod {
        /**
         * Set (or overwrite) these headers.
         *
         * @example
         * { set: { "x-debug": "1", "cache-control": "no-store" } }
         */
        set?: { [name: string]: string };
        /**
         * Remove these headers (case-insensitive names).
         *
         * @example
         * { remove: ["cookie", "x-tracking-id"] }
         */
        remove?: string[];
    }

    /** A synthesized response (`onRequest` → `{ respond }`). */
    interface RespondOptions {
        /**
         * Response body. Strings and bytes are sent as-is; any other object
         * is JSON-serialized.
         */
        body: string | Uint8Array | object;
        /** HTTP status. Default `200`. */
        status?: number;
        /**
         * Content-Type. Default: guessed from the request URL's extension
         * (`application/json` for objects).
         */
        mime?: string;
        /** Extra response headers. */
        headers?: { set?: { [name: string]: string } };
    }

    /**
     * What `onRequest` may return. `respond`, `redirect` and `cancel` are
     * **terminal** (first script wins); `headers` is not.
     */
    interface RequestResult {
        /** Respond immediately without contacting the network (terminal). */
        respond?: RespondOptions;
        /** Redirect the request to this URL (terminal). */
        redirect?: string;
        /** Block the request entirely (terminal). */
        cancel?: boolean;
        /** Modify request headers on the way out (non-terminal). */
        headers?: HeaderMod;
    }

    /** `onResponseHeaders` context: the request plus the response head. */
    interface ResponseHeaderCtx extends RequestCtx {
        /** HTTP status line, e.g. `"HTTP/1.1 200 OK"`. */
        statusLine: string;
        /** Response headers as they came from the network. */
        responseHeaders: HeaderPair[];
    }

    /** What `onResponseHeaders` may return. */
    interface ResponseHeaderResult {
        /** Response header edits; applied in script order. */
        headers?: HeaderMod;
    }

    /** `replaceResponse` context. */
    interface ReplaceCtx extends RequestCtx {
        /** Content-Type reported by the server, if known. */
        mime?: string;
    }

    /** `modifyResponse` context. */
    interface BodyCtx extends ReplaceCtx {
        /** Response status code, when available. */
        status?: number;
    }

    /** Per-script persistent key/value storage (JSON-serializable values). */
    interface Storage {
        /**
         * Read a value; resolves to `undefined` when the key was never set.
         *
         * @example
         * const hits = (await wt.storage.get("hits")) ?? 0;
         */
        get(key: string): Promise<any>;
        /**
         * Store a value (persists across reloads and browser restarts).
         *
         * @example
         * await wt.storage.set("hits", hits + 1);
         */
        set(key: string, value: any): Promise<void>;
    }

    /** Options for `wt.onDom` (its 2nd argument). */
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
         * // default: DOMContentLoaded
         * wt.onDom(() => {
         *     document.title = "🎯 " + document.title;
         * });
         *
         * @example
         * // before page scripts (best effort, see race caveat)
         * wt.onDom(() => {
         *     Object.defineProperty(navigator, "webdriver", {
         *         get: () => false,
         *     });
         * }, { when: "document_start" });
         *
         * @example
         * // after everything loaded, then keep it applied across re-renders
         * wt.onDom(() => {
         *     const apply = () => {
         *         for (const ad of document.querySelectorAll(".ad")) ad.remove();
         *     };
         *     apply();
         *     new MutationObserver(apply).observe(document.body, {
         *         childList: true,
         *         subtree: true,
         *     });
         * }, { when: "document_idle" });
         */
        when?: "DOMContentLoaded" | "document_start" | "document_end" | "document_idle";
    }

    // ---- declareScript: declarative meta + typed parameters ----

    /** An on/off switch — a checkbox in the ⚙ dialog. */
    interface ParamDefBoolean {
        type: "boolean";
        /** Default `false`. */
        default?: boolean;
        /** Shown next to the control and in settings.yaml. */
        description?: string;
    }
    /** A number — a number input in the ⚙ dialog. */
    interface ParamDefNumber {
        type: "number";
        /** Default `0`. */
        default?: number;
        /** Shown next to the control and in settings.yaml. */
        description?: string;
        /** Lower bound; the UI clamps typed values. */
        min?: number;
        /** Upper bound; the UI clamps typed values. */
        max?: number;
        /** Step for the number input. Default `1`; use e.g. `0.1` for decimals. */
        step?: number;
    }
    /** Free text — a text input (or textarea) in the ⚙ dialog. */
    interface ParamDefString {
        type: "string";
        /**
         * Edit in a textarea. Values with newlines are written as YAML block
         * scalars in settings.yaml.
         */
        multiline?: boolean;
        /** Default `""`. */
        default?: string;
        /** Shown next to the control and in settings.yaml. */
        description?: string;
    }
    /** One of fixed choices — a dropdown in the ⚙ dialog. */
    interface ParamDefEnum {
        type: "enum";
        /** The allowed values; the param is typed as their union. */
        choices: string[];
        /** Default: the first choice. */
        default?: string;
        /** Shown next to the control and in settings.yaml. */
        description?: string;
    }
    /** A list of strings — one entry per line in the ⚙ dialog. */
    interface ParamDefStringList {
        type: "stringList";
        /** Default `[]`. */
        default?: string[];
        /** Shown next to the control and in settings.yaml. */
        description?: string;
    }
    /** One adjustable parameter, discriminated by `type`. */
    type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList;

    /** The value type a param def resolves to. */
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

    /** The `wt.declareScript` argument. */
    interface ScriptDef<T extends Record<string, ParamDef> = Record<string, ParamDef>> {
        /**
         * URLs the script activates on, as
         * [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)
         * strings: `*` is a wildcard within a URL part, `:name` a named
         * segment, and an omitted query or hash matches any. An omitted port
         * means the default port only (write `:*` for any). `"<all_urls>"`
         * matches every URL. An invalid pattern makes `declareScript` throw.
         *
         * @see https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API
         *
         * @example
         * match: ["*://example.com/*", "https://*.example.com/api/v1/*", "https://cdn.example.com/static/*.js"]
         */
        match?: string[];
        /**
         * Interception tiers in priority order; the first viable one per
         * request wins. Default `["auto"]`.
         *
         * - `"hook"` — page fetch/XHR override; the most lightweight (no
         *   banner, no helper), but it only sees the page's own fetch/XHR
         *   (REST/API) calls — documents, `<script src>`, images and workers
         *   pass through. For robust interception prefer `"process"`,
         *   `"webrequest"` or `"cdp"`.
         * - `"cdp"` — Chrome debugger; sees everything, shows a banner while
         *   attached.
         * - `"webrequest"` — blocking webRequest (Firefox, MV2 Chromium).
         * - `"process"` — the local wiretrick-helper; sees everything, no
         *   banner.
         *
         * @example
         * strategy: ["hook", "cdp"]
         */
        strategy?: ("auto" | "hook" | "cdp" | "webrequest" | "process")[];
        /**
         * Adjustable parameters, editable from the popup's ⚙ dialog, the
         * manager and settings.yaml without touching the script. Returned
         * typed from `wt.declareScript`.
         *
         * @example
         * params: {
         *     enabled: { type: "boolean", default: true },
         *     status: { type: "enum", choices: ["500", "503"] },
         * }
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
     * @param handler Called once per matching request with its context.
     *
     * @example
     * // mock an endpoint
     * wt.onRequest((ctx) => {
     *     if (!ctx.url.includes("/user")) return;
     *     return {
     *         respond: {
     *             body: { id: 1, name: "Mock" },
     *             mime: "application/json",
     *         },
     *     };
     * });
     *
     * @example
     * // add a header to every request
     * wt.onRequest(() => ({
     *     headers: { set: { "x-debug": "1" } },
     * }));
     */
    onRequest(handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.Awaitable<Wiretrick.RequestResult | void>): void;

    /**
     * Inspect / modify response headers. **All** matching scripts run. May
     * be async (see the stacking/async notes on `wt`).
     *
     * @param handler Called when the response headers arrive.
     *
     * @example
     * wt.onResponseHeaders(() => ({
     *     headers: {
     *         set: { "access-control-allow-origin": "*" },
     *         remove: ["content-security-policy"],
     *     },
     * }));
     */
    onResponseHeaders(
        handler: (ctx: Wiretrick.ResponseHeaderCtx) => Wiretrick.Awaitable<Wiretrick.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, `Uint8Array`, or
     * `{ file: "<path or data url>" }`; return nothing to leave the body alone.
     *
     * May be async — the awaited result fulfills the response (the hook tier
     * short-circuits the page's fetch/XHR; the cdp tier fulfills the network
     * response).
     *
     * @param handler Called per matching response; its result becomes the body.
     *
     * @example
     * wt.replaceResponse(() => JSON.stringify({ mocked: true }));
     *
     * @example
     * // serve a fixture fetched elsewhere
     * wt.replaceResponse(async () => {
     *     const res = await fetch("https://fixtures.local/user.json");
     *     return await res.text();
     * });
     */
    replaceResponse(
        handler: (ctx: Wiretrick.ReplaceCtx) => Wiretrick.Awaitable<string | Uint8Array | { file: string } | null | void>
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
     *
     * @param transform Receives the context and the original body; returns
     * the new body.
     *
     * @example
     * wt.modifyResponse((ctx, body) => {
     *     const text = typeof body === "string"
     *         ? body
     *         : new TextDecoder().decode(body);
     *     return text.replace("old", "new");
     * });
     */
    modifyResponse(
        transform: (ctx: Wiretrick.BodyCtx, body: string | Uint8Array) => Wiretrick.Awaitable<string | Uint8Array>
    ): void;

    /**
     * Per-script key/value storage (async, persistent).
     *
     * @example
     * wt.onRequest(async () => {
     *     const hits = ((await wt.storage.get("hits")) ?? 0) + 1;
     *     await wt.storage.set("hits", hits);
     * });
     */
    storage: Wiretrick.Storage;

    /**
     * Log to the manager's LOG panel for the current tab.
     *
     * @example
     * wt.log("request to", ctx.url, { method: ctx.method });
     */
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
     * wt.onDom(() => {
     *     document.title = "🎯 " + document.title;
     * });
     *
     * @example
     * // after everything settled
     * wt.onDom(() => {
     *     const el = document.querySelector("h1");
     *     if (el) el.textContent = "Intercepted";
     * }, { when: "document_idle" });
     */
    onDom(handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.Awaitable<void>, opts?: Wiretrick.DomOptions): void;

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
     * @param def URL patterns, tier priority and adjustable parameters.
     * @returns The current parameter values, typed from `def.params`.
     *
     * @example
     * const cfg = wt.declareScript({
     *     match: ["*://cloud*.mongodb.com/*"],
     *     strategy: ["hook", "cdp"],
     *     params: {
     *         enabled: { type: "boolean", default: true, description: "Return 500s" },
     *         status: { type: "enum", choices: ["500", "503"], default: "500" },
     *         note: { type: "string", default: "API force failed" },
     *         extra: { type: "stringList", default: [] },
     *     },
     * });
     *
     * wt.onRequest(() => {
     *     if (!cfg.enabled) return;
     *     return {
     *         respond: {
     *             status: Number(cfg.status),
     *             body: { error: cfg.note },
     *         },
     *     };
     * });
     */
    declareScript<T extends Record<string, Wiretrick.ParamDef>>(def: Wiretrick.ScriptDef<T>): Wiretrick.ParamsOf<T>;
};

/*
 * Newer web platform APIs that the editor's bundled TypeScript doesn't know
 * yet. Wiretrick targets current browsers, so scripts may use them freely.
 */

/** Input accepted by `URLPattern` (each URL component as a pattern string). */
interface URLPatternInit {
    protocol?: string;
    username?: string;
    password?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
    search?: string;
    hash?: string;
    baseURL?: string;
}

interface URLPatternOptions {
    /** Match case-insensitively. */
    ignoreCase?: boolean;
}

type URLPatternInput = string | URLPatternInit;

interface URLPatternComponentResult {
    input: string;
    groups: Record<string, string | undefined>;
}

interface URLPatternResult {
    inputs: [URLPatternInput] | [URLPatternInput, string];
    protocol: URLPatternComponentResult;
    username: URLPatternComponentResult;
    password: URLPatternComponentResult;
    hostname: URLPatternComponentResult;
    port: URLPatternComponentResult;
    pathname: URLPatternComponentResult;
    search: URLPatternComponentResult;
    hash: URLPatternComponentResult;
}

/**
 * Matches URLs against a pattern, e.g. `new URLPattern("https://*.example.com/users/:id")`.
 * The same syntax as `wt.declareScript({ match })`.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API
 */
interface URLPattern {
    /** Whether `input` matches the pattern. */
    test(input?: URLPatternInput, baseURL?: string): boolean;
    /** The matched components and their named groups (`:id`, `*` → `"0"`), or null. */
    exec(input?: URLPatternInput, baseURL?: string): URLPatternResult | null;
    readonly protocol: string;
    readonly username: string;
    readonly password: string;
    readonly hostname: string;
    readonly port: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
    /** Whether any component uses a custom regular expression group. */
    readonly hasRegExpGroups: boolean;
}

declare var URLPattern: {
    prototype: URLPattern;
    new (input: URLPatternInput, baseURL: string, options?: URLPatternOptions): URLPattern;
    new (input?: URLPatternInput, options?: URLPatternOptions): URLPattern;
};
