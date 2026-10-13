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
    let domHandlers: { name: string; when: string; src: string }[] = [];
    let domFired = false;
    let reqSeq = 0;
    const pending = new Map<number, (v: any) => void>();

    function logUp(msg: string, level: "info" | "warn" | "error" = "info"): void {
        console.log(`[res:hook] ${msg}`);
        try {
            window.postMessage({ source: HOOK_SOURCE, kind: "log", msg, level }, window.location.origin);
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
     * page's window (window.PARAMS etc.). Sources are background-transpiled
     * plain JS. If the page CSP forbids eval, report it — the bridge then
     * runs the handlers in the isolated world (shared DOM, no page window).
     */
    function compileAndScheduleDom(hot: boolean): void {
        if (domHandlers.length === 0) return;
        const compiledDom: { name: string; when: string; fn: (ctx: any) => any }[] = [];
        let cspBlocked = false;
        for (const d of domHandlers) {
            try {
                const fn = new Function(`return (${d.src});`)();
                compiledDom.push({ name: d.name, when: d.when, fn });
            } catch (e: any) {
                if (/Evaluating a string as JavaScript|unsafe-eval/i.test(e.message || "")) {
                    cspBlocked = true;
                } else {
                    logUp(`onDom ${d.name} compile failed: ${e.message || e}`, "error");
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
            logUp(`onDom firing (${compiledDom.length})`);
            for (const { name, fn } of compiledDom) {
                try {
                    fn(makeCtx(location.href, "GET"));
                } catch (e: any) {
                    logUp(`onDom ${name} threw: ${e.message || e}`, "error");
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

            try {
                // 1. replaceResponse? (background runs the handler)
                const repl = await viaBridge({ op: "replace", url, method });
                if (repl && repl.content !== null && repl.content !== undefined) {
                    return new Response(repl.content, { status: 200, headers: { "content-type": repl.mime || "text/plain" } });
                }

                // 2. real request
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
                const out = await viaBridge({ op: "transform", url, method, body: text, status: response.status, contentType });
                if (!out || typeof out.body !== "string" || out.body === text) return response;

                return new Response(out.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            } catch (e: any) {
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
            return OrigOpen.apply(this, args as any);
        };

        (window.XMLHttpRequest.prototype as any).send = function (...args: any[]) {
            const xhr = this as any;
            if (!active || !xhr.__resUrl) {
                return OrigSend.apply(this, args as any);
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
                if (xhr.readyState !== 4) {
                    if (origOnRsc) origOnRsc.call(xhr, ev);
                    return;
                }
                // async pipeline: onreadystatechange-property consumers get
                // the transformed body; addEventListener("load") consumers
                // may observe the original (platform limitation)
                void (async () => {
                    try {
                        const repl = await viaBridge({ op: "replace", url: absUrl, method: xhr.__resMethod });
                        if (repl && repl.content !== null && repl.content !== undefined) {
                            redefineBody(xhr, String(repl.content));
                            if (origOnRsc) origOnRsc.call(xhr, ev);
                            return;
                        }
                        const raw = xhr.response;
                        if (typeof raw !== "string" && raw !== null && raw !== "") {
                            if (origOnRsc) origOnRsc.call(xhr, ev);
                            return;
                        }
                        const out = await viaBridge({ op: "transform", url: absUrl, method: xhr.__resMethod, body: typeof raw === "string" ? raw : "", status: xhr.status });
                        if (out && typeof out.body === "string" && out.body !== raw) {
                            redefineBody(xhr, out.body);
                        }
                    } catch (e: any) {
                        logUp(`xhr pipeline error: ${e.message || e}`, "error");
                    }
                    if (origOnRsc) origOnRsc.call(xhr, ev);
                })();
            };

            return OrigSend.apply(this, args as any);
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

    requestStatus();
})();
