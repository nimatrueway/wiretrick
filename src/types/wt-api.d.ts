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
        /**
         * Named groups the handler's route captured from `url` (`:id`, and
         * `"0"`, `"1"`… for `*` wildcards). `{}` when nothing was captured.
         *
         * @example
         * wt.onRequest("https://api.example.com/users/:id", (ctx) => {
         *     if (ctx.groups.id === "42") return { replaceResponse: { body: { id: 42 } } };
         * });
         */
        groups: { [name: string]: string };
    }

    /**
     * Interception strategy that runs a handler. Every handler runs
     * on exactly **one** strategy: its route's `strategy`, else
     * `settings.defaultStrategy` (Settings → Strategy; default `"helper"` on
     * Chromium, `"extension"` on Firefox). There is no fallback: when the
     * strategy isn't available, the handler doesn't run and the Log view says why.
     *
     * - `"helper"` — the local wiretrick-helper (a proxy). Sees every
     *   request incl. documents, scripts and service workers; no banner.
     *   Needs the helper installed. Chromium only.
     * - `"page"` — patches the page's own `fetch`/XHR. Lightest (no banner,
     *   no helper) but sees **only** page fetch/XHR (`"xmlhttprequest"`) —
     *   no documents, `<script src>`, images or worker requests, and no
     *   `onResponseHeaders`.
     * - `"extension"` — the extension handles each request (blocking
     *   webRequest). Firefox (reads bodies) and MV2
     *   Chromium (no `onResponseBody`, sync handlers only). On Chromium the
     *   page itself (`main_frame`) can be redirected and its headers changed,
     *   but a replaced page is served from a `chrome-extension://` URL — use
     *   `"helper"` or `"debugger"` to rewrite or replace the page in place.
     * - `"debugger"` — the Chrome debugger. Sees everything; Chrome shows a
     *   "started debugging this browser" banner while attached. Chromium only.
     * - `"rules"` — browser-native rules (declarativeNetRequest): the browser
     *   itself blocks, redirects or sets/removes request and response
     *   headers, on every request; no banner, no helper. The handler runs
     *   **once** when scripts load and must return the same result for every
     *   request: it may use `ctx.groups.*` and `ctx.url` only as-is inside a
     *   redirect URL, and may not read anything else from `ctx`. No
     *   `replaceResponse` (handler or result), `onResponseBody` or `exclude`. A handler
     *   that can't become a rule doesn't run, and its script shows an error.
     *   Chrome (MV3 and MV2) and Firefox.
     *
     * @see https://github.com/nimatrueway/wiretrick/blob/main/docs/strategies.md#compatibility
     */
    type Strategy = "helper" | "page" | "extension" | "debugger" | "rules";

    /** webRequest resource type names (also `ctx.resourceType`). */
    type ResourceType =
        | "main_frame"
        | "sub_frame"
        | "stylesheet"
        | "script"
        | "image"
        | "font"
        | "object"
        | "xmlhttprequest"
        | "ping"
        | "csp_report"
        | "media"
        | "websocket"
        | "other";

    /**
     * One or more [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)
     * strings: `*` is a wildcard within a URL part, `:name` a named segment
     * (→ `ctx.groups.name`), and an omitted query or hash matches any. An
     * omitted port means the default port only (write `:*` for any).
     * `"<all_urls>"` matches every URL. An empty list matches **nothing**.
     * An invalid URL pattern makes the registration throw.
     *
     * @example "*://example.com/*"
     * @example ["https://*.example.com/api/v1/*", "https://cdn.example.com/static/*.js"]
     */
    type UrlPatterns = string | string[];

    /** Full route form for network handlers (`onRequest`, `onResponseHeaders`, `replaceResponse`, `onResponseBody`). */
    interface RouteOptions {
        /** URLs this handler applies to. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /**
         * URLs to skip even when `url` matches (same syntax).
         *
         * Cheap: one extra URL pattern test, only on URLs that already matched
         * `url`. It filters correctly on every strategy but can't narrow
         * what `debugger`/`helper` pause, so an excluded URL may still be paused
         * there and then continued unchanged.
         *
         * @example { url: "*://example.com/*", exclude: ["*://example.com/*.png", "*://example.com/health"] }
         */
        exclude?: UrlPatterns;
        /**
         * Only these HTTP methods (case-insensitive). Omit for any.
         *
         * @example { url: "*://api.example.com/*", methods: ["POST", "PUT"] }
         */
        methods?: string[];
        /**
         * Only handle these resource types (webRequest names, also seen as
         * `ctx.resourceType`). Omit to handle every type.
         *
         * How much this saves depends on the strategy:
         * - `debugger`: the debugger only pauses these types (`Fetch.enable`
         *   patterns), so other requests are never stopped — the cheapest
         *   way to keep a route off images, fonts and other assets.
         * - `extension`: checked in the listener before any script runs.
         * - `helper`: checked after the helper pauses the request, so it
         *   filters correctly but saves no work.
         * - `page`: only sees page fetch/XHR (`"xmlhttprequest"`); any list
         *   without it means the handler never runs (the Log view warns).
         *
         * @example { url: "https://app.example.com/*", resourceTypes: ["main_frame"] } // navigations only
         * @see https://github.com/nimatrueway/wiretrick/blob/main/docs/strategies.md#compatibility
         */
        resourceTypes?: ResourceType[];
        /**
         * Run this handler on this strategy instead of `settings.defaultStrategy`.
         * A single value — there is no fallback. See {@link Strategy}.
         *
         * @example { url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "debugger" }
         * @example { url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }
         */
        strategy?: Strategy;
    }

    /** Where a network handler applies: URL pattern(s) or the full {@link RouteOptions} form. */
    type Route = UrlPatterns | RouteOptions;

    /** Full route form for `wt.onResponseBody`. */
    interface BodyRouteOptions extends RouteOptions {
        /**
         * Which bodies the handler gets. Which Content-Types are text is set
         * by `settings.textTypes`.
         * - unset: text only (a string); a binary body it misses is warned
         *   about in the Log view
         * - `false`: text only, without that warning
         * - `true`: binary only (images, video, …), as a `Uint8Array`
         * - `"both"`: text as a string and binary as a `Uint8Array`
         *
         * Binary bodies are buffered whole and the response waits for the
         * handler — keep these routes narrow.
         *
         * @example { url: "*://cdn.example.com/*.png", binary: true }
         * @see https://github.com/nimatrueway/wiretrick/blob/main/docs/scripting.md#binary-bodies
         */
        binary?: boolean | "both";
    }

    /** Full route form for `wt.onDocument`. */
    interface DocumentRouteOptions extends DocumentOptions {
        /** Frame URLs (top page and iframes) to run in. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /** Frame URLs to skip even when `url` matches. */
        exclude?: UrlPatterns;
    }

    /** Where an `onDocument` handler runs: URL pattern(s) or the full {@link DocumentRouteOptions} form. */
    type DocumentRoute = UrlPatterns | DocumentRouteOptions;

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

    /** A synthesized response: the `onRequest` → `{ replaceResponse }` result (a replacement). */
    interface ReplacementOptions {
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
     * What `onRequest` may return: **exactly one** of `replaceResponse`,
     * `redirect`, `block` or `headers` (or nothing, to leave the request alone).
     * The first three are **final** (the first handler to return one wins);
     * `headers` is not. To change a redirected request's headers, add an
     * `onRequest` handler for the redirect target — on most strategies the
     * redirected request runs through `onRequest` again.
     */
    type RequestResult =
        | OnlyOne<"replaceResponse", {
              /** Serve this replacement without contacting the network (final). */
              replaceResponse: ReplacementOptions;
          }>
        | OnlyOne<"redirect", {
              /** Redirect the request to this URL (final). */
              redirect: string;
          }>
        | OnlyOne<"block", {
              /** Block the request entirely (final). `false` leaves it alone. */
              block: boolean;
          }>
        | OnlyOne<"headers", {
              /** Modify request headers on the way out (not final). */
              headers: HeaderMod;
          }>;

    /** `T`, with every other `onRequest` result key forbidden */
    type OnlyOne<K extends RequestResultKey, T> = T & { [O in Exclude<RequestResultKey, K>]?: never };
    type RequestResultKey = "replaceResponse" | "redirect" | "block" | "headers";

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

    /** `onResponseBody` context. */
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

    /** Timing for `wt.onDocument` (part of its route object). */
    interface DocumentOptions {
        /**
         * **When** the `onDocument` handler runs, relative to the page's own loading.
         * Default: `"document_end"`.
         *
         * **How it gets there:** in every frame (top page *and* iframes) the
         * extension injects a small hook at `document_start`. The hook asks
         * the background for the scripts with an `onDocument` route covering *that
         * frame's* URL, compiles them, and schedules each matching handler
         * according to its own `when`.
         *
         * | `when` | Fires | DOM state |
         * |---|---|---|
         * | `"document_start"` | as soon as the script is compiled | only `<html>`; `head`/`body` usually `null` |
         * | `"document_end"` *(default)* | at `DOMContentLoaded` (DOM parsed) | whole DOM queryable; images/iframes may still load |
         * | `"document_idle"` | after the page's `load` event | every subresource finished |
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
         *   correctness — use `onResponseBody` when you must change what page
         *   code sees.
         *
         * **`"document_end"`** — at `DOMContentLoaded` (DOM parsed):
         * `defer`/module scripts have run; images,
         * stylesheets and iframes may still be loading, and frameworks (React,
         * Vue, …) may not have hydrated yet, so a re-render can overwrite your
         * change. The right choice for most title/text/attribute tweaks. If
         * the page is already past this point when the script arrives (slow
         * bundle, bfcache restore), the handler runs immediately.
         *
         * **`"document_idle"`** — after the page's `load` event. Best for
         * reading final layout/sizes or tweaking content that page scripts
         * build during load. The slowest choice: one hanging image or ad
         * iframe delays it. Runs immediately if `load` already fired. Unlike
         * Chrome's content-script `run_at: "document_idle"` (which can fire
         * before `load`), this **always** waits for `load`.
         *
         * **Applies to every value:**
         * - Runs **once** per document load, per matching frame. SPA route
         *   changes (`pushState`) and framework re-renders do *not* re-run it —
         *   start a `MutationObserver` inside the handler to keep re-applying.
         * - Saving the script while the page is open re-runs the handler
         *   **immediately**, regardless of `when` (live update) — make
         *   handlers idempotent.
         * - A script may register several `onDocument` handlers, each with its
         *   own route and `when`. Handlers with the same `when` run in
         *   script-list order, then registration order.
         * - Async handlers are not awaited; `when` controls only when they
         *   *start*.
         * - The handler runs in the page's MAIN world (sees page globals). If
         *   the page's CSP forbids `eval`, it falls back to the extension's
         *   isolated world: same DOM and timing, but page-defined globals
         *   (e.g. `window.myApp`) are not visible.
         *
         * @example
         * // default: document_end (DOMContentLoaded)
         * wt.onDocument("*://example.com/*", () => {
         *     document.title = "🎯 " + document.title;
         * });
         *
         * @example
         * // before page scripts (best effort, see race caveat)
         * wt.onDocument({ url: "*://example.com/*", when: "document_start" }, () => {
         *     Object.defineProperty(navigator, "webdriver", {
         *         get: () => false,
         *     });
         * });
         *
         * @example
         * // after everything loaded, then keep it applied across re-renders
         * wt.onDocument({ url: "*://example.com/*", when: "document_idle" }, () => {
         *     const apply = () => {
         *         for (const ad of document.querySelectorAll(".ad")) ad.remove();
         *     };
         *     apply();
         *     new MutationObserver(apply).observe(document.body, {
         *         childList: true,
         *         subtree: true,
         *     });
         * });
         */
        when?: "document_start" | "document_end" | "document_idle";
    }

    // ---- wt.params / wt.defineParam: typed, user-adjustable parameters ----

    /** An on/off switch — a checkbox in the ⚙ dialog. */
    interface ParamDefBoolean {
        type: "boolean";
        /** Default `false`. */
        default?: boolean;
        /** Shown next to the control and in settings.yaml. */
        description?: string;
        /**
         * Turn the raw value into what the script receives — the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.yaml keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "boolean", default: true, parse: (on) => (on ? "verbose" : "quiet") }
         */
        parse?: (raw: boolean) => unknown;
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
        /**
         * Turn the raw value into what the script receives — the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.yaml keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "number", default: 2, parse: (sec) => sec * 1000 } // seconds → ms
         */
        parse?: (raw: number) => unknown;
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
        /**
         * Turn the raw value into what the script receives — the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.yaml keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "string", default: "https://api.example.com", parse: (s) => new URL(s) }
         */
        parse?: (raw: string) => unknown;
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
        /**
         * Turn the raw value into what the script receives — the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.yaml keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "enum", choices: ["500", "503"], parse: (c) => Number(c) }
         *
         * `raw` is typed `string` here (always one of `choices` at run time).
         */
        parse?: (raw: string) => unknown;
    }
    /** A list of strings — one entry per line in the ⚙ dialog. */
    interface ParamDefStringList {
        type: "stringList";
        /** Default `[]`. */
        default?: string[];
        /** Shown next to the control and in settings.yaml. */
        description?: string;
        /**
         * Turn the raw value into what the script receives — the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.yaml keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         *
         * @example
         * { type: "stringList", default: ["a.com"], parse: (l) => new Set(l) }
         */
        parse?: (raw: string[]) => unknown;
    }
    /** One adjustable parameter, discriminated by `type`. */
    type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList;

    /** The raw (stored, edited) value type of a param def — what `parse` receives. */
    type ParamRawValue<D extends ParamDef> = D extends ParamDefBoolean
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

    /**
     * The value type a param def resolves to: `parse`'s return type when
     * the def has one, else {@link Wiretrick.ParamRawValue}.
     */
    type ParamValue<D extends ParamDef> = D extends { parse: (raw: never) => infer R } ? R : ParamRawValue<D>;

    /** Resolved parameter values, typed from the defs you passed. */
    type ParamsOf<T extends Record<string, ParamDef>> = {
        readonly [K in keyof T]: ParamValue<T[K]>;
    };

}

