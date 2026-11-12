/**
 * Public `tt` API typings — shipped into the editor as an extra lib and
 * written into the VS Code folder so scripts get full IntelliSense.
 */

declare namespace TangiTweak {
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
         * tt.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => {
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
         * tt.onRequest({ url: "https://api.example.com/*", methods: ["POST"], strategy: "helper" }, (ctx) => {
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
         * tt.replaceResponse({ url: "https://api.example.com/graphql", strategy: "helper" }, (ctx) => {
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
     * - `"helper"` — the local tangitweak-helper (a proxy). Sees every
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
     * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/strategies.md#compatibility
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
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/strategies.md#compatibility
         */
        resourceTypes?: ResourceType[];
        /**
         * The strategy that runs this handler — required, there is no
         * default. A single value, no fallback. See {@link Strategy}.
         *
         * @example { url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "debugger" }
         * @example { url: "*://ads.example.com/*", strategy: tt.isMV3 ? "rules" : "extension" }
         */
        strategy: Strategy;
    }

    /** Full route form for `tt.onResponseBody`. */
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
         * @see https://github.com/tangistudio/TangiTweak/blob/master/docs/scripting.md#binary-bodies
         */
        binary?: boolean | "both";
    }

    /** Route fields shared by `tt.onSite`, `tt.onPage` and `tt.onOverlay`. */
    interface DocumentRouteOptions extends DocumentOptions {
        /** Frame URLs (top page and iframes) to run in. See {@link UrlPatterns}. */
        url: UrlPatterns;
        /** Frame URLs to skip even when `url` matches. */
        exclude?: UrlPatterns;
    }

    /**
     * Where a page handler runs: URL pattern(s) or the full
     * {@link DocumentRouteOptions} form. The API says which world:
     *
     * | | runs in | sees | trusted |
     * |---|---|---|---|
     * | `tt.onSite` | the site's JavaScript world | the site's DOM and globals (`window.myApp`) | no — the site can see and tamper with it |
     * | `tt.onPage` | an isolated world | the site's DOM, none of its globals | yes |
     * | `tt.onOverlay` | the script's own frame over the page (top frame) | its own DOM | yes |
     */
    type PageRoute = UrlPatterns | DocumentRouteOptions;

    /** Any function. */
    type Fn = (...args: any[]) => unknown;

    /**
     * A **handle**: the handler's functions, made async — what `tt.onSite`,
     * `tt.onPage` and `tt.onOverlay` return. A handler that returns a
     * plain object of functions exposes them; any other return value
     * (nothing, a string, an element) exposes nothing.
     *
     * Call a handle from `onPage` or `onOverlay` code (trusted code). In
     * `onSite` code a call throws: the site could make it too. A call
     * waits — with no time limit — until the handler has run in that
     * frame, also across a reload of the script; arguments and results are
     * JSON (≤ 1 MB). It rejects with:
     * - `DisconnectedError`: the other side went away (the frame navigated, the overlay closed);
     * - `AbortError`: the calling code's run ended first (its script reloaded); the call is cancelled;
     * - `ReloadedError`: the handler's script reloaded while the function ran — call again, the new run answers;
     * - `WtCallError`: the function threw, doesn't exist, or the value isn't JSON.
     *
     * Results from an `onSite` handle are the site's data: treat them as untrusted input.
     *
     * @example
     * const site = tt.onSite("*://example.com/*", () => ({ user: () => (window as any).myApp?.user?.name as string | undefined }));
     * tt.onPage("*://example.com/*", async () => {
     *     const name = await site.user(); // string | undefined
     * });
     */
    type Remote<T> = [T] extends [Record<string, Fn>]
        ? { readonly [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }
        : {};

    /**
     * What every page handler's ctx has: its **run** and what the run sets
     * up. Saving the script runs the handler again (a new run); when it
     * returns, the old run's `signal` aborts, and what the old run set up
     * with `once`, `patch`, `style` and `mount` stays only if the new run
     * set it up too (a mount re-renders, a patch swaps its function) — the
     * rest is undone. If the new run throws, the old one keeps running.
     */
    interface RunCtx {
        /**
         * Aborts when this run ends: the script was saved (a new run took
         * over), disabled or deleted. Pass it to `addEventListener`,
         * `fetch` and the like so they stop with the run.
         *
         * @example
         * tt.onPage("*://example.com/*", (ctx) => {
         *     document.addEventListener("click", onClick, { signal: ctx.signal });
         *     const t = setInterval(poll, 1000);
         *     ctx.signal.addEventListener("abort", () => clearInterval(t));
         * });
         */
        readonly signal: AbortSignal;
        /**
         * `fn()`'s value, made once per page: later runs with the same
         * `key` get the same value (the cache is dropped when a run stops
         * asking for it).
         *
         * @example
         * const db = ctx.once("db", () => new Map<string, string>()); // survives saves
         */
        once<T>(key: string, fn: () => T): T;
        /**
         * Replace the function `obj[prop]` with `wrap(original)`. The
         * replacement is installed once (the site may keep a reference to
         * it); each run sets what it does, and once no run patches it any
         * more it calls the original.
         *
         * @example
         * tt.onSite("*://example.com/*", (ctx) => {
         *     ctx.patch(history, "pushState", (orig) => function (this: History, ...args: any[]) {
         *         console.log("navigating to", args[2]);
         *         return orig.apply(this, args);
         *     });
         * });
         */
        patch<O extends object, K extends keyof O>(obj: O, prop: K, wrap: (orig: O[K]) => O[K]): void;
        /**
         * Add `css` to the page (its `<head>`, and each `ctx.mount` of the
         * script); removed once no run adds it any more.
         *
         * @example
         * ctx.style(`.ad-banner { display: none !important }`);
         */
        style(css: string): void;
    }

    /** Where and how `ctx.mount(target, ui, opts)` places its UI. */
    interface MountOptions {
        /**
         * Where the UI goes, relative to each match:
         * - `"inside-last"` (default) / `"inside-first"`: its last or first child.
         * - `"before"` / `"after"`: its sibling.
         * - `"overlay"`: covering it (`position: absolute; inset: 0`, clicks
         *   pass through to the page except on your UI). A `static` match
         *   becomes `position: relative` while the overlay is there.
         */
        position?: "inside-last" | "inside-first" | "before" | "after" | "overlay";
        /** Tells apart two mounts at the same target and position. */
        key?: string;
        /** Only the first match. It moves to the next match when the page replaces it. */
        first?: boolean;
        /**
         * Put the UI back when the page removes it, for example when a
         * framework re-renders the match's children. It stops, with an
         * error in Problems, if the page keeps removing it (a fight).
         */
        autoRestore?: boolean;
    }

    /** What `onPage` and `onOverlay` ctx add: React UI and handle loops. */
    interface TrustedRunCtx extends RunCtx {
        /**
         * Render `ui` (JSX) into the page. Without a target it floats over
         * the page. With one, it goes on every element the selector matches,
         * now and later (or on that element), at `opts.position`. A match
         * that goes away unmounts its UI.
         *
         * `ui` can be a function. It's called with the anchor element, may
         * use hooks, and is re-run with the latest code on each save.
         *
         * Each save re-renders the same React roots, and named function
         * components keep their state, nested ones too (see "Component
         * state across saves" in docs/scripting.md). Once no run mounts
         * there any more it unmounts.
         *
         * In `onPage` the UI sits in a closed shadow root: the page's CSS
         * doesn't reach it, but `ctx.style` does. In `onOverlay` it goes into
         * the overlay's `<body>`.
         *
         * A handler has one mount per (target, position, key). Mounting there
         * again, also later in the run, re-renders it.
         *
         * Returns a function that removes this mount early.
         *
         * @example
         * tt.onPage("*://example.com/*", (ctx) => {
         *     ctx.mount("#header", <button onClick={() => alert("hi")}>Hi</button>);
         *     ctx.mount(".card", (card) => <Badge id={card.id} />, { position: "overlay" });
         * });
         * tt.onOverlay("*://example.com/*", (ctx) => ctx.mount(<Panel />));
         */
        mount(ui: unknown): () => void;
        mount(target: string | Element, ui: unknown | ((anchor: Element) => unknown), opts?: MountOptions): () => void;
        /**
         * Call `fn(...args)` over and over, yielding each answer — for a
         * handle function that answers when something happens. A call cut
         * by the other side's reload is made again; the loop ends when this
         * run does.
         *
         * @example
         * const site = tt.onSite("*://example.com/*", (ctx) => {
         *     const logins: string[] = [], waiting: ((u: string) => void)[] = [];
         *     // answer every waiting call: one may be from a run that ended since
         *     window.addEventListener("app:login", (e: any) => (waiting.length ? waiting.splice(0).forEach((w) => w(e.detail)) : logins.push(e.detail)), { signal: ctx.signal });
         *     return { nextLogin: () => (logins.length ? Promise.resolve(logins.shift()!) : new Promise<string>((r) => waiting.push(r))) };
         * });
         * tt.onPage("*://example.com/*", async (ctx) => {
         *     for await (const user of ctx.each(site.nextLogin)) tt.log("login:", user);
         * });
         */
        each<A extends any[], T>(fn: (...args: A) => Promise<T>, ...args: A): AsyncIterableIterator<T>;
    }

    /** The context an `onSite` handler gets (`url` is the frame's URL). No `mount`: React isn't in the site's world. */
    interface SiteCtx extends RequestCtx, RunCtx {}

    /** The context an `onPage` handler gets (`url` is the frame's URL). */
    interface PageCtx extends RequestCtx, TrustedRunCtx {
        /**
         * Run `fn` when the user presses `keys` on the page: "Alt+Shift+M",
         * "Mod+K" (Mod = Cmd on macOS, Ctrl elsewhere), "Shift+F2", "Esc".
         * `""` adds nothing, so a `shortcut` param the user cleared just
         * works: `ctx.shortcut(cfg.toggle, fn)`.
         * Works at all times, text fields included. By default the shortcut
         * beats the page (which never sees the key); `"after-page"` fires
         * only if the page didn't handle it. Return `"pass"` from `fn` to
         * hand the key on to the page as if no shortcut matched (anything
         * else, `undefined` included, consumes it). If another script has the same
         * keys, the one higher in the script list wins (a Log warning).
         * Returns a function that removes it (it's also removed when the
         * run ends).
         *
         * onPage: keys pressed in the frame the handler runs in. Overlay:
         * keys pressed in the page or in the overlay. `"pass"` works for
         * keys pressed in the overlay only: a page key reaches the overlay
         * after the page's turn, so it stays consumed.
         *
         * @example
         * tt.onPage("*://example.com/*", (ctx) => {
         *     ctx.shortcut("Alt+Shift+H", () => { box.hidden = !box.hidden; });
         *     ctx.shortcut("Mod+K", openSearch, { priority: "after-page" });
         *     // Esc closes the box when it's open; otherwise the page gets Esc
         *     ctx.shortcut("Esc", () => (box.hidden ? "pass" : void (box.hidden = true)));
         * });
         */
        shortcut(keys: string, fn: () => unknown, opts?: { priority?: "before-page" | "after-page" }): () => void;
    }

    /** The context an `onOverlay` handler gets (`url` is the page's URL). */
    interface OverlayCtx extends RequestCtx, TrustedRunCtx, Pick<PageCtx, "shortcut"> {
        /**
         * Run `fn` with the page's new URL whenever it navigates in place
         * (history API, back/forward, `#hash` changes), as single-page apps
         * do. The overlay stays; returns a function that stops listening
         * (it also stops when the run ends).
         *
         * @example
         * tt.onOverlay("*://example.com/*", (ctx) => {
         *     const show = (url: string) => (badge.hidden = !url.includes("/cart"));
         *     show(ctx.url);
         *     ctx.onNavigate(show);
         * });
         */
        onNavigate(fn: (url: string) => void): () => void;
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
         * const hits = (await tt.storage.get("hits")) ?? 0;
         */
        get(key: string): Promise<any>;
        /**
         * Store a value (persists across reloads and browser restarts).
         *
         * @example
         * await tt.storage.set("hits", hits + 1);
         */
        set(key: string, value: any): Promise<void>;
    }

    /** A JSON value: what a {@link tt.globalStore} may hold. */
    type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

    /** Options for {@link tt.globalStore}. */
    interface StoreOptions<T> {
        /**
         * What survives a browser restart: `true` (default) the whole store,
         * `false` nothing (it still survives an MV3 service-worker restart),
         * or a list of top-level fields.
         */
        persist?: boolean | (keyof T & string)[];
    }

    /** `tt.fetch` options: `RequestInit` plus where the request comes from. */
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

    /** Timing for `tt.onSite`, `tt.onPage` and `tt.onOverlay` (part of the route object). */
    interface DocumentOptions {
        /**
         * **When** the handler runs, relative to the page's own loading.
         * `onSite` runs before the site, `onPage`/`onOverlay` when the DOM
         * is ready; `when` changes that. Default: `"document_start"` for
         * `tt.onSite` (to get in ahead of the site's scripts: patch
         * `fetch`, catch a store as it's created), `"document_end"` for
         * `tt.onPage` and `tt.onOverlay` (DOM work needs `<body>`).
         *
         * **How it gets there:** in every frame (top page *and* iframes) the
         * extension injects a small hook at `document_start`. The hook asks
         * the background for the scripts with a page route covering *that
         * frame's* URL, compiles them, and schedules each matching handler
         * according to its own `when`.
         *
         * | `when` | Fires | DOM state |
         * |---|---|---|
         * | `"document_start"` *(onSite)* | as soon as the script is compiled | only `<html>`; `head`/`body` usually `null` |
         * | `"document_end"` *(onPage, onOverlay)* | at `DOMContentLoaded` (DOM parsed) | whole DOM queryable; images/iframes may still load |
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
         * - Saving the script while the page is open runs the handler again
         *   **immediately**, regardless of `when` (a new run): what it sets
         *   up with `ctx.once` / `ctx.patch` / `ctx.style` / `ctx.mount` is
         *   kept or undone, the previous run's `ctx.signal` aborts. No
         *   `document.readyState` guards needed.
         * - `ctx.mount(target, ui)` waits for `target`, so an `onPage` at
         *   `document_start` can still draw once the target appears.
         * - A script may register several page handlers, each with its
         *   own route and `when`. Handlers with the same `when` run in
         *   script-list order, then registration order.
         * - Async handlers are not awaited; `when` controls only when they
         *   *start*.
         * - `onSite`: if the page's CSP forbids `eval`, the handler falls
         *   back to the isolated world: same DOM and timing, but
         *   page-defined globals (e.g. `window.myApp`) are not visible.
         *
         * @example
         * // onPage default: document_end (DOMContentLoaded)
         * tt.onPage("*://example.com/*", () => {
         *     document.title = "🎯 " + document.title;
         * });
         *
         * @example
         * // before page scripts (best effort, see race caveat)
         * tt.onPage({ url: "*://example.com/*", when: "document_start" }, () => {
         *     Object.defineProperty(navigator, "webdriver", {
         *         get: () => false,
         *     });
         * });
         *
         * @example
         * // after everything loaded, then keep it applied across re-renders
         * tt.onPage({ url: "*://example.com/*", when: "document_idle" }, () => {
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

    // ---- tt.params / tt.defineParam: typed, user-adjustable parameters ----

    /** An on/off switch — a checkbox in the ⚙ dialog. */
    /** {@link tt.metadata}'s argument (a bundle's metadata.json has the same fields, plus `scripts`) */
    interface Metadata {
        /** shown when installing and in the Explorer (default: the file name) */
        name?: string;
        /** dotted version ("1.2.0"); an update to a lower one waits for review */
        version?: string;
        /** one line about what it does: the Editor's and popup's tooltip */
        description?: string;
        /** icon shown in the Explorer and popup: a relative .svg/.png/… path, data: or https:// URL, or inline <svg> */
        icon?: string;
        /** a link shown when installing */
        homepage?: string;
        author?: string;
        license?: string;
        /**
         * Where updates come from, instead of where it was installed from: a
         * script, metadata.json or .zip URL, a GitHub file or folder
         * (`github.com/o/r/tree/main/dir`), a gist (`gist.github.com/u/id`) or a
         * gist's raw file URL. A copy installed from a folder or zip updates
         * from it too. An update that changes it waits for review.
         */
        updateURL?: string;
        /** hosts this script's tt.fetch calls reach — an update that adds one waits for review */
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
    /**
     * Keys for {@link PageCtx.shortcut} — the ⚙ dialog records them as
     * you press them, with buttons to remove the shortcut and reset it to
     * the default. The value is the keys ("Mod+Shift+K", Mod being Cmd on
     * macOS and Ctrl elsewhere), or `""` once removed.
     *
     * @example
     * const cfg = tt.params({ toggle: { type: "shortcut", default: "Alt+Shift+H" } });
     * tt.onOverlay("*://example.com/*", (ctx) => {
     *     ctx.shortcut(cfg.toggle, () => { box.hidden = !box.hidden; });
     * });
     */
    interface ParamDefShortcut {
        type: "shortcut";
        /** Default `""` (none). A default that isn't a shortcut is a script error. */
        default?: string;
        /** Shown next to the control and in settings.yaml. */
        description?: string;
        /**
         * Turn the raw value into what the script receives — the param's
         * type becomes this function's return type. The ⚙ dialog, Editor and
         * settings.yaml keep editing the raw value; `parse` re-runs whenever
         * it changes. A throw is a script error naming the param.
         */
        parse?: (raw: string) => unknown;
    }
    /** One adjustable parameter, discriminated by `type`. */
    type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList | ParamDefShortcut;

    /**
     * A nested object grouping parameters (or sub-sections) into collapsible
     * sections in the popup and nested maps in settings.yaml.
     */
    interface ParamGroup {
        readonly [key: string]: ParamDef | ParamGroup;
    }

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
                : D extends ParamDefShortcut
                  ? string
                  : never;

    /**
     * The value type a param def resolves to: `parse`'s return type when
     * the def has one, else {@link TangiTweak.ParamRawValue}.
     */
    type ParamValue<D extends ParamDef> = D extends { parse: (raw: never) => infer R } ? R : ParamRawValue<D>;

    type ParamIsReadonly<V> = V extends ParamDef ? (V extends { parse: Function } ? true : false) : true;
    type ParamEntryValue<V> = V extends ParamDef ? ParamValue<V> : V extends ParamGroup ? ParamsOf<V> : never;

    /**
     * Resolved parameter values, typed from the defs (and nested sections)
     * you passed. Leaf params are assignable from handler code
     * (`cfg.on = false`, `cfg.network.host = "b.com"`), except params with
     * `parse`.
     */
    type ParamsOf<T extends ParamGroup> = {
        -readonly [K in keyof T as ParamIsReadonly<T[K]> extends false ? K : never]: ParamEntryValue<T[K]>;
    } & {
        readonly [K in keyof T as ParamIsReadonly<T[K]> extends true ? K : never]: ParamEntryValue<T[K]>;
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
 * tt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => ({ headers: { set: { "x-debug": "1" } } }));
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
 * strategy (see {@link TangiTweak.Strategy}).
 *
 * **Async** — every handler may return a Promise. On Chromium's
 * `"extension"` strategy `onRequest`/`onResponseHeaders` must be
 * synchronous (an async result is ignored with a warning); every other
 * strategy awaits it.
 */
declare const tt: {
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
     * @param route Where it applies — see {@link TangiTweak.RouteOptions}.
     * @param handler Called once per matching request with its context.
     *
     * @example
     * // answer an endpoint without the network
     * tt.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => ({
     *     replaceResponse: { body: { id: Number(ctx.groups.id), name: "Mock" } },
     * }));
     *
     * @example
     * // add a header to every POST, on the debugger
     * tt.onRequest({ url: "*://example.com/*", methods: ["POST"], strategy: "debugger" }, () => ({
     *     headers: { set: { "x-debug": "1" } },
     * }));
     */
    onRequest(route: TangiTweak.RouteOptions, handler: (ctx: TangiTweak.RequestCtx) => TangiTweak.Awaitable<TangiTweak.RequestResult | void>): void;

    /**
     * Inspect / modify response headers. **All** matching handlers run.
     * Not available on the `"page"` strategy (the page can't change headers
     * before the browser enforces them).
     *
     * @param route Where it applies — see {@link TangiTweak.RouteOptions}.
     * @param handler Called when the response headers arrive.
     *
     * @example
     * tt.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
     *     headers: {
     *         set: { "access-control-allow-origin": "*" },
     *         remove: ["content-security-policy"],
     *     },
     * }));
     */
    onResponseHeaders(
        route: TangiTweak.RouteOptions,
        handler: (ctx: TangiTweak.ResponseHeaderCtx) => TangiTweak.Awaitable<TangiTweak.ResponseHeaderResult | void>
    ): void;

    /**
     * Replace the response body completely. Return a string, `Uint8Array`,
     * an object (sent as JSON), or `{ file: "<path or data url>" }`; return
     * nothing to leave the response alone.
     *
     * @param route Where it applies — see {@link TangiTweak.RouteOptions}.
     * @param handler Called per matching response; its result becomes the body.
     *
     * @example
     * tt.replaceResponse({ url: "*://api.example.com/flags", strategy: "helper" }, () => ({ beta: true }));
     *
     * @example
     * // serve a fixture fetched elsewhere
     * tt.replaceResponse({ url: "*://api.example.com/user", strategy: "helper" }, async () => {
     *     const res = await fetch("https://fixtures.local/user.json");
     *     return await res.text();
     * });
     */
    replaceResponse(
        route: TangiTweak.RouteOptions,
        handler: (ctx: TangiTweak.ReplaceCtx) => TangiTweak.Awaitable<string | Uint8Array | object | { file: string } | null | void>
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
     * @param route Where it applies — see {@link TangiTweak.RouteOptions}.
     * @param transform Receives the context and the original body; returns
     * the new body, or nothing (`undefined` / `null`) to leave it as it is.
     * Any body returned counts as a change — even the same one: it's
     * re-encoded and served in place of the original.
     *
     * @example
     * tt.onResponseBody({ url: "*://example.com/app/*.js", resourceTypes: ["script"], strategy: "helper" }, (ctx, body) => {
     *     return body.replace("DEBUG=false", "DEBUG=true");
     * });
     * @example
     * // binary: true — swap an image
     * tt.onResponseBody({ url: "*://example.com/logo.png", binary: true, strategy: "helper" }, async (ctx, body) => {
     *     const res = await fetch("https://example.org/other.png");
     *     return new Uint8Array(await res.arrayBuffer());
     * });
     */
    onResponseBody(
        route: TangiTweak.BodyRouteOptions & { binary?: false },
        transform: (ctx: TangiTweak.BodyCtx, body: string) => TangiTweak.Awaitable<string | Uint8Array | void>
    ): void;
    onResponseBody(
        route: TangiTweak.BodyRouteOptions & { binary: true },
        transform: (ctx: TangiTweak.BodyCtx, body: Uint8Array) => TangiTweak.Awaitable<string | Uint8Array | void>
    ): void;
    onResponseBody(
        route: TangiTweak.BodyRouteOptions,
        transform: (ctx: TangiTweak.BodyCtx, body: string | Uint8Array) => TangiTweak.Awaitable<string | Uint8Array | void>
    ): void;

    /**
     * Run a handler in the **site's own JavaScript world**: it reads the
     * site's globals (`window.myApp`, its Redux store) directly. The site
     * can see and tamper with it, so it's untrusted: no stores, and it
     * can't call handles. Return functions for the script's `onPage` and
     * `onOverlay` code to call ({@link TangiTweak.Remote}).
     *
     * Runs once per document load in every frame whose URL matches the
     * route, by default before the site's own scripts (`when:
     * "document_start"`; `document.body` is usually `null` then). See
     * {@link TangiTweak.DocumentOptions.when} for timing and
     * {@link TangiTweak.PageRoute} for the three places. On Chrome (MV3) it
     * runs through user scripts, which must be turned on (the Editor shows
     * how).
     *
     * @example
     * const site = tt.onSite("*://example.com/*", () => ({
     *     user: () => (window as any).myApp?.user?.name as string | undefined,
     *     dispatch: (action: { type: string }) => (window as any).__store.dispatch(action),
     * }));
     */
    onSite<T = void>(route: TangiTweak.PageRoute, handler: (ctx: TangiTweak.SiteCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

    /**
     * Run a handler in the page — the resilient way to change titles, text
     * and DOM content. Works no matter how the response arrived
     * (service-worker-served HTML, cached pages, hydration). Strategies
     * don't apply.
     *
     * Runs once per document load in every frame whose URL matches the
     * route — by default at `DOMContentLoaded` (`when: "document_end"`), in
     * an isolated world that shares the page's DOM but not its JavaScript.
     * It's trusted: it has the script's stores and calls its handles —
     * read the site's globals through a {@link onSite} handle, draw on the
     * overlay through an {@link onOverlay} one (top frame). On Chrome
     * (MV3) it runs through user scripts, which must be turned on (the
     * Editor shows how).
     *
     * The handler may return an object of functions, for the script's
     * other `onPage` and `onOverlay` code to call ({@link TangiTweak.Remote}).
     *
     * @param route Frame URL pattern(s), or `{ url, exclude, when }`. See
     * {@link TangiTweak.DocumentOptions.when} for exact timing, the MV3
     * `document_start` race, SPA/re-render behavior and live-update re-runs.
     * @param handler Receives the same `ctx` shape as `onRequest` (`url` is
     * the frame's URL). May be async (not awaited).
     *
     * @example
     * tt.onPage("*://example.com/*", () => {
     *     document.title = "🎯 " + document.title;
     * });
     *
     * @example
     * // read the site's state through an onSite handle
     * const site = tt.onSite("*://example.com/*", () => ({ user: () => (window as any).myApp?.user?.name }));
     * const state = tt.pageStore("state", { user: "" });
     * tt.onPage("*://example.com/*", async () => {
     *     const u = await site.user();
     *     if (typeof u === "string") state.user = u;
     * });
     */
    onPage<T = void>(route: TangiTweak.PageRoute, handler: (ctx: TangiTweak.PageCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

    /**
     * Draw this script's **overlay**: a transparent frame over the page
     * (top frame only) with its own `window` and `document`, which the
     * site can't see or reach. What it draws is visible and clickable;
     * everywhere else, clicks go through to the page. It has the script's
     * stores, `fetch`es as the page, calls the script's `onSite` and
     * `onPage` handles, and the Editor's Preview shows it. All of the
     * script's matching overlay handlers run in it, sharing top-level
     * variables.
     *
     * Warning: the frame is a TangiTweak extension page (that's what lets
     * the script run on sites whose CSP blocks scripts and `eval`, and
     * keeps the site out). Chrome won't let another extension attach its
     * debugger to a tab with such a frame, so tools like Playwriter remove
     * it: the GUI and its shortcuts stop, with a Log warning. A same-origin
     * `about:blank` frame wouldn't be removed, but it's under the page's
     * CSP and open to the page, so TangiTweak doesn't offer one. For a GUI
     * that must survive those tools, use `tt.onPage` with `ctx.mount` and
     * `ctx.shortcut` instead.
     *
     * @param route Page URL pattern(s), or `{ url, exclude, when }`.
     * @param handler Draws the GUI. May return functions for this script's
     * onPage code to call.
     *
     * @example
     * tt.onOverlay("*://example.com/*", () => {
     *     const b = document.body.appendChild(document.createElement("button"));
     *     b.textContent = "Hi";
     *     b.style.cssText = "position:fixed;right:16px;bottom:16px";
     * });
     */
    onOverlay<T = void>(route: TangiTweak.PageRoute, handler: (ctx: TangiTweak.OverlayCtx) => TangiTweak.Awaitable<T>): TangiTweak.Remote<T>;

    /**
     * The script's metadata. `description` is shown as a tooltip in the
     * Editor and the popup, and in diagnostics; the rest describes it as a
     * package — shown when someone installs it from a link, and `version`
     * orders its updates. Call it once.
     *
     * @example
     * tt.metadata({
     *     name: "GitHub dark mode",
     *     version: "1.2.0",
     *     description: "Darker GitHub, every page",
     *     connect: ["api.github.com"],
     * });
     */
    metadata(metadata: TangiTweak.Metadata): void;

    /**
     * Declare adjustable parameters, editable from the popup's ⚙ dialog,
     * the Editor and settings.yaml without touching the script. Returns
     * the current values (stored values over your defaults), typed from
     * your defs. Routes may be built from them — a change re-runs the
     * script. Libraries may declare params too (listed in the popup; one
     * that registers handlers only for some value becomes a script then).
     * Definitions may come from an import (`{ env: envParam }`, `{ ...defs }`).
     *
     * The values can be changed, like a valtio proxy: assign one
     * (`cfg.enabled = false`) or change a list in place
     * (`cfg.hosts.push("a.com")`) from a handler — onPage, onOverlay or
     * network code, not onSite code and not the top level. The value is
     * checked against its type (a wrong one throws), seen right away, and
     * saved like a ⚙ change: logged, written to settings.yaml, and the
     * script hot-reloads with it. A param with `parse` can't be assigned.
     *
     * @param defs Parameter name → definition (`type`, `default`, optional
     *   `description` and `parse`; see {@link TangiTweak.ParamDef}), or a
     *   nested section object ({@link TangiTweak.ParamGroup}) grouping
     *   related parameters in the popup and settings.yaml. With `parse`, the
     *   param's value is the parser's result (raw value in, e.g. a `URL` out)
     *   while the stored/edited value stays raw.
     * @returns The current values, typed from `defs`.
     *
     * @example
     * const cfg = tt.params({
     *     enabled: { type: "boolean", default: true, description: "Return errors" },
     *     network: {
     *         status: { type: "enum", choices: ["500", "503"], default: "500" },
     *         hosts: { type: "stringList", default: ["staging.example.com"] },
     *     },
     * });
     *
     * tt.onRequest({ url: cfg.network.hosts.map((h) => `*://${h}/api/*`), strategy: "helper" }, () => {
     *     if (cfg.enabled) return { replaceResponse: { status: Number(cfg.network.status), body: { error: "forced" } } };
     * });
     *
     * @example
     * // a page button turns the mock off and on (saved, the script re-runs)
     * tt.onOverlay("*://app.example.com/*", (ctx) => {
     *     const btn = ctx.once("btn", () => document.body.appendChild(document.createElement("button")));
     *     btn.textContent = cfg.enabled ? "Mock: on" : "Mock: off";
     *     btn.onclick = () => (cfg.enabled = !cfg.enabled);
     * });
     *
     * @example
     * // parse: the script gets a URL (cfg.origin: URL), the ⚙ dialog edits the string
     * const cfg = tt.params({
     *     origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) },
     * });
     * tt.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
     *     headers: { set: { "access-control-allow-origin": cfg.origin.origin } },
     * }));
     */
    params<const T extends TangiTweak.ParamGroup>(defs: T): TangiTweak.ParamsOf<T>;

    /**
     * Declare a single parameter and get its current value (same store as
     * {@link tt.params}).
     *
     * @example
     * const host = tt.defineParam("host", { type: "string", default: "api.example.com" });
     * tt.onRequest({ url: `*://${host}/*`, strategy: "helper" }, () => ({ headers: { set: { "x-debug": "1" } } }));
     *
     * @example
     * // parse: hosts is a Set<string>; the stored value stays a list
     * const hosts = tt.defineParam("hosts", { type: "stringList", parse: (l) => new Set(l) });
     */
    defineParam<const D extends TangiTweak.ParamDef>(name: string, def: D): TangiTweak.ParamValue<D>;

    /**
     * Per-script key/value storage (async, persistent).
     *
     * @example
     * tt.onRequest({ url: "*://example.com/*", strategy: "helper" }, async () => {
     *     const hits = ((await tt.storage.get("hits")) ?? 0) + 1;
     *     await tt.storage.set("hits", hits);
     * });
     */
    storage: TangiTweak.Storage;

    /**
     * A live object shared by every place the script runs — its handlers
     * in every strategy, in every tab, and its overlays — kept across
     * browser restarts. It's a [valtio](https://valtio.dev) proxy: read and
     * change it like a plain object; `import { subscribe } from "valtio"`
     * to watch it. `name` is its key (one store per name per script, shared
     * with {@link pageStore}); values must be JSON (at most 1 MB). Call it
     * at top level. `onPage` and `onOverlay` code get a live copy too;
     * `onSite` code doesn't (the site could read and forge it).
     *
     * @example
     * const state = tt.globalStore("state", { mocking: true, hits: 0 });
     * tt.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => {
     *     state.hits++;
     *     if (state.mocking) return { replaceResponse: { body: { mocked: true } } };
     * });
     */
    globalStore<T extends object>(name: string, initial: T, opts?: TangiTweak.StoreOptions<T>): T;

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
     * `onPage` code sees its page's copy; not available in `onSite` code
     * (the site could read and forge it) or in `rules` handlers (their rules serve every page); kept until the page ends
     * (not across browser restarts).
     *
     * @example
     * const page = tt.pageStore("page", { staging: false });
     * tt.onRequest({ url: "https://api.example.com/*", strategy: "helper" }, (ctx) => {
     *     if (page.staging) return { redirect: ctx.url.replace("api.", "staging-api.") };
     * });
     * tt.onOverlay("https://example.com/*", () => {
     *     // a checkbox bound to page.staging (useSnapshot(page) from "valtio")
     * });
     */
    pageStore<T extends object>(name: string, initial: T): T;

    /**
     * A live object the page's site may see: it lives in the site's
     * JavaScript world, one copy per page (a navigation or reload starts
     * from `initial`; single-page-app route changes don't), and `onSite`,
     * `onPage` and `onOverlay` code of this script on that page share it —
     * `onSite` code reads and changes it synchronously, the others get a
     * live copy that changes when it does (and changes it back). It's a
     * [valtio](https://valtio.dev) proxy: read and change it like a plain
     * object; `import { subscribe } from "valtio"` to watch it
     * (`useSnapshot` in overlays).
     *
     * Its data is page data: the site can read and change it, so keep
     * what the site mustn't see in a {@link globalStore} or
     * {@link pageStore} (which `onSite` code can't use). Values must be
     * JSON (at most 1 MB); functions in `initial` stay local to each copy.
     * `name` is its key (one store per name per script, apart from the
     * other two kinds'). Saving the script keeps its values. Network
     * handlers have no page: it throws there.
     *
     * @example
     * const flags = tt.siteStore("flags", { loggedIn: false, mock: false });
     * tt.onSite("https://example.com/*", () => {
     *     flags.loggedIn = !!document.cookie.match(/session=/);
     *     if (flags.mock) (window as any).__MOCK__ = true;
     * });
     * tt.onOverlay("https://example.com/*", () => {
     *     // a checkbox bound to flags.mock (useSnapshot(flags) from "valtio")
     * });
     */
    siteStore<T extends object>(name: string, initial: T): T;

    /**
     * `fetch` for scripts. By default it runs in the background with the
     * extension's host permissions (no CORS) and the browser's cookies.
     * `bypass: true` keeps every script's handlers — this one's too — off
     * the request, e.g. to get the real response a mock replaces.
     *
     * @example
     * const real = await (await tt.fetch("https://api.example.com/user", { bypass: true })).json();
     */
    fetch(input: string | URL | Request, init?: TangiTweak.FetchInit): Promise<Response>;

    /**
     * Log to the Editor's Log view for the current tab.
     *
     * @example
     * tt.log("request to", ctx.url, { method: ctx.method });
     */
    log(...args: unknown[]): void;

    /**
     * `true` in Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, Opera…).
     * Always the opposite of {@link isFirefox}.
     *
     * @example
     * tt.onResponseBody({ url: "*://example.com/app.js", strategy: tt.isFirefox ? "extension" : "helper" }, (ctx, body) => body.replace("DEBUG=false", "DEBUG=true"));
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
     * tt.onRequest({ url: "*://api.example.com/*", strategy: tt.isMV3 ? "debugger" : "extension" }, fn);
     */
    readonly isMV3: boolean;

    /**
     * `true` on macOS. At most one of `isMac`, {@link isWindows} and
     * {@link isLinux} is `true`; on Android and ChromeOS none is.
     *
     * @example
     * ctx.shortcut(tt.isMac ? "Meta+Shift+P" : "Ctrl+Shift+P", openPalette);
     */
    readonly isMac: boolean;

    /** `true` on Windows. See {@link isMac}. */
    readonly isWindows: boolean;

    /** `true` on desktop Linux (not Android or ChromeOS). See {@link isMac}. */
    readonly isLinux: boolean;
};

/*
 * Newer web platform APIs that the editor's bundled TypeScript doesn't know
 * yet. TangiTweak targets current browsers, so scripts may use them freely.
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
 * The same syntax as handler routes (`tt.onRequest({ url: pattern, strategy }, fn)`).
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

/**
 * A `.md` data file imports as its Markdown text, a string:
 * `import readme from "./README.md";`
 */
declare module "*.md" {
    const markdown: string;
    export default markdown;
}

/**
 * Image data files import as their `data:image/...;base64,...` URL:
 * `import icon from "./icon.png"; tt.metadata({ icon });`
 */
declare module "*.png" {
    const url: string;
    export default url;
}
declare module "*.jpg" {
    const url: string;
    export default url;
}
declare module "*.jpeg" {
    const url: string;
    export default url;
}
declare module "*.gif" {
    const url: string;
    export default url;
}
declare module "*.webp" {
    const url: string;
    export default url;
}
declare module "*.ico" {
    const url: string;
    export default url;
}
declare module "*.avif" {
    const url: string;
    export default url;
}
