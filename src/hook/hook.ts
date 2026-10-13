/**
 * Tier A — MAIN-world page hook. Runs at document_start, before any page JS.
 * Receives the script bundle from the isolated-world bridge (window message),
 * compiles the full sources locally (so handlers keep their `res` binding and
 * top-level scope), and overrides fetch/XHR to stream page-initiated bodies
 * through user transforms. Banner-free.
 *
 * Built as a standalone IIFE (no imports in output).
 */
import { compileScript, isThenable, type CompiledScript, type HandlerFn } from "../shared/compile";
import { dlogLevel } from "../shared/debugLog";

(() => {
    const w = window as any;
    if (w.__resOverrideHooked) return;
    w.__resOverrideHooked = true;

    const BRIDGE_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8");

    interface BundledScript {
        scriptId: string;
        name: string;
        match: string[];
        code: string;
    }

    let compiled: { scriptId: string; name: string; match: string[]; script: CompiledScript }[] = [];

    /** star-pattern → regex (same greedy semantics as the engine matcher) */
    function patternToRegex(pattern: string): RegExp {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
        return new RegExp("^" + escaped + "$");
    }

    function urlMatches(patterns: string[], url: string): boolean {
        if (!patterns || patterns.length === 0) return true;
        return patterns.some((p) => {
            try {
                return patternToRegex(p).test(url);
            } catch {
                return false;
            }
        });
    }

    function claim(url: string): void {
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "claim", url }, window.location.origin);
        } catch {}
    }

    /** forward log entries to the background through the bridge */
    function logUp(msg: string, level: "info" | "warn" | "error" = "info"): void {
        dlogLevel("hook", "debug", msg);
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "log", msg, level }, window.location.origin);
        } catch {}
    }

    // ---- capture the page console into the manager LOG panel ----
    // skip our own [res:*] entries (already forwarded via logUp/dlog)
    const CONSOLE_CAP = 2000;
    let consoleCaptured = 0;
    const origConsole: Record<string, (...args: any[]) => void> = {};
    function wrapConsole(level: "info" | "warn" | "error", method: string): void {
        const orig = (console as any)[method];
        origConsole[method] = orig;
        (console as any)[method] = function (...args: any[]) {
            orig.apply(console, args);
            if (consoleCaptured >= CONSOLE_CAP) return;
            const first = String(args[0] ?? "");
            if (first.startsWith("[res:")) return; // ours — already relayed
            consoleCaptured++;
            try {
                const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
                window.postMessage({ source: HOOK_SOURCE, kind: "log", msg: `page.console: ${msg.slice(0, 300)}`, level }, window.location.origin);
            } catch {}
        };
    }

    /** once-per-page flags so re-sent bundles don't double-patch */
    let patchesInstalled = false;
    let domFired = false;

    function acceptBundle(bundle: any, hot = false): void {
        const scripts: BundledScript[] = bundle && bundle.scripts;
        logUp(`bundle: ${scripts ? scripts.length : 0} script(s)${hot ? " (hot update)" : ""}`);
        if (!scripts || scripts.length === 0) {
            // empty bundle (all scripts disabled/deleted) must CLEAR stale
            // handlers so effects stop on the open tab too
            if (hot) {
                compiled = [];
                domFired = true;
            }
            return;
        }
        compiled = scripts.map((s) => {
            // no consoleSink here: the page-console capture forwards script
            // console calls ("page.console: …"); a forwarding console would
            // double-report them
            const script = compileScript(s.code, {
                log: (...args: any[]) => logUp(`res.log: ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`),
            });
            if (script.error) logUp(`compile error in ${s.name}: ${script.error.split("\n")[0]}`);
            return { scriptId: s.scriptId, name: s.name, match: s.match, script };
        });
        logUp("compiled: " + compiled.map((c) => `${c.name}[mod=${!!c.script.handlers.modifyResponse} dom=${!!c.script.handlers.onDom}]`).join(" "));
        if (!patchesInstalled) {
            patchFetch();
            patchXHR();
            patchesInstalled = true;
        }
        // hot updates re-fire onDom so DOM/title changes are visible
        // without reloading the tab (initial + ready re-send fire once)
        const shouldFireDom = hot || !domFired;
        if (shouldFireDom) {
            domFired = true;
            runDomHandlers();
        }
        logUp(`patches installed (${compiled.filter((c) => c.script.handlers.modifyResponse).length} modify, ${compiled.filter((c) => c.script.handlers.replaceResponse).length} replace)`);

        // page console → manager panel (installed after the first bundle;
        // wrap only once)
        if (!(w as any).__resConsoleWrapped) {
            (w as any).__resConsoleWrapped = true;
            wrapConsole("info", "log");
            wrapConsole("info", "info");
            wrapConsole("warn", "warn");
            wrapConsole("error", "error");
        }
    }

    window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE || data.kind !== "bundle") return;
        acceptBundle(data.bundle, !!data.hot);
    });

    // the bridge may have posted the bundle before this script tag finished
    // loading — announce readiness so it re-sends
    try {
        window.postMessage({ source: HOOK_SOURCE, kind: "ready" }, window.location.origin);
    } catch {}

    function makeCtx(url: string, method: string, extra?: any): any {
        return {
            url,
            method,
            tabUrl: location.href,
            resourceType: "xmlhttprequest",
            requestHeaders: {},
            ...extra,
        };
    }

    function transformsFor(url: string): { scriptId: string; name: string; fn: (ctx: any, body: any) => any }[] {
        return compiled
            .filter((c) => c.script.handlers.modifyResponse && urlMatches(c.match, url))
            .map((c) => ({
                scriptId: c.scriptId,
                name: c.name,
                fn: c.script.handlers.modifyResponse as any,
            }));
    }

    function replaceHandlersFor(url: string): { name: string; fn: (ctx: any) => any }[] {
        return compiled
            .filter((c) => c.script.handlers.replaceResponse && urlMatches(c.match, url))
            .map((c) => ({ name: c.name, fn: c.script.handlers.replaceResponse as any }));
    }

    function makeReplaceCtx(url: string, method: string, contentType?: string): any {
        return { url, method, tabUrl: location.href, resourceType: "xmlhttprequest", requestHeaders: {}, mime: contentType };
    }

    function guessHookMime(url: string, fallback = "application/json"): string {
        const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
        const table: any = { js: "application/javascript", json: "application/json", css: "text/css", html: "text/html", xml: "application/xml", txt: "text/plain" };
        return table[ext] || fallback;
    }

    /**
     * replaceResponse short-circuit for page-initiated requests: Chrome
     * forbids redirects to data: URLs on fetch/XHR, so the hook serves the
     * replacement itself. Sync handlers only.
     */
    function applyReplaceSync(url: string, method: string): { mime: string; content: string | Uint8Array } | null {
        for (const { name, fn } of replaceHandlersFor(url)) {
            try {
                const out = fn(makeReplaceCtx(url, method));
                if (isThenable(out)) continue; // async handler — handled by the async path
                if (out !== undefined && out !== null) {
                    const content = out && typeof out === "object" && out.file ? out.file : out;
                    const mime = guessHookMime(url);
                    return { mime, content: content as string | Uint8Array };
                }
            } catch (e: any) {
                console.error(`[ResOverride hook] ${name} replaceResponse threw:`, e.message || e);
            }
        }
        return null;
    }

    /** Apply transforms synchronously when every handler is sync; null if async. */
    function applyTransformsSync(
        url: string,
        method: string,
        body: string | Uint8Array,
        extra?: any
    ): { body: string | Uint8Array } | null {
        let out = body;
        for (const t of transformsFor(url)) {
            try {
                const result = t.fn(makeCtx(url, method, extra), out);
                if (result && typeof result.then === "function") return null; // async handler
                if (result !== undefined && result !== null) out = result;
            } catch (e: any) {
                console.error(`[ResOverride hook] ${t.name} transform threw:`, e.message || e);
            }
        }
        return { body: out };
    }

    async function applyTransforms(
        url: string,
        method: string,
        body: string | Uint8Array,
        extra?: any
    ): Promise<string | Uint8Array> {
        let out = body;
        for (const t of transformsFor(url)) {
            try {
                const result = await t.fn(makeCtx(url, method, extra), out);
                if (result !== undefined && result !== null) out = result;
                dlogLevel("hook", "debug", `transform ${t.name} applied →`, typeof out === "string" ? out.slice(0, 80) : "bytes");
            } catch (e: any) {
                logUp(`transform ${t.name} threw: ${e.message || e}`);
            }
        }
        return out;
    }

        /**
     * onDom: user DOM/title manipulation.
     * Options: { when: "DOMContentLoaded" | "document_start" | "document_end" | "document_idle" }
     */
    function runDomHandlers(): void {
        const fire = () => {
            const domScripts = compiled.filter((c) => c.script.handlers.onDom && urlMatches(c.match, location.href));
            logUp(`onDom firing (${domScripts.length} handler(s), readyState=${document.readyState})`);
            for (const c of domScripts) {
                const handler = c.script.handlers.onDom;
                if (!handler) continue;
                const when = c.script.handlers.onDomOptions?.when || "DOMContentLoaded";
                if (when !== "document_start") {
                    scheduleDomHandler(handler, when, c.name);
                    continue;
                }
                try {
                    handler(makeCtx(location.href, "GET"));
                } catch (e: any) {
                    logUp(`onDom ${c.name} threw: ${e.message || e}`, "error");
                }
            }
        };
        fire();
    }

    function scheduleDomHandler(handler: HandlerFn, when: string, name: string): void {
        const run = () => {
            try {
                handler(makeCtx(location.href, "GET"));
            } catch (e: any) {
                logUp(`onDom ${name} threw: ${e.message || e}`, "error");
            }
        };
        if (when === "document_idle") {
            if (document.readyState === "complete") run();
            else window.addEventListener("load", run, { once: true });
            return;
        }
        // "document_end" and "DOMContentLoaded" both = DOM parsed
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", run, { once: true });
        } else {
            run();
        }
    }

    /** Async replaceResponse: awaits each matching handler's result. */
    async function applyReplaceAsync(url: string, method: string): Promise<{ mime: string; content: string | Uint8Array } | null> {
        for (const { name, fn } of replaceHandlersFor(url)) {
            try {
                const out = await fn(makeReplaceCtx(url, method));
                if (out !== undefined && out !== null) {
                    const content = out && typeof out === "object" && (out as any).file ? (out as any).file : out;
                    const mime = guessHookMime(url);
                    return { mime, content: content as string | Uint8Array };
                }
            } catch (e: any) {
                logUp(`replaceResponse ${name} threw: ${e.message || e}`, "error");
            }
        }
        return null;
    }

    // ---- fetch patch ----
    const origFetch = window.fetch.bind(window);

    function patchFetch(): void {
        window.fetch = async function (input: any, init?: RequestInit): Promise<Response> {
            const rawUrl =
                typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
            const method =
                (init && init.method) ||
                (typeof input === "object" && input && input.method) ||
                "GET";

            // patterns are absolute; page code often fetches relative urls
            let url: string;
            try {
                url = new URL(rawUrl, location.href).href;
            } catch {
                url = rawUrl;
            }

            dlogLevel("hook", "debug", "fetch", { url, method });
            claim(url);

            const replacement = applyReplaceSync(url, method);
            if (replacement) {
                return new Response(replacement.content as any, {
                    status: 200,
                    headers: { "content-type": replacement.mime },
                });
            }

            // async replaceResponse handlers: awaited (the page's fetch call
            // simply takes as long as the handler needs)
            const asyncReplacement = await applyReplaceAsync(url, method);
            if (asyncReplacement) {
                return new Response(asyncReplacement.content as any, {
                    status: 200,
                    headers: { "content-type": asyncReplacement.mime },
                });
            }

            const response = await origFetch(input, init);

            if (compiled.length === 0) return response;

            const transforms = transformsFor(url);
            if (transforms.length === 0) return response;

            try {
                const contentType = response.headers.get("content-type") || "";
                const isText = isTextual(contentType) || (await looksTextual(response));
                let original: string | Uint8Array;
                if (isText) {
                    original = await response.clone().text();
                } else {
                    original = new Uint8Array(await response.clone().arrayBuffer());
                }
                const transformed = await applyTransforms(url, method, original, { contentType, status: response.status });
                // nothing changed (or null-body status): pass the original
                // response through — new Response(204) throws
                if (transformed === original || response.status === 204 || response.status === 304) {
                    return response;
                }
                const out = typeof transformed === "string" ? transformed : (transformed instanceof Uint8Array ? transformed : enc.encode(String(transformed)));
                return new Response(out as any, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            } catch (e: any) {
                logUp(`fetch transform failed: ${e.message || e}`, "error");
                return response;
            }
        };
    }

    // ---- XHR patch ----
    const OrigXHR = window.XMLHttpRequest;
    const XHROpen = OrigXHR.prototype.open;
    const XHRSend = OrigXHR.prototype.send;

    function patchXHR(): void {
        (window.XMLHttpRequest.prototype as any).open = function (...args: any[]) {
            this.__resUrl = args[1];
            this.__resMethod = args[0] || "GET";
            return XHROpen.apply(this, args as any);
        };

        (window.XMLHttpRequest.prototype as any).send = function (...args: any[]) {
            const xhr = this as any;
            if (compiled.length === 0 || !xhr.__resUrl) {
                return XHRSend.apply(this, args as any);
            }

            let absUrl: string;
            try {
                absUrl = new URL(xhr.__resUrl, location.href).href;
            } catch {
                absUrl = xhr.__resUrl;
            }
            claim(absUrl);

            const origOnRsc = xhr.onreadystatechange;
            xhr.onreadystatechange = function (ev: any) {
                if (xhr.readyState !== 4 || compiled.length === 0) {
                    if (origOnRsc) origOnRsc.call(xhr, ev);
                    return;
                }
                try {
                    // replaceResponse takes precedence over transform
                    const replacement = applyReplaceSync(absUrl, xhr.__resMethod);
                    if (replacement) {
                        redefineResponseText(xhr, typeof replacement.content === "string" ? replacement.content : dec.decode(replacement.content as Uint8Array));
                        if (origOnRsc) origOnRsc.call(xhr, ev);
                        return;
                    }
                    // async replaceResponse handlers: await, redefine, then
                    // release the original handler (same semantics as async
                    // transforms — `load` listeners may see the original)
                    const pendingAsyncReplace = replaceHandlersFor(absUrl).length
                        ? applyReplaceAsync(absUrl, xhr.__resMethod)
                        : null;
                    const raw = xhr.response;
                    // only string bodies are safely rewritable
                    if (typeof raw !== "string" && raw !== null && raw !== "") {
                        if (origOnRsc) origOnRsc.call(xhr, ev);
                        return;
                    }
                    const contentType = xhr.getResponseHeader("content-type") || "";
                    const sync = applyTransformsSync(absUrl, xhr.__resMethod, typeof raw === "string" ? raw : "", {
                        contentType,
                        status: xhr.status,
                    });
                    if (sync) {
                        // synchronous path: redefine before returning so the
                        // subsequent `load` event sees the transformed body
                        redefineResponseText(xhr, typeof sync.body === "string" ? sync.body : dec.decode(sync.body as Uint8Array));
                        if (origOnRsc) origOnRsc.call(xhr, ev);
                        return;
                    }
                    // async handlers: onreadystatechange-property consumers get
                    // the transformed/replaced body; `load`/addEventListener
                    // consumers may see the original (documented limitation)
                    console.warn("[ResOverride hook] async handler on XHR: load listeners may see the original body");
                    void (async () => {
                        const asyncRepl = await pendingAsyncReplace;
                        if (asyncRepl) {
                            redefineResponseText(xhr, typeof asyncRepl.content === "string" ? asyncRepl.content : dec.decode(asyncRepl.content as Uint8Array));
                            if (origOnRsc) origOnRsc.call(xhr, ev);
                            return;
                        }
                        const transformed = await applyTransforms(absUrl, xhr.__resMethod, typeof raw === "string" ? raw : "", {
                            contentType,
                            status: xhr.status,
                        });
                        redefineResponseText(xhr, typeof transformed === "string" ? transformed : dec.decode(transformed as Uint8Array));
                        if (origOnRsc) origOnRsc.call(xhr, ev);
                    })();
                    return;
                } catch (e: any) {
                    console.error("[ResOverride hook] XHR transform failed:", e.message || e);
                    if (origOnRsc) origOnRsc.call(xhr, ev);
                }
            };

            return XHRSend.apply(this, args as any);
        };
    }

    function redefineResponseText(xhr: any, newText: string): void {
        try {
            Object.defineProperty(xhr, "responseText", {
                get: () => newText,
                configurable: true,
            });
            if (xhr.responseType === "" || xhr.responseType === "text") {
                Object.defineProperty(xhr, "response", {
                    get: () => newText,
                    configurable: true,
                });
            }
        } catch {
            /* defineProperty can fail on some xhr shells */
        }
    }

    function isTextual(contentType: string): boolean {
        return /text\/|json|javascript|xml|x-www-form-urlencoded/i.test(contentType);
    }

    async function looksTextual(response: Response): Promise<boolean> {
        // no/unknown content-type: sniff the first bytes for NULs
        try {
            const buf = new Uint8Array(await response.clone().arrayBuffer());
            const n = Math.min(buf.length, 512);
            for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
            return true;
        } catch {
            return false;
        }
    }
})();