/**
 * The global script API.
 *
 * A script is a file that registers handlers at top level. Each handler
 * takes its own **route** first — a URL pattern, a list, or a route object
 * (`url`, `exclude`, `methods`, `resourceTypes`, `strategy`) — then the handler:
 *
 * ```ts
 * wt.onRequest("*://api.example.com/*", (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
 * ```
 *
 * A file that registers **no** handlers is a *library*: other scripts
 * import it, and it never runs on its own.
 *
 * **Stacking** — when several handlers match one request they run in list
 * order (scripts top to bottom in the Editor, then registration order):
 * - `onRequest`: the first *final* result (`replaceResponse`/`redirect`/
 *   `block`) wins and stops the chain; headers-only or `void` results
 *   don't stop it.
 * - `onResponseHeaders`: **all** matching handlers run; `set` is applied in
 *   order (later overwrites), `remove` accumulates.
 * - `onResponseBody`: transforms **compose** — each output is the next input.
 * - `replaceResponse`: the first handler returning a body wins.
 *
 * Handlers on different strategies run independently, each on its own
 * strategy (see {@link Wiretrick.Strategy}).
 *
 * **Async** — every handler may return a Promise. On Chromium's
 * `"extension"` strategy `onRequest`/`onResponseHeaders` must be
 * synchronous (an async result is ignored with a warning); every other
 * strategy awaits it.
 */
