/**
 * Tier A — MAIN-world page hook. Runs at document_start, before any page JS.
 * Receives the script bundle from the isolated-world bridge (window message),
 * compiles the full sources locally (so handlers keep their `res` binding and
 * top-level scope), and overrides fetch/XHR to stream page-initiated bodies
 * through user transforms. Banner-free.
 *
 * Built as a standalone IIFE (no imports in output).
 */
import { compileScript, type CompiledScript } from "../shared/compile";

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

    function acceptBundle(bundle: any): void {
        const scripts: BundledScript[] = bundle && bundle.scripts;
        if (!scripts || scripts.length === 0) return;
        compiled = scripts.map((s) => {
            const script = compileScript(s.code);
            if (script.error) console.error(`[ResOverride hook] ${s.name}:`, script.error.split("\n")[0]);
            return { scriptId: s.scriptId, name: s.name, match: s.match, script };
        });
        patchFetch();
        patchXHR();
    }

    window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE || data.kind !== "bundle") return;
        acceptBundle(data.bundle);
    });

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
            } catch (e: any) {
                console.error(`[ResOverride hook] ${t.name} transform threw:`, e.message || e);
            }
        }
        return out;
    }

    // ---- fetch patch ----
    const origFetch = window.fetch.bind(window);

    function patchFetch(): void {
        window.fetch = async function (input: any, init?: RequestInit): Promise<Response> {
            const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
            const method =
                (init && init.method) ||
                (typeof input === "object" && input && input.method) ||
                "GET";

            claim(url);

            const response = await origFetch(input, init);

            if (compiled.length === 0) return response;

            try {
                const contentType = response.headers.get("content-type") || "";
                const isText = isTextual(contentType) || (await looksTextual(response));
                if (isText) {
                    const text = await response.clone().text();
                    const transformed = await applyTransforms(url, method, text, { contentType, status: response.status });
                    const out = typeof transformed === "string" ? transformed : dec.decode(transformed as Uint8Array);
                    return new Response(out, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                } else {
                    const bytes = new Uint8Array(await response.clone().arrayBuffer());
                    const transformed = await applyTransforms(url, method, bytes, { contentType, status: response.status });
                    const outBytes = typeof transformed === "string" ? enc.encode(transformed) : (transformed as Uint8Array);
                    return new Response(outBytes as any, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                }
            } catch (e: any) {
                console.error("[ResOverride hook] fetch transform failed:", e.message || e);
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
                    // the transformed body; `load`/addEventListener consumers
                    // may see the original (documented limitation)
                    console.warn("[ResOverride hook] async transform on XHR: load listeners may see the original body");
                    void (async () => {
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
