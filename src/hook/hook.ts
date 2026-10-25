/**
 * Page strategy — MAIN-world page hook. STATIC file: contains no eval and no user
 * code, so page CSP (however strict) cannot break it.
 *
 * It patches fetch/XHR and, per request, relays bodies through the
 * isolated-world bridge to the background, where user transforms run.
 * The background replies with the new body; the hook rebuilds the Response.
 */
import { formatScriptError } from "../shared/scriptError";
import { makeScriptConsole, formatLogArgs, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";
import { makeLibRequire, type ShippedLib } from "../shared/scriptImports";
import { routeMatches, type DocumentWhen, type RouteMeta } from "../shared/route";
import { makePageShim, domHandlersFor, scheduleDocument } from "../shared/pageShim";
import { bodyKind, setTextTypes } from "../shared/bodyKind";

(() => {
    const w = window as any;
    // only the page's own world: as an isolated content script (a browser
    // that ignores the manifest's `world: "MAIN"`) the bridge injects us instead
    if (w.chrome?.runtime?.id || w.browser?.runtime?.id) return;
    if (w.__resOverrideHooked) return;
    w.__resOverrideHooked = true;

    const BRIDGE_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    let active = false; // any body scripts exist (bundle metadata says so)
    /** routes of hook-owned handlers — other requests stay native */
    let routes: RouteMeta[] = [];
    const wants = (url: string, method: string): boolean => {
        try {
            return routes.some((r) => routeMatches(r, url, method));
        } catch {
            return false;
        }
    };
    /** does an onResponseBody route with `binary: true` match? (binary bodies go only to those) */
    const wantsBinary = (url: string, method: string): boolean => {
        try {
            return routes.some((r) => r.kind === "onResponseBody" && r.binary && routeMatches(r, url, method));
        } catch {
            return false;
        }
    };
    let patched = false;
    /** the bridge reported the extension context dead (extension reload) */
    let dead = false;
    let domHandlers: { scriptId: string; name: string; src: string; params?: Record<string, any> }[] = [];
    let libSources: ShippedLib[] = [];
    let domFired = false;
    let reqSeq = 0;
    const pending = new Map<number, (v: any) => void>();

    /** hook diagnostics → extension debug log (never the page console) */
    function logUp(msg: string, level: ScriptLogLevel = "info"): void {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "log", msg, level, src: "page" }, window.location.origin);
        } catch {}
    }

    /** a user script's own output (wt.log / console.* / errors) → extension LOG, attributed to the script */
    function scriptLogUp(scriptId: string | null, level: ScriptLogLevel, msg: string): void {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "scriptLog", scriptId, level, msg }, window.location.origin);
        } catch {}
    }

    /** Round-trip through the bridge (→ background). */
    function viaBridge(msg: any): Promise<any> {
        return new Promise((resolve) => {
            if (dead) return resolve(null); // extension reloaded — pass through, no watchdog stall
            const reqId = ++reqSeq;
            pending.set(reqId, resolve);
            try {
                window.postMessage({ source: HOOK_SOURCE, kind: "call", reqId, ...msg }, window.location.origin);
            } catch {
                pending.delete(reqId);
                resolve(null);
            }
            // watchdog: never hang the page's fetch
            setTimeout(() => {
                if (pending.has(reqId)) {
                    pending.delete(reqId);
                    resolve(null);
                }
            }, 15000);
        });
    }

    window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE) return;
        if (data.kind === "extensionDead") {
            // the extension was reloaded — restore the page's own fetch/XHR
            // and stop intercepting (the stale content script can't relay)
            goDormant();
            return;
        }
        if (data.kind === "callResult" && pending.has(data.reqId)) {
            const resolve = pending.get(data.reqId)!;
            pending.delete(data.reqId);
            resolve(data.result);
            return;
        }
        if (data.kind === "status") {
            const wasActive = active;
            active = !!data.active;
            routes = data.routes || [];
            setTextTypes(data.textTypes);
            domHandlers = data.domHandlers || [];
            libSources = data.libs || [];
            logUp(`status: ${active ? "active" : "inactive"}, dom=${domHandlers.length}${data.hot ? " (hot)" : ""}`, "debug");
            if (active) install();
            else if (wasActive) goDormant();
            compileAndScheduleDocument(!!data.hot);
        }
    });

    /** Stop intercepting: restore the page's own fetch/XHR, drop state. */
    function goDormant(): void {
        dead = true;
        // in-flight relays resolve immediately — no 15s watchdog stalls
        for (const [, resolve] of pending) resolve(null);
        pending.clear();
        if (!active && !patched) return;
        active = false;
        routes = [];
        domHandlers = [];
        libSources = [];
        if (patched) {
            w.fetch = w.__resOrigFetch;
            w.XMLHttpRequest.prototype.open = w.__resOrigOpen;
            w.XMLHttpRequest.prototype.send = w.__resOrigSend;
            patched = false;
        }
        logUp("extension reloaded — hook dormant until the next page load");
    }

    /**
     * onDocument handlers compile in THIS world (MAIN) so the handler sees the
     * page's window (window.PARAMS etc.). The FULL script source is
     * compiled with a shim, so top-level helpers/closures survive. If the
     * page CSP forbids eval, report it — the bridge then runs the whole
     * script in the isolated world (shared DOM, no page window).
     */
    function compileAndScheduleDocument(hot: boolean): void {
        if (domHandlers.length === 0) return;
        // module registry over the shipped library sources and data files:
        // the page-side `require` backing ES imports ("./utils" → the script
        // named utils, "./a.json" → the data file)
        const requireFrom = makeLibRequire(libSources, (lib, require, moduleObj) =>
            scriptFunction(lib.src!)(makeDocumentShim(null, lib.name, lib.params || {}).wt, scriptConsole(null, lib.name), require, moduleObj, moduleObj.exports)
        );
        const compiledDocument: { scriptId: string; name: string; when: DocumentWhen; fn: (ctx: any) => any }[] = [];
        let cspBlocked = false;
        for (const d of domHandlers) {
            try {
                // shadow `console` inside the script so its console.* calls
                // land in the extension LOG (not the page console);
                // require resolves the shipped libs
                const fn = scriptFunction(d.src);
                const moduleObj = { exports: {} as any };
                const { wt, dom } = makeDocumentShim(d.scriptId, d.name, d.params || {});
                fn(wt, scriptConsole(d.scriptId, d.name), requireFrom(d.name), moduleObj, moduleObj.exports);
                for (const h of domHandlersFor(dom, location.href)) compiledDocument.push({ scriptId: d.scriptId, name: d.name, when: h.when, fn: h.fn });
            } catch (e: any) {
                if (/Evaluating a string as JavaScript|unsafe-eval/i.test(e.message || "")) {
                    cspBlocked = true;
                } else {
                    scriptLogUp(d.scriptId, "error", formatScriptError(d.name, e, "onDocument compile"));
                }
            }
        }
        if (cspBlocked) {
            logUp("page CSP blocks eval in the page world — running onDocument handlers in the isolated world instead", "info");
            try {
                window.postMessage({ source: HOOK_SOURCE, kind: "cspBlocked" }, window.location.origin);
            } catch {}
        }
        if (compiledDocument.length === 0) return;

        const injected = (document.currentScript as HTMLScriptElement | null)
            ? "document.currentScript"
            : (document.querySelector("script[data-res-override-hook]") ? "script tag (already in DOM)" : "bundle message");
        const fire = ({ scriptId, name, when, fn }: (typeof compiledDocument)[number]) => {
            try {
                scriptLogUp(scriptId, "debug", scriptLogLine(name, "onDocument", `running (${when}) on ${location.href} [${document.readyState}], hook injected via ${injected}`));
                fn(makeCtx(location.href, "GET"));
            } catch (e: any) {
                scriptLogUp(scriptId, "error", formatScriptError(name, e, "onDocument"));
            }
        };
        if (hot) {
            compiledDocument.forEach(fire); // hot update: refire immediately so edits are visible live
            return;
        }
        if (domFired) return; // initial + ready re-sends fire only once
        domFired = true;
        // each handler keeps its own { when } (same as the isolated-world fallback)
        for (const h of compiledDocument) scheduleDocument(h.when, () => fire(h));
    }

    function requestStatus(): void {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "status?" }, window.location.origin);
        } catch {}
    }

    /** console shadow for a dom script: routed to the extension LOG, silent on the page */
    function scriptConsole(scriptId: string | null, name: string): Console {
        return makeScriptConsole((level, source, text) => scriptLogUp(scriptId, level, scriptLogLine(name, source, text)));
    }

    /** shim for compiled dom scripts: log → extension LOG (script-tagged), storage → bridge relay */
    function makeDocumentShim(scriptId: string | null, name: string, params: Record<string, any>) {
        return makePageShim({
            params,
            log: (...args: any[]) => scriptLogUp(scriptId, "info", scriptLogLine(name, "wt.log", formatLogArgs(args))),
            storage: {
                get: (key: string) => viaBridge({ op: "storageGet", scriptId, key }),
                set: (key: string, value: any) => viaBridge({ op: "storageSet", scriptId, key, value }),
            },
        });
    }

    function claim(url: string): void {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "claim", url }, window.location.origin);
        } catch {}
    }

    function install(): void {
        if (patched) return;
        patched = true;
        patchFetch();
        patchXHR();
        logUp("fetch/XHR patches installed", "debug");
    }

    function makeCtx(url: string, method: string, extra?: any): any {
        return { url, method, tabUrl: location.href, resourceType: "xmlhttprequest", requestHeaders: {}, ...extra };
    }

    // ---- abort semantics ----
    function isAbort(e: any): boolean {
        return e && (e.name === "AbortError" || (typeof DOMException !== "undefined" && e instanceof DOMException && e.code === 17));
    }

    function abortError(signal: AbortSignal): Error {
        return (signal as any).reason instanceof Error
            ? (signal as any).reason
            : new DOMException("The operation was aborted.", "AbortError");
    }

    /** Rejects when the page's signal aborts; null when there's no signal. */
    function abortRace(signal: AbortSignal | undefined | null): Promise<never> | null {
        if (!signal) return null;
        if (signal.aborted) throw abortError(signal);
        return new Promise<never>((_, rej) => {
            signal.addEventListener("abort", () => rej(abortError(signal)), { once: true });
        });
    }

    // ---- fetch patch ----
    /** Wraps a passthrough fetch failure so it propagates natively (no log). */
    class PassthroughError {
        constructor(public cause: any) {}
    }

    /** a constructed Response has url "" — report the request's, like a real one */
    function withUrl(resp: Response, url: string): Response {
        try {
            Object.defineProperty(resp, "url", { value: url, configurable: true });
        } catch {
            /* non-configurable: keep "" */
        }
        return resp;
    }

    function patchFetch(): void {
        w.__resOrigFetch = w.fetch;
        const origFetch = w.fetch.bind(window);

        window.fetch = async function (input: any, init?: RequestInit): Promise<Response> {
            const rawUrl =
                typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
            const method =
                (init && init.method) ||
                (typeof input === "object" && input && input.method) ||
                "GET";

            let url: string;
            try {
                url = new URL(rawUrl, location.href).href;
            } catch {
                url = rawUrl;
            }

            if (!active || !wants(url, method)) return origFetch(input, init);

            claim(url);

            // page aborts are normal (React cleanup, timeouts, cascades) —
            // race them against our round-trips and propagate silently
            const signal: AbortSignal | undefined =
                (input instanceof Request && input.signal) || (init && init.signal) || undefined;
            const abortP = abortRace(signal);

            try {
                // 1. onRequest: replaceResponse (no network), block, redirect or header edits
                const dec = abortP ? await Promise.race([viaBridge({ op: "respond", url, method }), abortP]) : await viaBridge({ op: "respond", url, method });
                if (dec && dec.content !== null && dec.content !== undefined) {
                    const hdrs = new Headers({ "content-type": dec.mime || "text/plain" });
                    for (const [k, v] of Object.entries(dec.headers || {})) hdrs.set(k, String(v));
                    return withUrl(new Response(dec.content, { status: dec.status || 200, headers: hdrs }), url);
                }
                // a blocked request fails like a network error (as the browser's own block does)
                if (dec?.kind === "cancel") throw new PassthroughError(new TypeError("Failed to fetch"));
                if (dec?.kind === "redirect" && typeof dec.url === "string") {
                    const hops: number = (init as any)?.__wtHops ?? 0;
                    if (hops >= 20) throw new PassthroughError(new TypeError("Failed to fetch"));
                    // the target goes through the hook again (its own handlers run)
                    const next = input instanceof Request ? new Request(dec.url, input) : dec.url;
                    return w.fetch(next, { ...(init || {}), __wtHops: hops + 1 });
                }
                if (dec?.kind === "headers" && dec.changes) {
                    const hdrs = new Headers(input instanceof Request ? input.headers : undefined);
                    if (init?.headers) new Headers(init.headers).forEach((v, k) => hdrs.set(k, v));
                    for (const n of dec.changes.remove || []) hdrs.delete(n);
                    for (const [k, v] of Object.entries(dec.changes.set || {})) hdrs.set(k, String(v));
                    init = { ...(init || {}), headers: hdrs };
                }

                // 2. replaceResponse? (background runs the handler)
                const repl = abortP ? await Promise.race([viaBridge({ op: "replace", url, method }), abortP]) : await viaBridge({ op: "replace", url, method });
                if (repl && repl.content !== null && repl.content !== undefined) {
                    return withUrl(new Response(repl.content, { status: 200, headers: { "content-type": repl.mime || "text/plain" } }), url);
                }

                // 3. real request (abort propagates natively). A failure here
                // is the PAGE's own request failing (network, or an invalid
                // call the unpatched fetch would reject identically) —
                // propagate natively, don't log as our pipeline error
                let response: Response;
                try {
                    response = await origFetch(input, init);
                } catch (e: any) {
                    if (isAbort(e)) throw e;
                    throw new PassthroughError(e);
                }

                // 4. transform? only for readable, non-null-body responses
                if (response.status === 204 || response.status === 304) return response;
                // text → string; binary → bytes, only when a `binary: true` route wants them
                const contentType = response.headers.get("content-type") || "";
                const binaryOk = wantsBinary(url, method);
                let kind = bodyKind(contentType, null);
                if (kind === "binary" && !binaryOk) return skipBinary(response, url, method, contentType);
                let bodyIn: string | Uint8Array;
                if (kind === "text") bodyIn = await response.clone().text();
                else {
                    // binary, or no content-type: sniff the bytes
                    const buf = new Uint8Array(await response.clone().arrayBuffer());
                    kind = bodyKind(contentType, buf);
                    if (kind === "binary" && !binaryOk) return skipBinary(response, url, method, contentType);
                    bodyIn = kind === "binary" ? buf : new TextDecoder().decode(buf);
                }

                const out = abortP
                    ? await Promise.race([viaBridge({ op: "transform", url, method, body: bodyIn, status: response.status, contentType }), abortP])
                    : await viaBridge({ op: "transform", url, method, body: bodyIn, status: response.status, contentType });
                if (!out || !(typeof out.body === "string" || out.body instanceof Uint8Array) || sameBody(out.body, bodyIn)) return response;

                return withUrl(new Response(out.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                }), response.url || url);
            } catch (e: any) {
                if (isAbort(e)) throw e; // normal — page owns the abort
                if (e instanceof PassthroughError) throw e.cause; // page's own failure — native behavior, no log
                logUp(`fetch pipeline error: ${e.message || e}`, "error");
                // last resort: original unpatched fetch
                return origFetch(input, init);
            }
        };
    }

    /** a binary body no route takes: pass it through, and say why (the "never ran" warning) */
    function skipBinary(response: Response, url: string, method: string, contentType: string): Response {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "bodySkip", url, method, why: "binary", contentType }, window.location.origin);
        } catch {}
        return response;
    }

    function sameBody(a: string | Uint8Array, b: string | Uint8Array): boolean {
        if (typeof a === "string" || typeof b === "string") return a === b;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    // ---- XHR patch ----
    function patchXHR(): void {
        const OrigOpen = XMLHttpRequest.prototype.open;
        const OrigSend = XMLHttpRequest.prototype.send;
        w.__resOrigOpen = OrigOpen;
        w.__resOrigSend = OrigSend;

        (window.XMLHttpRequest.prototype as any).open = function (...args: any[]) {
            this.__resUrl = args[1];
            this.__resMethod = args[0] || "GET";
            this.__resSync = args[2] === false;
            this.__resHeaders = {};
            return OrigOpen.apply(this, args as any);
        };
        const OrigSetReqHeader = XMLHttpRequest.prototype.setRequestHeader;
        (window.XMLHttpRequest.prototype as any).setRequestHeader = function (k: string, v: string) {
            (this.__resHeaders ||= {})[k] = v;
            return OrigSetReqHeader.call(this, k, v);
        };

        (window.XMLHttpRequest.prototype as any).send = function (...args: any[]) {
            const xhr = this as any;
            if (!active || !xhr.__resUrl) {
                return OrigSend.apply(this, args as any);
            }
            // only text-shaped XHRs are shim-able; async only (sync XHRs
            // cannot await the transform round-trip)
            if (xhr.responseType !== "" && xhr.responseType !== "text") {
                return OrigSend.apply(this, args as any);
            }
            if (xhr.__resSync === true) {
                return OrigSend.apply(this, args as any);
            }

            let absUrl: string;
            try {
                absUrl = new URL(xhr.__resUrl, location.href).href;
            } catch {
                absUrl = xhr.__resUrl;
            }
            if (!wants(absUrl, xhr.__resMethod || "GET")) return OrigSend.apply(this, args as any);
            claim(absUrl);

            // BECOME the transport: fetch (patched → replace/transform
            // applies), then populate the xhr and dispatch the events
            // ourselves — onload/addEventListener consumers see the result
            const abortCtl = new AbortController();
            const origAbort = xhr.abort;
            xhr.abort = function () {
                abortCtl.abort(new DOMException("The operation was aborted.", "AbortError"));
                try {
                    if (typeof origAbort === "function") origAbort.call(xhr);
                } catch {}
                xhr.dispatchEvent(new ProgressEvent("abort"));
                xhr.dispatchEvent(new ProgressEvent("loadend"));
            };
            void (async () => {
                let wentOut = false; // the shim's fetch reached the network?
                let netFailed = false; // the page's own request failed (offline, CORS, blocked)
                try {
                    const headers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(xhr.__resHeaders || {})) headers[k] = String(v);
                    const method = (xhr.__resMethod || "GET").toUpperCase();
                    const body = args[0] ?? null;
                    // Chrome's fetch rejects GET/HEAD with a body (the page's
                    // send(body) on a GET would throw natively too) — drop it
                    const safeBody = method === "GET" || method === "HEAD" ? null : body;

                    // the patched fetch runs onRequest → replaceResponse → network → onResponseBody,
                    // exactly as for the page's own fetch (abort wired)
                    let resp: Response;
                    try {
                        resp = await w.fetch(absUrl, { method, headers, body: safeBody, signal: abortCtl.signal, credentials: xhr.withCredentials ? "include" : "same-origin" });
                    } catch (e) {
                        wentOut = true;
                        if (!isAbort(e)) netFailed = true;
                        throw e;
                    }
                    wentOut = true;
                    const status = resp.status;
                    const statusText = resp.statusText;
                    const respHeaders = resp.headers;
                    const text = await resp.text();

                    Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true });
                    Object.defineProperty(xhr, "status", { get: () => status, configurable: true });
                    Object.defineProperty(xhr, "statusText", { get: () => statusText, configurable: true });
                    Object.defineProperty(xhr, "responseURL", { get: () => resp.url || absUrl, configurable: true });
                    redefineBody(xhr, text);
                    const headerLines = [...respHeaders.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n");
                    Object.defineProperty(xhr, "getAllResponseHeaders", {
                        value: () => headerLines,
                        configurable: true,
                    });

                    if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange({ target: xhr } as any);
                    xhr.dispatchEvent(new Event("readystatechange"));
                    if (typeof xhr.onload === "function") xhr.onload({ target: xhr } as any);
                    xhr.dispatchEvent(new ProgressEvent("load"));
                    xhr.dispatchEvent(new ProgressEvent("loadend"));
                } catch (e: any) {
                    if (isAbort(e)) return; // abort events already dispatched
                    // a failed request is the page's business (a native XHR
                    // would fail the same way) — only our own bugs are errors
                    logUp(netFailed ? `xhr ${absUrl} failed: ${e.message || e}` : `xhr shim failed: ${e.message || e}`, netFailed ? "debug" : "error");
                    if (wentOut) {
                        // the request already went out — surfacing as a native
                        // XHR error (status 0); a fallback OrigSend would
                        // RESUBMIT it (double side effects on POSTs)
                        Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true });
                        Object.defineProperty(xhr, "status", { get: () => 0, configurable: true });
                        Object.defineProperty(xhr, "statusText", { get: () => "", configurable: true });
                        redefineBody(xhr, "");
                        Object.defineProperty(xhr, "getAllResponseHeaders", { value: () => "", configurable: true });
                        if (typeof xhr.onerror === "function") xhr.onerror({ target: xhr } as any);
                        xhr.dispatchEvent(new ProgressEvent("error"));
                        xhr.dispatchEvent(new ProgressEvent("loadend"));
                        return;
                    }
                    // failed before the shim's fetch was called — the
                    // native path never ran; use it
                    OrigSend.apply(xhr, args as any);
                }
            })();
        };
    }

    function redefineBody(xhr: any, newText: string): void {
        try {
            Object.defineProperty(xhr, "responseText", { get: () => newText, configurable: true });
            if (xhr.responseType === "" || xhr.responseType === "text") {
                Object.defineProperty(xhr, "response", { get: () => newText, configurable: true });
            }
        } catch {}
    }

    // debug seam: live hook state for e2e/diagnostics
    (w as any).__resHookState = () => ({ active, patched, domFired, domHandlers: domHandlers.length });
    (w as any).__resViaBridge = viaBridge;

    requestStatus();
})();