declare const wt: {
    /**
     * Intercept a request before it is sent. Return **one** of
     * `{ replaceResponse }`, `{ redirect }`, `{ block }` or `{ headers }`
     * (a combination is a type error; at runtime only the first, in that
     * order, applies and a warning is logged).
     *
     * **Final** results — the first one wins and stops the chain:
     * - `replaceResponse` — synthesize the response; the network is never contacted.
     *   On Chromium's `"extension"` strategy it is served as a data-URL
     *   redirect, so only status 200 is possible there.
     * - `redirect` — continue at another URL.
     * - `block` — fail the request.
     *
     * **Not final:** `{ headers }` — applied, and later handlers still run.
     *
     * @param route Where it applies — see {@link Wiretrick.Route}.
     * @param handler Called once per matching request with its context.
     *
     * @example
     * // answer an endpoint without the network
     * wt.onRequest("https://api.example.com/users/:id", (ctx) => ({
     *     replaceResponse: { body: { id: Number(ctx.groups.id), name: "Mock" } },
     * }));
     *
     * @example
     * // add a header to every POST, on the debugger
     * wt.onRequest({ url: "*://example.com/*", methods: ["POST"], strategy: "debugger" }, () => ({
     *     headers: { set: { "x-debug": "1" } },
     * }));
     */
    onRequest(route: Wiretrick.Route, handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.Awaitable<Wiretrick.RequestResult | void>): void;

    /**
     * Inspect / modify response headers. **All** matching handlers run.
     * Not available on the `"page"` strategy (the page can't change headers
     * before the browser enforces them).
     *
     * @param route Where it applies — see {@link Wiretrick.Route}.
     * @param handler Called when the response headers arrive.
     *
     * @example
     * wt.onResponseHeaders("*://api.example.com/*", () => ({
     *     headers: {
     *         set: { "access-control-allow-origin": "*" },
     *         remove: ["content-security-policy"],
     *     },
     * }));
     */
    onResponseHeaders(
        route: Wiretrick.Route,
        handler: (ctx: Wiretrick.ResponseHeaderCtx) => Wiretrick.Awaitable<Wiretrick.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, `Uint8Array`,
     * an object (sent as JSON), or `{ file: "<path or data url>" }`; return
     * nothing to leave the response alone.
     *
     * @param route Where it applies — see {@link Wiretrick.Route}.
     * @param handler Called per matching response; its result becomes the body.
     *
     * @example
     * wt.replaceResponse("*://api.example.com/flags", () => ({ beta: true }));
     *
     * @example
     * // serve a fixture fetched elsewhere
     * wt.replaceResponse("*://api.example.com/user", async () => {
     *     const res = await fetch("https://fixtures.local/user.json");
     *     return await res.text();
     * });
     */
    replaceResponse(
        route: Wiretrick.Route,
        handler: (ctx: Wiretrick.ReplaceCtx) => Wiretrick.Awaitable<string | Uint8Array | object | { file: string } | null | void>
    ): void;

    /**
     * Transform the response body: receives the original body and returns
     * the new one. Matching transforms compose in order.
     *
     * The handler gets text bodies (a string) only, unless its route sets
     * `binary: true` — binary bodies (images, video, …) only, as a
     * `Uint8Array` — or `binary: "both"`. `binary: false` keeps text only
     * and silences the "body is binary" warning. Which Content-Types are
     * text: `settings.textTypes`.
     *
     * Needs a strategy that reads bodies: `"helper"`, `"debugger"`, `"page"`
     * (page fetch/XHR only) or `"extension"` on Firefox. Chromium's
     * `"extension"` strategy can't read bodies — the handler doesn't run there and
     * the Log view says so.
     *
     * @param route Where it applies — see {@link Wiretrick.Route}.
     * @param transform Receives the context and the original body; returns
     * the new body.
     *
     * @example
     * wt.onResponseBody({ url: "*://example.com/app/*.js", resourceTypes: ["script"] }, (ctx, body) => {
     *     return body.replace("DEBUG=false", "DEBUG=true");
     * });
     * @example
     * // binary: true — swap an image
     * wt.onResponseBody({ url: "*://example.com/logo.png", binary: true }, async (ctx, body) => {
     *     const res = await fetch("https://example.org/other.png");
     *     return new Uint8Array(await res.arrayBuffer());
     * });
     */
    onResponseBody(
        route: Wiretrick.UrlPatterns | (Wiretrick.BodyRouteOptions & { binary?: false }),
        transform: (ctx: Wiretrick.BodyCtx, body: string) => Wiretrick.Awaitable<string | Uint8Array>
    ): void;
    onResponseBody(
        route: Wiretrick.BodyRouteOptions & { binary: true },
        transform: (ctx: Wiretrick.BodyCtx, body: Uint8Array) => Wiretrick.Awaitable<string | Uint8Array>
    ): void;
    onResponseBody(
        route: Wiretrick.BodyRouteOptions,
        transform: (ctx: Wiretrick.BodyCtx, body: string | Uint8Array) => Wiretrick.Awaitable<string | Uint8Array>
    ): void;

    /**
     * Run a handler in the page (MAIN world) — the resilient way to change
     * titles, text and DOM content. Works no matter how the response arrived
     * (service-worker-served HTML, cached pages, hydration). Strategies
     * don't apply.
     *
     * Runs once per document load in every frame whose URL matches the
     * route — by default at `DOMContentLoaded` (`when: "document_end"`). A script may register
     * several, each with its own route and `when`.
     *
     * @param route Frame URL pattern(s), or `{ url, exclude, when }`. See
     * {@link Wiretrick.DocumentOptions.when} for exact timing, the MV3
     * `document_start` race, SPA/re-render behavior and live-update re-runs.
     * @param handler Receives the same `ctx` shape as `onRequest` (`url` is
     * the frame's URL). May be async (not awaited).
     *
     * @example
     * wt.onDocument("*://example.com/*", () => {
     *     document.title = "🎯 " + document.title;
     * });
     *
     * @example
     * // after the page's load event
     * wt.onDocument({ url: "*://example.com/*", when: "document_idle" }, () => {
     *     const el = document.querySelector("h1");
     *     if (el) el.textContent = "Intercepted";
     * });
     */
    onDocument(route: Wiretrick.DocumentRoute, handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.Awaitable<void>): void;

    /**
     * One-line description: shown as a tooltip in the Editor and the
     * popup, and in diagnostics.
     *
     * @example
     * wt.about("Force failures on the posts API");
     */
    about(text: string): void;

    /**
     * Declare adjustable parameters, editable from the popup's ⚙ dialog,
     * the Editor and settings.yaml without touching the script. Returns
     * the current values (stored values over your defaults), typed from
     * your defs. Routes may be built from them — a change re-runs the
     * script. Libraries may declare params too (listed in the popup; one
     * that registers handlers only for some value becomes a script then).
     * Definitions may come from an import (`{ env: envParam }`, `{ ...defs }`).
     *
     * @param defs Parameter name → definition (`type`, `default`, optional
     *   `description` and `parse`); see {@link Wiretrick.ParamDef}. With
     *   `parse`, the param's value is the parser's result (raw value in,
     *   e.g. a `URL` out) while the stored/edited value stays raw.
     * @returns The current values, typed from `defs`.
     *
     * @example
     * const cfg = wt.params({
     *     enabled: { type: "boolean", default: true, description: "Return errors" },
     *     status: { type: "enum", choices: ["500", "503"], default: "500" },
     *     hosts: { type: "stringList", default: ["staging.example.com"] },
     * });
     *
     * wt.onRequest(cfg.hosts.map((h) => `*://${h}/api/*`), () => {
     *     if (cfg.enabled) return { replaceResponse: { status: Number(cfg.status), body: { error: "forced" } } };
     * });
     *
     * @example
     * // parse: the script gets a URL (cfg.origin: URL), the ⚙ dialog edits the string
     * const cfg = wt.params({
     *     origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) },
     * });
     * wt.onResponseHeaders("*://api.example.com/*", () => ({
     *     headers: { set: { "access-control-allow-origin": cfg.origin.origin } },
     * }));
     */
    params<const T extends Record<string, Wiretrick.ParamDef>>(defs: T): Wiretrick.ParamsOf<T>;

    /**
     * Declare a single parameter and get its current value (same store as
     * {@link wt.params}).
     *
     * @example
     * const host = wt.defineParam("host", { type: "string", default: "api.example.com" });
     * wt.onRequest(`*://${host}/*`, () => ({ headers: { set: { "x-debug": "1" } } }));
     *
     * @example
     * // parse: hosts is a Set<string>; the stored value stays a list
     * const hosts = wt.defineParam("hosts", { type: "stringList", parse: (l) => new Set(l) });
     */
    defineParam<const D extends Wiretrick.ParamDef>(name: string, def: D): Wiretrick.ParamValue<D>;

    /**
     * Per-script key/value storage (async, persistent).
     *
     * @example
     * wt.onRequest("*://example.com/*", async () => {
     *     const hits = ((await wt.storage.get("hits")) ?? 0) + 1;
     *     await wt.storage.set("hits", hits);
     * });
     */
    storage: Wiretrick.Storage;

    /**
     * Log to the Editor's Log view for the current tab.
     *
     * @example
     * wt.log("request to", ctx.url, { method: ctx.method });
     */
    log(...args: unknown[]): void;

    /**
     * `true` in Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, Opera…).
     * Always the opposite of {@link isFirefox}.
     *
     * @example
     * wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "extension" : "helper" }, (ctx, body) => body);
     */
    readonly isChrome: boolean;

    /** `true` in Firefox. Always the opposite of {@link isChrome}. */
    readonly isFirefox: boolean;

    /**
     * `true` in the Manifest V2 build (`dist/`: Firefox, and Chromium browsers
     * that still load MV2 extensions). Always the opposite of {@link isMV3}.
     */
    readonly isMV2: boolean;

    /**
     * `true` in the Manifest V3 build (`dist-mv3/`: current Chrome / Edge),
     * where the `extension` strategy isn't available.
     *
     * @example
     * wt.onRequest({ url: "*://api.example.com/*", strategy: wt.isMV3 ? "debugger" : "extension" }, fn);
     */
    readonly isMV3: boolean;
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
 * The same syntax as handler routes (`wt.onRequest(pattern, fn)`).
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
