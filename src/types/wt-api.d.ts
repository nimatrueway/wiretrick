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
         * wt.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => {
         *     if (ctx.groups.id === "42") return { replaceResponse: { body: { id: 42 } } };
         * });
         */
        groups: { [name: string]: string };
        /**
         * The request payload, read-only (changing it has no effect).
         * Text or binary is decided like response bodies: by the request's
         * `Content-Type` against `settings.textTypes` — text arrives as a
         * UTF-8 string, binary (incl. multipart `FormData`) as a `Uint8Array`.
         * `undefined` when there is no body (GET…), it is over 8 MB, or the
         * strategy can't get it:
         *
         * - `page`: fetch/XHR bodies; a `ReadableStream` body → `undefined`.
         * - `debugger`: the paused request's post data; uploads with a file
         *   part → `undefined`.
         * - `helper`: needs helper 0.4.1+; a streaming upload that stalls
         *   for 2 s → `undefined` (it is passed on untouched).
         * - `extension`: from webRequest; the kind is sniffed (no
         *   `Content-Type` that early), a form post arrives URL-encoded, and
         *   Chromium omits file and very large uploads → `undefined`.
         * - `rules`: no request — reading it is an error.
         *
         * @example
         * wt.onRequest({ url: "https://api.example.com/*", methods: ["POST"], strategy: "helper" }, (ctx) => {
         *     if (typeof ctx.requestBody === "string" && ctx.requestBody.includes("debug=1")) return { block: true };
         * });
         */
        requestBody?: string | Uint8Array;
        /**
         * Parses the **request** body (`ctx.requestBody`, bytes decoded as
         * UTF-8) as JSON. `undefined` when there is no body; throws when it
         * isn't valid JSON. Not the response — `onResponseBody` gets that as
         * its second argument.
         *
         * @example
         * wt.replaceResponse({ url: "https://api.example.com/graphql", strategy: "helper" }, (ctx) => {
         *     const q = ctx.json<{ operationName?: string }>();
         *     if (q?.operationName === "GetFlags") return { flags: { beta: true } };
         * });
         */
        json<T = any>(): T | undefined;
    }

    /**
     * Interception strategy that runs a handler. Every network handler
     * names exactly **one** in its route's required `strategy` — there is no
     * default and no fallback: when the strategy isn't available, the
     * handler doesn't run and the Log view says why.
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

    /**
     * Where a network handler (`onRequest`, `onResponseHeaders`, `replaceResponse`, `onResponseBody`)
     * applies and which {@link Strategy} runs it. A bare URL pattern isn't accepted — it names no strategy.
     */
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
         * The strategy that runs this handler — required, there is no
         * default. A single value, no fallback. See {@link Strategy}.
         *
         * @example { url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "debugger" }
         * @example { url: "*://ads.example.com/*", strategy: wt.isMV3 ? "rules" : "extension" }
         */
        strategy: Strategy;
    }

    /** @deprecated Use {@link RouteOptions} — a network route is always the object form now. */
    type Route = RouteOptions;

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

    /** Route fields shared by every `wt.onPage` form (and the deprecated `wt.onOverlay`). */
    interface DocumentRouteOptions extends DocumentOptions {
        /** Frame URLs (top page and iframes) to run in. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /** Frame URLs to skip even when `url` matches. */
        exclude?: UrlPatterns;
    }

    /** Where a deprecated `onOverlay` handler runs: URL pattern(s) or the full {@link DocumentRouteOptions} form. */
    type DocumentRoute = UrlPatterns | DocumentRouteOptions;

    /**
     * Full route form for `wt.onPage` on the page's own DOM (`dom: "page"`,
     * the default). Two settings say where a handler runs:
     *
     * | | `dom: "page"` (default) | `dom: "overlay"` |
     * |---|---|---|
     * | `js: "isolated"` (default) | the site's DOM, private JS | its own layer, private JS |
     * | `js: "page"` | the site's DOM and JS | its own layer, the site's JS (`unsafe: true`) |
     */
    interface PageRouteOptions extends DocumentRouteOptions {
        /**
         * Which JavaScript world the handler runs in.
         * - `"isolated"` (default): a private world with none of the site's
         *   JavaScript. The site can't see or impersonate it, so it may use
         *   this script's stores and call its overlay (top frame). Read the
         *   site's globals with {@link PageCtx.evaluate}. On Chrome (MV3) it
         *   runs through user scripts, which must be turned on (the Editor
         *   shows how).
         * - `"page"`: the site's own world. It reads the site's globals
         *   (`window.myApp`) directly, and the site can see and tamper with
         *   it, so it gets no stores and can't call the overlay. It can
         *   answer the overlay's calls.
         *
         * @example wt.onPage({ url: "*://example.com/*", js: "page" }, () => { … })
         */
        js?: "isolated" | "page";
        /**
         * Which DOM the handler works on: `"page"` (default), the site's
         * own; `"overlay"`, a layer of its own over the page (top frame
         * only). See {@link OverlayRouteOptions}.
         */
        dom?: "page";
        /**
         * @deprecated Renamed to {@link js} (`"main"` is `"page"`). Don't
         * pass both.
         */
        world?: "isolated" | "page" | "main";
    }

    /** Where an `onPage` handler runs: URL pattern(s) or the full {@link PageRouteOptions} form. */
    type PageRoute = UrlPatterns | PageRouteOptions;

    /**
     * `wt.onPage({ url, dom: "overlay" })`: the handler draws this script's
     * **overlay**, a transparent layer of its own over the page (top frame
     * only), with its own `document`. What it draws is visible and
     * clickable; everywhere else, clicks go through to the page.
     *
     * By default (`js: "isolated"`) the overlay is a frame of its own,
     * with its own `window`: the site can't see or reach it. It has the
     * script's stores, `fetch`es as the page, can call the script's
     * `onPage` code and be called by it, and the Editor's Preview shows it.
     * All of the script's matching overlay handlers run in it, sharing
     * top-level variables.
     */
    interface OverlayRouteOptions extends DocumentRouteOptions {
        dom: "overlay";
        /** `"isolated"` (default): the overlay's own frame. `"page"` needs `unsafe: true` ({@link PageOverlayRouteOptions}). */
        js?: "isolated";
    }

    /**
     * `wt.onPage({ url, js: "page", dom: "overlay", unsafe: true })`: the
     * overlay's layer runs as the site's own code — `window` is the
     * site's (its globals, directly), `document` is the layer's. Use it
     * at your own risk: the site can see, read and change what it draws,
     * and call into it. So it gets no stores, can't call or be called by
     * the script's other code, and `wt.fetch` and the built-in React
     * aren't available. It runs where the page allows `eval` (its CSP);
     * the Preview runs it like a default overlay.
     *
     * The script runs once more for it, with that `document`: its
     * top-level variables aren't shared with the script's other `onPage`
     * code.
     */
    interface PageOverlayRouteOptions extends DocumentRouteOptions {
        dom: "overlay";
        js: "page";
        /** Required: you accept that the site can see and tamper with this overlay. */
        unsafe: true;
    }

    /** Any function. */
    type Fn = (...args: any[]) => unknown;

    /**
     * The other side's functions, made async: what `wt.onPage` and
     * overlay handlers (`dom: "overlay"`) return. A handler that returns a plain object of
     * functions exposes them; any other return value (nothing, a string, an
     * element) exposes nothing. Arguments and results are JSON (≤ 1 MB);
     * calls time out after 10 s.
     *
     * @example
     * const page = wt.onPage("*://example.com/*", () => ({ count: (sel: string) => document.querySelectorAll(sel).length }));
     * // in the overlay: const n = await page.count("a"); // n: number
     */
    type Remote<T> = [T] extends [Record<string, Fn>]
        ? { readonly [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }
        : {};

    /** The context an `onPage` handler gets (`url` is the frame's URL). */
    interface PageCtx extends RequestCtx {
        /**
         * Run `fn` in the page's own JavaScript world and get what it
         * returns: how isolated code reads the site's globals
         * (`window.myApp`). `fn` runs there as page code, so it can't see
         * this script's variables (pass what it needs as `args`). Arguments
         * and the result are copied (plain data; a promise is awaited).
         *
         * A function argument (also inside a plain object or array) is a callback: `fn` gets a stand-in that calls
         * it back here (where stores and the overlay are), also later — from
         * the site's events — for as long as the document lives. Its
         * arguments are copied page data; it returns nothing to `fn`.
         *
         * The page can see the call and fake its answer: treat the result
         * as untrusted input, and never pass secrets. Rejects when the
         * page's CSP forbids `eval` or the page world doesn't answer. In
         * `js: "page"` code it just calls `fn`.
         *
         * @example
         * const user = await ctx.evaluate(() => (window as any).myApp?.user?.name);
         * if (typeof user === "string") state.user = user;
         *
         * @example
         * const n = await ctx.evaluate((sel: string) => document.querySelectorAll(sel).length, "a");
         *
         * @example
         * // keep a store in sync with the site's own state
         * ctx.evaluate((setUser) => {
         *     (window as any).myApp.on("login", (u: any) => setUser(u?.name));
         * }, (name: unknown) => {
         *     if (typeof name === "string") state.user = name;
         * });
         */
        evaluate<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
    }

    /** The context an overlay handler (`dom: "overlay"`) gets (`url` is the page's URL). */
    interface OverlayCtx extends RequestCtx {
        /**
         * Run `fn` with the page's new URL whenever it navigates in place
         * (history API, back/forward, `#hash` changes), as single-page apps
         * do. The overlay stays; returns a function that stops listening.
         *
         * @example
         * wt.onPage({ url: "*://example.com/*", dom: "overlay" }, (ctx) => {
         *     const show = (url: string) => (badge.hidden = !url.includes("/cart"));
         *     show(ctx.url);
         *     ctx.onNavigate(show);
         * });
         */
        onNavigate(fn: (url: string) => void): () => void;
        /**
         * Run `fn` when the user presses `keys` on the page: "Alt+Shift+M",
         * "Mod+K" (Mod = Cmd on macOS, Ctrl elsewhere), "Shift+F2", "Esc".
         * Ignored while typing in a text field. By default the shortcut
         * beats the page (which never sees the key); `"after-page"` fires
         * only if the page didn't handle it. Keys pressed while the overlay
         * has focus work too. If another script has the same keys, the
         * one higher in the script list wins (a Log warning). Returns a function that removes it.
         *
         * @example
         * wt.onPage({ url: "*://example.com/*", dom: "overlay" }, (ctx) => {
         *     ctx.shortcut("Alt+Shift+H", () => (box.hidden = !box.hidden));
         *     ctx.shortcut("Mod+K", openSearch, { priority: "after-page" });
         * });
         */
        shortcut(keys: string, fn: () => void, opts?: { priority?: "before-page" | "after-page" }): () => void;
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

    /** A JSON value: what a {@link wt.globalStore} may hold. */
    type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

    /** Options for {@link wt.globalStore}. */
    interface StoreOptions<T> {
        /**
         * What survives a browser restart: `true` (default) the whole store,
         * `false` nothing (it still survives an MV3 service-worker restart),
         * or a list of top-level fields.
         */
        persist?: boolean | (keyof T & string)[];
    }

    /** `wt.fetch` options: `RequestInit` plus where the request comes from. */
    interface FetchInit extends RequestInit {
        /**
         * `"background"`: the extension fetches, with its host permissions
         * (no CORS) and the browser's cookies. `"page"`: the page fetches (its
         * origin, cookies and CORS) — from an overlay only. Default:
         * `"page"` in an overlay, `"background"` elsewhere. An overlay's own
         * `fetch()` is the page's too.
         */
        from?: "page" | "background";
        /** Skip every script's handlers (this script's too) for this request; the Log shows it as `bypass`. */
        bypass?: boolean;
    }

    /** Timing for `wt.onPage` (part of its route object). */
    interface DocumentOptions {
        /**
         * **When** the `onPage` handler runs, relative to the page's own loading.
         * Default: `"document_end"`.
         *
         * **How it gets there:** in every frame (top page *and* iframes) the
         * extension injects a small hook at `document_start`. The hook asks
         * the background for the scripts with an `onPage` route covering *that
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
         * - A script may register several `onPage` handlers, each with its
         *   own route and `when`. Handlers with the same `when` run in
         *   script-list order, then registration order.
         * - Async handlers are not awaited; `when` controls only when they
         *   *start*.
         * - With `js: "page"`, if the page's CSP forbids `eval`, the
         *   handler falls back to the isolated world: same DOM and timing,
         *   but page-defined globals (e.g. `window.myApp`) are not visible.
         *
         * @example
         * // default: document_end (DOMContentLoaded)
         * wt.onPage("*://example.com/*", () => {
         *     document.title = "🎯 " + document.title;
         * });
         *
         * @example
         * // before page scripts (best effort, see race caveat)
         * wt.onPage({ url: "*://example.com/*", when: "document_start" }, () => {
         *     Object.defineProperty(navigator, "webdriver", {
         *         get: () => false,
         *     });
         * });
         *
         * @example
         * // after everything loaded, then keep it applied across re-renders
         * wt.onPage({ url: "*://example.com/*", when: "document_idle" }, () => {
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
    /** {@link wt.metadata}'s argument (a bundle's metadata.json has the same fields, plus `scripts`) */
    interface Metadata {
        /** shown when installing and in the Explorer (default: the file name) */
        name?: string;
        /** dotted version ("1.2.0"); an update to a lower one waits for review */
        version?: string;
        /** one line about what it does: the Editor's and popup's tooltip */
        description?: string;
        /** a link shown when installing */
        homepage?: string;
        author?: string;
        license?: string;
        /** hosts this script's wt.fetch calls reach — an update that adds one waits for review */
        connect?: string[];
    }

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
 * wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
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
     * @param route Where it applies — see {@link Wiretrick.RouteOptions}.
     * @param handler Called once per matching request with its context.
     *
     * @example
     * // answer an endpoint without the network
     * wt.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => ({
     *     replaceResponse: { body: { id: Number(ctx.groups.id), name: "Mock" } },
     * }));
     *
     * @example
     * // add a header to every POST, on the debugger
     * wt.onRequest({ url: "*://example.com/*", methods: ["POST"], strategy: "debugger" }, () => ({
     *     headers: { set: { "x-debug": "1" } },
     * }));
     */
    onRequest(route: Wiretrick.RouteOptions, handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.Awaitable<Wiretrick.RequestResult | void>): void;

    /**
     * Inspect / modify response headers. **All** matching handlers run.
     * Not available on the `"page"` strategy (the page can't change headers
     * before the browser enforces them).
     *
     * @param route Where it applies — see {@link Wiretrick.RouteOptions}.
     * @param handler Called when the response headers arrive.
     *
     * @example
     * wt.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
     *     headers: {
     *         set: { "access-control-allow-origin": "*" },
     *         remove: ["content-security-policy"],
     *     },
     * }));
     */
    onResponseHeaders(
        route: Wiretrick.RouteOptions,
        handler: (ctx: Wiretrick.ResponseHeaderCtx) => Wiretrick.Awaitable<Wiretrick.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, `Uint8Array`,
     * an object (sent as JSON), or `{ file: "<path or data url>" }`; return
     * nothing to leave the response alone.
     *
     * @param route Where it applies — see {@link Wiretrick.RouteOptions}.
     * @param handler Called per matching response; its result becomes the body.
     *
     * @example
     * wt.replaceResponse({ url: "*://api.example.com/flags", strategy: "helper" }, () => ({ beta: true }));
     *
     * @example
     * // serve a fixture fetched elsewhere
     * wt.replaceResponse({ url: "*://api.example.com/user", strategy: "helper" }, async () => {
     *     const res = await fetch("https://fixtures.local/user.json");
     *     return await res.text();
     * });
     */
    replaceResponse(
        route: Wiretrick.RouteOptions,
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
     * @param route Where it applies — see {@link Wiretrick.RouteOptions}.
     * @param transform Receives the context and the original body; returns
     * the new body, or nothing (`undefined` / `null`) to leave it as it is.
     * Any body returned counts as a change — even the same one: it's
     * re-encoded and served in place of the original.
     *
     * @example
     * wt.onResponseBody({ url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "helper" }, (ctx, body) => {
     *     return body.replace("DEBUG=false", "DEBUG=true");
     * });
     * @example
     * // binary: true — swap an image
     * wt.onResponseBody({ url: "*://example.com/logo.png", binary: true, strategy: "helper" }, async (ctx, body) => {
     *     const res = await fetch("https://example.org/other.png");
     *     return new Uint8Array(await res.arrayBuffer());
     * });
     */
    onResponseBody(
        route: Wiretrick.BodyRouteOptions & { binary?: false },
        transform: (ctx: Wiretrick.BodyCtx, body: string) => Wiretrick.Awaitable<string | Uint8Array | void>
    ): void;
    onResponseBody(
        route: Wiretrick.BodyRouteOptions & { binary: true },
        transform: (ctx: Wiretrick.BodyCtx, body: Uint8Array) => Wiretrick.Awaitable<string | Uint8Array | void>
    ): void;
    onResponseBody(
        route: Wiretrick.BodyRouteOptions,
        transform: (ctx: Wiretrick.BodyCtx, body: string | Uint8Array) => Wiretrick.Awaitable<string | Uint8Array | void>
    ): void;

    /**
     * Run a handler in the page — the resilient way to change titles, text
     * and DOM content. Works no matter how the response arrived
     * (service-worker-served HTML, cached pages, hydration). Strategies
     * don't apply.
     *
     * Runs once per document load in every frame whose URL matches the
     * route — by default at `DOMContentLoaded` (`when: "document_end"`), in
     * a private world that shares the page's DOM but not its JavaScript
     * (`js: "isolated"`; read the site's globals with `ctx.evaluate`, or
     * use `js: "page"`). A script may register several, each with its
     * own route, `when`, `js` and `dom`.
     *
     * The handler may return an object of functions: the returned handle
     * lets this script's overlay call them (`await page.fn(…)`, top frame
     * only). See {@link Wiretrick.Remote}.
     *
     * With `dom: "overlay"` the handler draws the script's overlay instead:
     * a layer of its own over the page. See
     * {@link Wiretrick.OverlayRouteOptions}.
     *
     * @param route Frame URL pattern(s), or `{ url, exclude, when, js, dom }`. See
     * {@link Wiretrick.DocumentOptions.when} for exact timing, the MV3
     * `document_start` race, SPA/re-render behavior and live-update re-runs,
     * and {@link Wiretrick.PageRouteOptions} for where it runs.
     * @param handler Receives the same `ctx` shape as `onRequest` (`url` is
     * the frame's URL). May be async (not awaited).
     *
     * @example
     * wt.onPage("*://example.com/*", () => {
     *     document.title = "🎯 " + document.title;
     * });
     *
     * @example
     * // after the page's load event
     * wt.onPage({ url: "*://example.com/*", when: "document_idle" }, () => {
     *     const el = document.querySelector("h1");
     *     if (el) el.textContent = "Intercepted";
     * });
     *
     * @example
     * // functions for the overlay to call
     * const page = wt.onPage("*://example.com/*", () => ({
     *     count: (selector: string) => document.querySelectorAll(selector).length,
     * }));
     *
     * @example
     * // the overlay: a button over the page
     * wt.onPage({ url: "*://example.com/*", dom: "overlay" }, () => {
     *     const b = document.body.appendChild(document.createElement("button"));
     *     b.textContent = "Hi";
     *     b.style.cssText = "position:fixed;right:16px;bottom:16px";
     * });
     */
    onPage<T = void>(route: Wiretrick.PageRoute, handler: (ctx: Wiretrick.PageCtx) => Wiretrick.Awaitable<T>): Wiretrick.Remote<T>;
    /**
     * Draw this script's **overlay**: a transparent frame over the page
     * (top frame only) with its own `document`, in an isolated world the
     * page can't see or reach. See {@link Wiretrick.OverlayRouteOptions}.
     *
     * @param route `{ url, exclude, when, dom: "overlay" }`.
     * @param handler Draws the GUI. May return functions for this script's
     * isolated onPage code to call.
     *
     * @example
     * wt.onPage({ url: "*://example.com/*", dom: "overlay" }, () => {
     *     const b = document.body.appendChild(document.createElement("button"));
     *     b.textContent = "Hi";
     * });
     */
    onPage<T = void>(route: Wiretrick.OverlayRouteOptions, handler: (ctx: Wiretrick.OverlayCtx) => Wiretrick.Awaitable<T>): Wiretrick.Remote<T>;
    /**
     * Draw an overlay GUI whose code runs in the **site's** JavaScript
     * world (`window` is the site's, `document` the overlay's). The site
     * can see and tamper with it: no stores, no calls to or from it. See
     * {@link Wiretrick.PageOverlayRouteOptions}.
     *
     * @param route `{ url, exclude, when, js: "page", dom: "overlay", unsafe: true }`.
     * @param handler Draws the GUI. Its return value is ignored.
     */
    onPage<T = void>(route: Wiretrick.PageOverlayRouteOptions, handler: (ctx: Wiretrick.OverlayCtx) => Wiretrick.Awaitable<T>): {};

    /**
     * @deprecated Renamed to {@link wt.onPage} — same arguments and behavior.
     */
    onDocument<T = void>(route: Wiretrick.PageRoute, handler: (ctx: Wiretrick.PageCtx) => Wiretrick.Awaitable<T>): Wiretrick.Remote<T>;

    /**
     * @deprecated Use `wt.onPage({ url, dom: "overlay" }, handler)` — same
     * behavior. See {@link Wiretrick.OverlayRouteOptions}.
     *
     * Run a handler in this script's **overlay**: a transparent frame over
     * the page (top frame only), with its own `document` and `window`. What
     * the script draws there is visible and clickable; everywhere else,
     * clicks go through to the page. The page can't see or reach it.
     *
     * One overlay per script per tab: all of the script's matching
     * `onOverlay` handlers run in it, sharing top-level variables. Timing
     * follows `when`, as for `onPage`.
     *
     * The handler may return an object of functions for this script's
     * `onPage` code to call (not `js: "page"` code).
     *
     * @example
     * wt.onOverlay("*://example.com/*", () => {
     *     const b = document.body.appendChild(document.createElement("button"));
     *     b.textContent = "Hi";
     *     b.style.cssText = "position:fixed;right:16px;bottom:16px";
     * });
     */
    onOverlay<T = void>(route: Wiretrick.DocumentRoute, handler: (ctx: Wiretrick.OverlayCtx) => Wiretrick.Awaitable<T>): Wiretrick.Remote<T>;

    /**
     * The script's metadata. `description` is shown as a tooltip in the
     * Editor and the popup, and in diagnostics; the rest describes it as a
     * package — shown when someone installs it from a link, and `version`
     * orders its updates. Call it once.
     *
     * @example
     * wt.metadata({
     *     name: "GitHub dark mode",
     *     version: "1.2.0",
     *     description: "Darker GitHub, every page",
     *     connect: ["api.github.com"],
     * });
     */
    metadata(metadata: Wiretrick.Metadata): void;

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
     * wt.onRequest({ url: cfg.hosts.map((h) => `*://${h}/api/*`), strategy: "helper" }, () => {
     *     if (cfg.enabled) return { replaceResponse: { status: Number(cfg.status), body: { error: "forced" } } };
     * });
     *
     * @example
     * // parse: the script gets a URL (cfg.origin: URL), the ⚙ dialog edits the string
     * const cfg = wt.params({
     *     origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) },
     * });
     * wt.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
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
     * wt.onRequest({ url: `*://${host}/*`, strategy: "helper" }, () => ({ headers: { set: { "x-debug": "1" } } }));
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
     * wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, async () => {
     *     const hits = ((await wt.storage.get("hits")) ?? 0) + 1;
     *     await wt.storage.set("hits", hits);
     * });
     */
    storage: Wiretrick.Storage;

    /**
     * A live object shared by every place the script runs — its handlers
     * in every strategy, in every tab, and its overlays — kept across
     * browser restarts. It's a [valtio](https://valtio.dev) proxy: read and
     * change it like a plain object; `import { subscribe } from "valtio"`
     * to watch it. `name` is its key (one store per name per script, shared
     * with {@link pageStore}); values must be JSON (at most 1 MB). Call it
     * at top level. `onPage` code gets a live copy too, except with
     * `js: "page"` (the page could read and forge it).
     *
     * @example
     * const state = wt.globalStore("state", { mocking: true, hits: 0 });
     * wt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => {
     *     state.hits++;
     *     if (state.mocking) return { replaceResponse: { body: { mocked: true } } };
     * });
     */
    globalStore<T extends object>(name: string, initial: T, opts?: Wiretrick.StoreOptions<T>): T;

    /**
     * Like {@link globalStore}, but one copy per page: each tab's page
     * starts from `initial`, and a navigation or reload starts a new page
     * (single-page-app route changes don't). Use it so a page's overlay and
     * the handlers of that page's requests share state — e.g. a switch in
     * the overlay that turns a redirect on for this page only.
     *
     * A network handler sees the page of the request it handles (requests
     * of a navigation, like a redirect of it, still belong to the page being
     * left); an overlay sees its own page. Read it in the handler's
     * synchronous part: after an `await` the handler no longer knows its
     * page, so it throws — read what you need first, or keep a nested
     * object. Requests that aren't from a page (service workers, other
     * apps through the helper) see a throwaway copy of `initial`.
     * `onPage` code sees its page's copy; not available with
     * `js: "page"` (the page could read and forge it) or in `rules`
     * handlers (their rules serve every page); kept until the page ends
     * (not across browser restarts).
     *
     * @example
     * const page = wt.pageStore("page", { staging: false });
     * wt.onRequest({ url: "https://api.example.com/*", strategy: "helper" }, (ctx) => {
     *     if (page.staging) return { redirect: ctx.url.replace("api.", "staging-api.") };
     * });
     * wt.onPage({ url: "https://example.com/*", dom: "overlay" }, () => {
     *     // a checkbox bound to page.staging (useSnapshot(page) from "valtio")
     * });
     */
    pageStore<T extends object>(name: string, initial: T): T;

    /** @deprecated Renamed: use {@link globalStore} (or {@link pageStore} for one copy per page). Calling it throws. */
    store(name: string, initial: object, opts?: unknown): never;

    /**
     * `fetch` for scripts. By default it runs in the background with the
     * extension's host permissions (no CORS) and the browser's cookies.
     * `bypass: true` keeps every script's handlers — this one's too — off
     * the request, e.g. to get the real response a mock replaces.
     *
     * @example
     * const real = await (await wt.fetch("https://api.example.com/user", { bypass: true })).json();
     */
    fetch(input: string | URL | Request, init?: Wiretrick.FetchInit): Promise<Response>;

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
     * wt.onResponseBody({ url: "*://example.com/app.js", strategy: wt.isFirefox ? "extension" : "helper" }, (ctx, body) => body.replace("DEBUG=false", "DEBUG=true"));
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
 * The same syntax as handler routes (`wt.onRequest({ url: pattern, strategy }, fn)`).
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

/**
 * An `.svg` data file imports as its markup, a string:
 * `import logo from "./icons/logo.svg"; el.innerHTML = logo;`
 */
declare module "*.svg" {
    const markup: string;
    export default markup;
}
