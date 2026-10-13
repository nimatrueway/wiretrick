/**
 * Tier A — MAIN-world page hook. STATIC file: contains no eval and no user
 * code, so page CSP (however strict) cannot break it.
 *
 * It patches fetch/XHR and, per request, relays bodies through the
 * isolated-world bridge to the background, where user transforms run.
 * The background replies with the new body; the hook rebuilds the Response.
 */
(() => {
    const w = window as any;
    if (w.__resOverrideHooked) return;
    w.__resOverrideHooked = true;

    const BRIDGE_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    let active = false; // any body scripts exist (bundle metadata says so)
    let patched = false;
    let domHandlers: { scriptId: string; name: string; when: string; src: string }[] = [];
    let domFired = false;
    let reqSeq = 0;
    const pending = new Map<number, (v: any) => void>();

    function logUp(msg: string, level: "info" | "warn" | "error" = "info", src = "hook"): void {
        console.log(`[res:hook] ${msg}`);
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "log", msg, level, src }, window.location.origin);
        } catch {}
    }

    /** Round-trip through the bridge (→ background). */
    function viaBridge(msg: any): Promise<any> {
        return new Promise((resolve) => {
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
        if (data.kind === "callResult" && pending.has(data.reqId)) {
            const resolve = pending.get(data.reqId)!;
            pending.delete(data.reqId);
            resolve(data.result);
            return;
        }
        if (data.kind === "status") {
            const wasActive = active;
            active = !!data.active;
            domHandlers = data.domHandlers || [];
            logUp(`status: ${active ? "active" : "inactive"}, dom=${domHandlers.length}${data.hot ? " (hot)" : ""}`);
            if (active) install();
            else if (wasActive) {
                // all scripts went away — stop intercepting
                w.fetch = w.__resOrigFetch;
                w.XMLHttpRequest.prototype.open = w.__resOrigOpen;
                w.XMLHttpRequest.prototype.send = w.__resOrigSend;
                patched = false;
            }
            compileAndScheduleDom(!!data.hot);
        }
    });

    /**
     * onDom handlers compile in THIS world (MAIN) so the handler sees the
     * page's window (window.PARAMS etc.). The FULL script source is
     * compiled with a shim, so top-level helpers/closures survive. If the
     * page CSP forbids eval, report it — the bridge then runs the whole
     * script in the isolated world (shared DOM, no page window).
     */
    function compileAndScheduleDom(hot: boolean): void {
        if (domHandlers.length === 0) return;
        const compiledDom: { name: string; when: string; fn: (ctx: any) => any }[] = [];
        let cspBlocked = false;
        for (const d of domHandlers) {
            const store: any = { onDom: null, onDomOptions: {} };
            try {
                // shadow `console` inside the script so its console.* calls
                // are attributed to the script (and still reach the page)
                const fn = new Function("res", "console", `"use strict";\n${d.src}`);
                fn(makeDomShim(d.scriptId, d.name, store), makeScriptConsole(d.name));
                if (store.onDom) {
                    compiledDom.push({ name: d.name, when: store.onDomOptions.when || "DOMContentLoaded", fn: store.onDom });
                }
            } catch (e: any) {
                if (/Evaluating a string as JavaScript|unsafe-eval/i.test(e.message || "")) {
                    cspBlocked = true;
                } else {
                    logUp(`onDom compile failed: ${e.message || e}`, "error", d.name);
                }
            }
        }
        if (cspBlocked) {
            logUp("page CSP blocks MAIN-world compilation — onDom falls back to the isolated world", "warn");
            try {
                window.postMessage({ source: HOOK_SOURCE, kind: "cspBlocked" }, window.location.origin);
            } catch {}
        }
        if (compiledDom.length === 0) return;

        const fire = () => {
            const injected = (document.currentScript as HTMLScriptElement | null)
                ? "document.currentScript"
                : (document.querySelector("script[data-res-override-hook]") ? "script tag (already in DOM)" : "bundle message");
            for (const { name, when, fn } of compiledDom) {
                try {
                    logUp(`onDom → running (${when}) on ${location.href} [${document.readyState}] — hook injected via ${injected}`, "info", name);
                    fn(makeCtx(location.href, "GET"));
                } catch (e: any) {
                    logUp(`onDom threw: ${e.message || e}`, "error", name);
                }
            }
        };
        if (hot) {
            fire(); // hot update: refire immediately so edits are visible live
            return;
        }
        if (domFired) return; // initial + ready re-sends fire only once
        domFired = true;
        const when = compiledDom[0].when;
        if (when === "document_start") {
            fire();
        } else if (when === "document_idle") {
            if (document.readyState === "complete") fire();
            else window.addEventListener("load", fire, { once: true });
        } else {
            if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fire, { once: true });
            else fire();
        }
    }

    function requestStatus(): void {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "status?" }, window.location.origin);
        } catch {}
    }

    /** shim for compiled dom scripts: log → logUp (script-tagged), storage → bridge relay */
    function fmtArgs(args: any[]): string {
        return args.map((a) => {
            if (typeof a === "string") return a;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        }).join(" ");
    }

    /** console shadow for a dom script: forwards to the real page console
     * and mirrors each call into the script-attributed log stream. */
    function makeScriptConsole(name: string): any {
        const real = console;
        const shim: any = {};
        for (const method of ["log", "info", "warn", "error", "debug"]) {
            const level = method === "error" ? "error" : method === "warn" ? "warn" : "info";
            shim[method] = (...args: any[]) => {
                try {
                    (real as any)[method](...args);
                } catch {}
                logUp(`console.log: ${fmtArgs(args)}`, level, name);
            };
        }
        // uncommon methods pass straight through
        return new Proxy(shim, {
            get: (t, k) => (k in t ? t[k as any] : (real as any)[k]),
        });
    }

    function makeDomShim(scriptId: string, name: string, store: any): any {
        return {
            onRequest: (f: any) => {},
            onResponseHeaders: (f: any) => {},
            replaceResponse: (f: any) => {},
            modifyResponse: (f: any) => {},
            onDom: (f: any, opts?: any) => {
                store.onDom = f;
                store.onDomOptions = opts || {};
            },
            log: (...args: any[]) => logUp(`res.log: ${fmtArgs(args)}`, "info", name),
            storage: {
                get: (key: string) => viaBridge({ op: "storageGet", scriptId, key }),
                set: (key: string, value: any) => viaBridge({ op: "storageSet", scriptId, key, value }),
            },
        };
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
        logUp("patches installed");
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

            if (!active) return origFetch(input, init);

            claim(url);

            // page aborts are normal (React cleanup, timeouts, cascades) —
            // race them against our round-trips and propagate silently
            const signal: AbortSignal | undefined =
                (input instanceof Request && input.signal) || (init && init.signal) || undefined;
            const abortP = abortRace(signal);

            try {
                // 1. respond (onRequest terminal result) — no network at all
                const resp0 = abortP ? await Promise.race([viaBridge({ op: "respond", url, method }), abortP]) : await viaBridge({ op: "respond", url, method });
                if (resp0 && resp0.content !== null && resp0.content !== undefined) {
                    const hdrs = new Headers({ "content-type": resp0.mime || "text/plain" });
                    for (const [k, v] of Object.entries(resp0.headers || {})) hdrs.set(k, String(v));
                    return new Response(resp0.content, { status: resp0.status || 200, headers: hdrs });
                }

                // 2. replaceResponse? (background runs the handler)
                const repl = abortP ? await Promise.race([viaBridge({ op: "replace", url, method }), abortP]) : await viaBridge({ op: "replace", url, method });
                if (repl && repl.content !== null && repl.content !== undefined) {
                    return new Response(repl.content, { status: 200, headers: { "content-type": repl.mime || "text/plain" } });
                }

                // 2. real request (abort propagates natively)
                const response = await origFetch(input, init);

                // 3. transform? only for readable, non-null-body responses
                if (response.status === 204 || response.status === 304) return response;
                const contentType = response.headers.get("content-type") || "";
                const isText = /text\/|json|javascript|xml|x-www-form-urlencoded/i.test(contentType);
                if (!isText) {
                    // sniff when the content-type is missing
                    if (contentType !== "") return response;
                    const buf = new Uint8Array(await response.clone().arrayBuffer());
                    const n = Math.min(buf.length, 512);
                    for (let i = 0; i < n; i++) if (buf[i] === 0) return response;
                }

                const text = await response.clone().text();
                const out = abortP
                    ? await Promise.race([viaBridge({ op: "transform", url, method, body: text, status: response.status, contentType }), abortP])
                    : await viaBridge({ op: "transform", url, method, body: text, status: response.status, contentType });
                if (!out || typeof out.body !== "string" || out.body === text) return response;

                return new Response(out.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            } catch (e: any) {
                if (isAbort(e)) throw e; // normal — page owns the abort
                logUp(`fetch pipeline error: ${e.message || e}`, "error");
                // last resort: original unpatched fetch
                return origFetch(input, init);
            }
        };
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
                try {
                    const headers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(xhr.__resHeaders || {})) headers[k] = String(v);
                    const method = (xhr.__resMethod || "GET").toUpperCase();
                    const body = args[0] ?? null;

                    // 1. replace short-circuit
                    const repl = await viaBridge({ op: "replace", url: absUrl, method });
                    let status = 200;
                    let statusText = "OK";
                    let respHeaders = new Headers({ "content-type": repl?.mime || "text/plain" });
                    let text: string;

                    if (repl && repl.content !== null && repl.content !== undefined) {
                        text = String(repl.content);
                    } else {
                        // 2. real request via patched fetch (transform applies; abort wired)
                        const resp = await w.fetch(absUrl, { method, headers, body, signal: abortCtl.signal });
                        status = resp.status;
                        statusText = resp.statusText;
                        respHeaders = resp.headers;
                        text = await resp.text();
                        // 3. transform round-trip (raced against abort)
                        const out = await Promise.race([
                            viaBridge({ op: "transform", url: absUrl, method, body: text, status }),
                            new Promise<null>((_, rej) => abortCtl.signal.addEventListener("abort", () => rej(abortCtl.signal.reason || new DOMException("aborted", "AbortError")), { once: true })),
                        ]);
                        if (out && typeof out.body === "string" && out.body !== text) text = out.body;
                    }

                    Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true });
                    Object.defineProperty(xhr, "status", { get: () => status, configurable: true });
                    Object.defineProperty(xhr, "statusText", { get: () => statusText, configurable: true });
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
                    logUp(`xhr shim failed: ${e.message || e}`, "error");
                    // fall back to the native path
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

    // ---- page console capture (static — no eval) ----
    {
        const CAP = 2000;
        let captured = 0;
        const wrap = (method: string, level: "info" | "warn" | "error") => {
            const orig = (console as any)[method];
            (console as any)[method] = function (...args: any[]) {
                orig.apply(console, args);
                if (captured >= CAP) return;
                const first = String(args[0] ?? "");
                if (first.startsWith("[res:")) return; // our own chatter
                captured++;
                try {
                    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
                    window.postMessage(
                        { source: HOOK_SOURCE, kind: "log", msg: `page.console: ${msg.slice(0, 300)}`, level },
                        window.location.origin
                    );
                } catch {}
            };
        };
        wrap("log", "info");
        wrap("info", "info");
        wrap("warn", "warn");
        wrap("error", "error");
    }

    // debug seam: live hook state for e2e/diagnostics
    (w as any).__resHookState = () => ({ active, patched, domFired, domHandlers: domHandlers.length });
    (w as any).__resViaBridge = viaBridge;

    requestStatus();
})();
