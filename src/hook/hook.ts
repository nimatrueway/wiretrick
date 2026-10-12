/**
 * Tier A — MAIN-world page hook. Runs at document_start, before any page JS.
 * Fetches the matching body scripts from the background, overrides fetch/XHR,
 * and streams response bodies through user transforms. Banner-free.
 *
 * Built as a standalone IIFE (no imports in output).
 */
(() => {
    const w = window as any;
    if (w.__resOverrideHooked) return;
    w.__resOverrideHooked = true;

    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8");

    interface BundleScript {
        scriptId: string;
        name: string;
        match: string[];
        transformSrc: string;
    }
    let scripts: BundleScript[] = [];

    function compileTransform(src: string): ((ctx: any, body: any) => any) | null {
        try {
            return new Function(`return (${src});`)();
        } catch (e) {
            console.error("[ResOverride hook] bad transform", e);
            return null;
        }
    }

    /** star-pattern → regex (same semantics as the engine's matcher) */
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

    async function init() {
        try {
            const bundle = await chrome.runtime.sendMessage({ type: "getHookBundle", url: location.href });
            if (bundle && bundle.scripts) {
                scripts = bundle.scripts;
            }
        } catch (e) {
            return; // extension context gone
        }
        if (scripts.length === 0) return;

        patchFetch();
        patchXHR();
    }

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
        // Per-request filtering: a script only applies to URLs in its @match list.
        return (scripts
            .filter((s) => urlMatches(s.match, url))
            .map((s) => ({ scriptId: s.scriptId, name: s.name, fn: compileTransform(s.transformSrc) }))
            .filter((t) => t.fn) as { scriptId: string; name: string; fn: (ctx: any, body: any) => any }[]);
    }

    async function applyTransforms(url: string, method: string, body: string | Uint8Array, extra?: any): Promise<string | Uint8Array> {
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

    function isBodyOnlyUrl(url: string): boolean {
        return true;
    }
    void isBodyOnlyUrl;

    function claim(url: string): void {
        try {
            chrome.runtime.sendMessage({ type: "claimRequest", url });
        } catch {}
    }

    function patchFetch(): void {
        window.fetch = async function (input: any, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const method = (init && init.method) || (typeof input === "object" && input && input.method) || "GET";

            claim(url);

            const response = await origFetch(input, init);

            if (scripts.length === 0) return response;

            try {
                const contentType = response.headers.get("content-type") || "";
                if (isTextual(contentType) || (await looksTextual(response))) {
                    const text = await response.clone().text();
                    const transformed = await applyTransforms(url, method, text, { contentType, status: response.status });
                    const out = typeof transformed === "string" ? transformed : dec.decode(transformed);
                    return new Response(out, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                } else {
                    const bytes = new Uint8Array(await response.clone().arrayBuffer());
                    const transformed = await applyTransforms(url, method, bytes, { contentType, status: response.status });
                    const outBytes = typeof transformed === "string" ? enc.encode(transformed) : transformed;
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
            // eslint-disable-next-line prefer-spread
            return XHROpen.apply(this, args as any);
        };

        (window.XMLHttpRequest.prototype as any).send = function (...args: any[]) {
            const xhr = this as any;
            if (scripts.length === 0 || !xhr.__resUrl) {
                return XHRSend.apply(this, args as any);
            }

            claim(new URL(xhr.__resUrl, location.href).href);

            const origOnRsc = xhr.onreadystatechange;
            xhr.onreadystatechange = function (ev: any) {
                if (xhr.readyState === 4 && scripts.length > 0) {
                    try {
                        const contentType = xhr.getResponseHeader("content-type") || "";
                        const raw = xhr.response;
                        if (typeof raw === "string" || raw === null || raw === "") {
                            void (async () => {
                                const transformed = await applyTransforms(
                                    new URL(xhr.__resUrl, location.href).href,
                                    xhr.__resMethod,
                                    typeof raw === "string" ? raw : "",
                                    { contentType, status: xhr.status }
                                );
                                redefineResponseText(xhr, typeof transformed === "string" ? transformed : dec.decode(transformed as any));
                                if (origOnRsc) origOnRsc.call(xhr, ev);
                            })();
                            return;
                        }
                    } catch (e: any) {
                        console.error("[ResOverride hook] XHR transform failed:", e.message || e);
                    }
                }
                if (origOnRsc) origOnRsc.call(xhr, ev);
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
        } catch (e) {
            /* defineProperty can fail on some xhr shells */
        }
    }

    function isTextual(contentType: string): boolean {
        return /text\/|json|javascript|xml|x-www-form-urlencoded/i.test(contentType) || contentType === "";
    }

    async function looksTextual(response: Response): Promise<boolean> {
        // no content-type: peek at the first bytes
        try {
            const buf = new Uint8Array(await response.clone().arrayBuffer());
            const n = Math.min(buf.length, 512);
            for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
            return true;
        } catch {
            return false;
        }
    }

    init();
})();
