/**
 * Blocking-webRequest strategy: Firefox and MV2-capable Chromium browsers
 * (ungoogled-chromium, Brave, Opera…). Redirect/cancel, request/response
 * headers and synchronous respond/replaceResponse work everywhere with no
 * debugger involvement.
 *
 * How a replacement (replaceResponse, or onRequest `respond`) is served:
 * - Firefox: in place — the request proceeds and filterResponseData swaps
 *   the body, so the URL is kept (the upstream status code is, too).
 * - Chromium: webRequest can't touch bodies, so the only way is a redirect —
 *   to a data: URL, or for page loads to the extension's serve.html (the
 *   address bar shows the extension URL and the page loses its origin).
 *   Not done for scripts preferring the debugger tier (webRequestServesBody:
 *   "cdp" listed first, or "auto" for page/frame loads) — it fulfills those
 *   in place.
 *
 * Response-body streaming (modifyResponse via filterResponseData) and
 * awaiting async handlers are Firefox-only; on Chromium chromeBodyStrategy
 * takes over for bodies. MV3 has no blocking webRequest at all.
 */
import { recordNetBody } from "../../network";
import { match, matchReplace, matchAny } from "../../../shared/matcher";
import { compileScript, isThenable, makeModuleResolver, type CompiledScript } from "../../../shared/compile";
import { scriptLogLine, type ScriptLogLevel } from "../../../shared/scriptLog";
import { formatScriptError } from "../../../shared/scriptError";
import type { BodyScriptInfo, HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log, logTapped, scriptError } from "../logs";
import { dlogLevel } from "../../../shared/debugLog";
import { parseStrategyList } from "../../../shared/metaParser";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { isProcessOwned, webRequestServesBody } from "./processState";
import { deferRespond } from "./deferredRespond";

const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" &&
    typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

export class WebRequestStrategy implements InterceptionStrategy {
    readonly name = "webrequest";

    private compiled: { id: string; name: string; compiled: CompiledScript }[] = [];
    private mv3Warned = "";

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        if (__MV3__) {
            // only scripts that explicitly ask for this tier lose something
            const names = scripts
                .filter((s) => s.enabled && s.meta.declared && parseStrategyList(s.meta.strategy).includes("webrequest"))
                .map((s) => s.meta.name);
            const key = names.join("\n");
            if (names.length && key !== this.mv3Warned) {
                dlogLevel("webrequest", "warn", `strategy "webrequest" is unavailable in MV3 (no blocking webRequest) — ignored for ${names.map((n) => `"${n}"`).join(", ")}; their other listed strategies still apply (use "cdp" or "process" for browser-initiated loads)`);
            }
            this.mv3Warned = key;
            return;
        }
        let resolveSpec: (spec: string) => any = (spec) => {
            throw new Error(`cannot import "${spec}" before the module registry is ready`);
        };
        const overridesFor = (s: Script) => ({
            storage: {
                get: (key: string) => scriptStorageGet(s.id, key),
                set: (key: string, value: any) => scriptStorageSet(s.id, key, value),
            },
            logSink: (level: ScriptLogLevel, source: string, text: string) => log(-1, scriptLogLine(s.meta.name, source, text), level, s.id),
            paramValues: paramValues?.[s.id],
            importModule: (spec: string) => resolveSpec(spec),
        });
        resolveSpec = makeModuleResolver(
            scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
            (lib) => overridesFor(scripts.find((x) => x.id === lib.id) as Script)
        ).resolve;
        // `name` is the STORED script name — compiled meta.name is always
        // "Untitled script" (declareScript carries no name), so log
        // attribution must never read it from the compiled meta.
        this.compiled = scripts
            .filter((s) => s.enabled)
            .map((s) => ({ id: s.id, name: s.meta.name, compiled: compileScript(s.code, overridesFor(s)) }))
            .filter(({ compiled }) => compiled.meta.declared) // undeclared = library module
            .map(({ id, name, compiled }) => {
                if (compiled.error) scriptError(id, formatScriptError(name, compiled.error));
                return { id, name, compiled };
            });
        for (const c of this.compiled) {
            const h = c.compiled.handlers;
            dlogLevel("webrequest", "debug", `loaded "${c.name}" strategy=${c.compiled.meta.strategy} match=${JSON.stringify(c.compiled.meta.match)} handlers: onRequest=${h.onRequest.length} replaceResponse=${h.replaceResponse.length} modifyResponse=${h.modifyResponse.length} onResponseHeaders=${h.onResponseHeaders.length}${c.compiled.error ? ` ERROR: ${c.compiled.error}` : ""}`);
        }
    }

    /** names of the scripts this tier runs for `url` (diagnostics) */
    matchingNames(url: string): string[] {
        return this.scriptsFor(url).map((c) => c.name);
    }

    /** Free per-request caches (also called by the pipeline on error/complete). */
    pruneRequest(requestId: string): void {
        pendingFirefoxStreams.delete(requestId);
        pendingFirefoxReplace.delete(requestId);
        pendingRequestHeaderMods.delete(requestId);
    }

    supportsBodyModification(): boolean {
        return IS_FIREFOX;
    }

    private scriptsFor(url: string): { id: string; name: string; compiled: CompiledScript }[] {
        // process-owned scripts run in the helper tier (never twice)
        return this.compiled.filter(
            (c) => matchAny(c.compiled.meta.match, url) && !isProcessOwned(c.compiled.meta.strategy)
        );
    }

    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HookDisposition> {
        const matched = this.scriptsFor(details.url);
        if (matched.length) {
            trace(details, `onBeforeRequest ${details.type} ${details.method} ${details.url} (tab url: ${tabUrl ?? "unknown"}) → scripts: ${matched.map((m) => `"${m.name}"`).join(", ")}`);
        } else {
            const owned = this.compiled.filter((c) => matchAny(c.compiled.meta.match, details.url) && isProcessOwned(c.compiled.meta.strategy));
            if (owned.length) trace(details, `onBeforeRequest ${details.url}: skipped ${owned.map((m) => `"${m.name}"`).join(", ")} — owned by the process tier`);
        }
        for (const entry of matched) {
            const script = entry.compiled;
            // Chromium: serve replacements here (by redirect) or leave them to the debugger tier (in place)
            const servesBody = IS_FIREFOX || webRequestServesBody(script.meta.strategy, details.type);
            try {
                for (const onRequestHandler of script.handlers.onRequest) {
                    const result = onRequestHandler(makeCtx(details, tabUrl));
                    if (isThenable(result)) {
                        if (IS_FIREFOX) {
                            // Firefox blocking listeners accept promises natively
                            return result.then((r: any): HookDisposition => {
                                const hasHeaders = !!(r && r.headers && (r.headers.set || r.headers.remove));
                                if (hasHeaders) {
                                    log(details.tabId, `[${entry.name}] onRequest → request headers (${describeHeaderMods(r.headers)}) ${details.url}`, "info", entry.id);
                                    pendingRequestHeaderMods.set(
                                        details.requestId,
                                        mergeHeaderMods(pendingRequestHeaderMods.get(details.requestId), r.headers)
                                    );
                                }
                                if (r && (r.redirect || r.cancel)) {
                                    log(details.tabId, `[${entry.name}] onRequest → ${r.cancel ? "cancel" : `redirect → ${r.redirect}`} ${details.url}`, "info", entry.id);
                                    return normalize(r);
                                }
                                if (!hasHeaders) logTapped(details.tabId, entry.name, "onRequest", details.url, entry.id);
                                return { kind: "allow" };
                            });
                        }
                        // Chrome: blocking webRequest cannot await — the
                        // result would be decided too late
                        scriptError(entry.id, "async onRequest: Chrome's blocking webRequest cannot await. Return synchronously for redirect/cancel/headers, or add 'cdp' to the declareScript strategy list to handle it in the debugger tier.");
                        continue;
                    }
                    // cache header mods so onBeforeSendHeaders doesn't re-run the handler
                    const hasHeaders = !!(result && result.headers && (result.headers.set || result.headers.remove));
                    if (hasHeaders) {
                        log(details.tabId, `[${entry.name}] onRequest → request headers (${describeHeaderMods(result.headers)}) ${details.url}`, "info", entry.id);
                        // MERGE across stacked scripts (set: later wins per
                        // key; remove accumulates) — matches the
                        // onResponseHeaders semantics
                        pendingRequestHeaderMods.set(
                            details.requestId,
                            mergeHeaderMods(pendingRequestHeaderMods.get(details.requestId), result.headers)
                        );
                    }
                    // respond: synthesize the response (terminal, first wins)
                    if (result && result.respond) {
                        const body = serializeRespondBody(result.respond.body);
                        const mime = result.respond.mime || guessMime(null, details.url, "application/json");
                        const status = result.respond.status ?? 200;
                        // Neither a redirect nor Firefox's stream filter can
                        // carry a status — non-200 responds need the CDP tier
                        // (request-stage fulfill honors status), and so does
                        // a script preferring it (the URL is kept). The
                        // debugger tier serves the result stashed here rather
                        // than running the handler again. The hook tier
                        // short-circuits first for page-initiated requests.
                        if (IS_FIREFOX && status !== 200) {
                            log(details.tabId, `[${entry.name}] onRequest → respond ${status} not served: Firefox's webRequest can't set a response status (only 200 can be served in place) ${details.url}`, "warn", entry.id);
                            return { kind: "allow" };
                        }
                        if (status !== 200 || !servesBody) {
                            trace(details, `[${entry.name}] onRequest → respond ${status}: deferred to the debugger tier ${details.url}`);
                            deferRespond(details.tabId, details.method, details.url, { scriptId: entry.id, scriptName: entry.name, respond: result.respond });
                            return { kind: "needsCdp" };
                        }
                        if (IS_FIREFOX) return this.firefoxReplaceLater(details, body, mime, entry.id, entry.name, "respond");
                        return this.staticServe(details, body, mime, entry.id, entry.name);
                    }
                    if (result && (result.redirect || result.cancel)) {
                        log(details.tabId, `[${entry.name}] onRequest → ${result.cancel ? "cancel" : `redirect → ${result.redirect}`} ${details.url}`, "info", entry.id);
                        return normalize(result);
                    }
                    trace(details, `[${entry.name}] onRequest returned ${describeResult(result)} (no redirect/cancel/respond) for ${details.url}`);
                    if (!hasHeaders) logTapped(details.tabId, entry.name, "onRequest", details.url, entry.id);
                }
                // not served here: the debugger tier runs replaceResponse itself
                // (chromeBodyStrategy routes the request there) — never twice
                if (script.handlers.replaceResponse.length && servesBody) {
                    let replacement: any = undefined;
                    for (const replaceHandler of script.handlers.replaceResponse) {
                        replacement = replaceHandler(makeCtx(details, tabUrl));
                        if (replacement !== undefined && replacement !== null) break;
                        logTapped(details.tabId, entry.name, "replaceResponse", details.url, entry.id);
                    }
                    if (isThenable(replacement)) {
                        if (IS_FIREFOX) {
                            return replacement.then((r: any) => {
                                if (r === undefined || r === null) {
                                    logTapped(details.tabId, entry.name, "replaceResponse", details.url, entry.id);
                                    return { kind: "allow" } as HookDisposition;
                                }
                                return this.replace(details, r, entry.id, entry.name);
                            });
                        }
                        // Chrome: let the request continue; the CDP tier awaits
                        // the handler and fulfills the body
                        return { kind: "needsCdp" };
                    }
                    if (replacement !== undefined && replacement !== null) {
                        return this.replace(details, replacement, entry.id, entry.name);
                    }
                }
                if (script.handlers.modifyResponse.length && IS_FIREFOX) {
                    // Firefox: stream via filterResponseData at onHeadersReceived time;
                    // here we only mark the request so the header-phase hook wires the filter.
                    pendingFirefoxStreams.set(details.requestId, { entry, tabUrl });
                }
            } catch (e: any) {
                scriptError(entry.id, formatScriptError(entry.name, e, "onRequest"));
            }
        }
        if (matched.length) trace(details, `onBeforeRequest ${details.url} → allow (no terminal decision)`);
        return { kind: "allow" };
    }

    handleBeforeSendHeaders(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        return this.collectHeaderChanges(details, tabUrl, "request", "headers");
    }

    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        const changes = this.collectHeaderChanges(details, tabUrl, "response", "headers");
        // Firefox in-place replacement: swap the body, fix the headers to match
        const rep = pendingFirefoxReplace.get(details.requestId);
        if (rep && IS_FIREFOX) {
            // a redirect hop: the replacement belongs to the final response
            if (isRedirectStatus(details.statusCode)) return changes;
            pendingFirefoxReplace.delete(details.requestId);
            pendingFirefoxStreams.delete(details.requestId);
            this.wireFirefoxReplace(details, rep);
            const fix = replacementHeaders(rep.mime, rep.content);
            return isThenable(changes) ? changes.then((c) => mergeReplacementHeaders(c, fix)) : mergeReplacementHeaders(changes, fix);
        }
        // Firefox streaming: wire the filter when response headers arrive.
        const pending = pendingFirefoxStreams.get(details.requestId);
        if (pending && IS_FIREFOX) {
            pendingFirefoxStreams.delete(details.requestId);
            this.wireFirefoxStream(details, pending.entry.compiled, pending.tabUrl ?? tabUrl, pending.entry.id, pending.entry.name);
        }
        return changes;
    }


    dispose(): void {
        this.compiled = [];
    }

    /** Chromium only (see staticReplace): an onRequest status-200 respond, by redirect. */
    private staticServe(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string, scriptId: string, scriptName: string): HookDisposition {
        log(details.tabId, `[${scriptName}] onRequest → respond 200 ${mime} (${content.length}b) ${details.url}`, "info", scriptId);
        recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: content, mime, status: 200 });
        if (details.type === "main_frame") {
            const rid = "serve_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            serveStore.set(rid, { content: typeof content === "string" ? content : new TextDecoder().decode(content), mime });
            return { kind: "redirect", url: chrome.runtime.getURL("serve.html?rid=" + rid) };
        }
        return { kind: "redirect", url: toDataUrl(mime, content) };
    }

    /** A replaceResponse result: in place on Firefox, by redirect on Chromium. */
    private replace(details: WebRequestDetailsLike, replacement: any, scriptId: string, scriptName: string): HookDisposition {
        const r = replacementContent(details, replacement);
        if (!r) return { kind: "allow" };
        if (IS_FIREFOX) return this.firefoxReplaceLater(details, r.content, r.mime, scriptId, scriptName, "replaceResponse");
        return this.staticReplace(details, r.content, r.mime, scriptId, scriptName);
    }

    /**
     * Chromium only: webRequest can't write a body, so the replacement is
     * served by redirecting — the URL changes (see the header comment).
     */
    private staticReplace(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string, scriptId: string, scriptName: string): HookDisposition {
        log(details.tabId, `[${scriptName}] replaceResponse → ${mime} (${content.length} bytes) ${details.url}`, "info", scriptId);
        recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: content, mime, status: 200 });
        // Chrome blocks top-level data: navigations — serve main frames
        // from an extension page instead
        if (details.type === "main_frame") {
            const rid = "serve_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            serveStore.set(rid, { content: typeof content === "string" ? content : new TextDecoder().decode(content), mime });
            return { kind: "redirect", url: chrome.runtime.getURL("serve.html?rid=" + rid) };
        }
        return { kind: "redirect", url: toDataUrl(mime, content) };
    }

    /**
     * Firefox: no redirect — let the request proceed and swap its body at
     * onHeadersReceived (wireFirefoxReplace), so the URL and origin stay.
     */
    private firefoxReplaceLater(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string, scriptId: string, scriptName: string, via: "replaceResponse" | "respond"): HookDisposition {
        pendingFirefoxReplace.set(details.requestId, { content, mime, scriptId, scriptName, via });
        return { kind: "allow" };
    }

    private wireFirefoxReplace(details: WebRequestDetailsLike, rep: FirefoxReplacement): void {
        const what = rep.via === "respond" ? `onRequest → respond 200 ${rep.mime} (${rep.content.length}b)` : `replaceResponse → ${rep.mime} (${rep.content.length} bytes)`;
        try {
            const filter = ((globalThis as any).browser?.webRequest ?? chrome.webRequest).filterResponseData(details.requestId);
            const bytes = typeof rep.content === "string" ? new TextEncoder().encode(rep.content) : rep.content;
            // the upstream body is never read: write the replacement once and close
            filter.ondata = () => {};
            filter.onstart = () => {
                filter.write(bytes);
                filter.close();
            };
            log(details.tabId, `[${rep.scriptName}] ${what} ${details.url}`, "info", rep.scriptId);
            recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: rep.content, mime: rep.mime, status: 200 });
        } catch (e: any) {
            scriptError(rep.scriptId, formatScriptError(rep.scriptName, e, "filterResponseData"));
        }
    }

    private collectHeaderChanges(
        details: WebRequestDetailsLike,
        tabUrl: string | null,
        phase: "request" | "response",
        _unused: string
    ): MaybePromise<HeaderChanges | null> {
        let changes: HeaderChanges | null = null;
        const ctxPhase = phase === "response" ? "response" : "request";

        // request-phase header mods were computed once in handleBeforeRequest
        if (ctxPhase === "request") {
            const cached = pendingRequestHeaderMods.get(details.requestId);
            if (cached) return { ...cached };
            return null;
        }

        for (const entry of this.scriptsFor(details.url)) {
            const handlers = entry.compiled.handlers.onResponseHeaders;
            if (!handlers.length) continue;
            for (const handler of handlers) {
            try {
                const ctx = makeCtx(details, tabUrl);
                (ctx as any).statusLine = details.statusLine || "";
                (ctx as any).responseHeaders = details.responseHeaders || [];
                const result = handler(ctx);
                if (isThenable(result)) {
                    if (IS_FIREFOX) {
                        // resolved below by the pipeline passthrough
                        return result.then((r: any) => {
                            const m = r && r.headers;
                            if (m && (m.set || m.remove)) {
                                log(details.tabId, `[${entry.name}] onResponseHeaders → ${describeHeaderMods(m)} ${details.url}`, "info", entry.id);
                                return { ...m };
                            }
                            logTapped(details.tabId, entry.name, "onResponseHeaders", details.url, entry.id);
                            return null;
                        });
                    }
                    scriptError(entry.id, "async onResponseHeaders: Chrome's blocking webRequest cannot await. Add 'cdp' to the declareScript strategy list to apply async header changes in the debugger tier.");
                    continue;
                }
                const mods = (result as any)?.headers;
                if (mods && (mods.set || mods.remove)) {
                    log(details.tabId, `[${entry.name}] onResponseHeaders → ${describeHeaderMods(mods)} ${details.url}`, "info", entry.id);
                    changes = changes || {};
                    changes.set = { ...changes.set, ...mods.set };
                    changes.remove = [...(changes.remove || []), ...(mods.remove || [])];
                } else logTapped(details.tabId, entry.name, "onResponseHeaders", details.url, entry.id);
            } catch (e: any) {
                scriptError(entry.id, formatScriptError(entry.name, e, "onResponseHeaders"));
            }
            }
        }
        return changes;
    }

    private wireFirefoxStream(details: WebRequestDetailsLike, script: CompiledScript, tabUrl: string | null, scriptId: string, scriptName: string): void {
        try {
            const filter = ((globalThis as any).browser?.webRequest ?? chrome.webRequest).filterResponseData(details.requestId);
            const decoder = new TextDecoder("utf-8");
            const encoder = new TextEncoder();
            const chunks: Uint8Array[] = [];
            filter.ondata = (e: { data: ArrayBuffer }) => {
                chunks.push(new Uint8Array(e.data));
            };
            filter.onstop = async () => {
                const total = chunks.reduce((n, c) => n + c.length, 0);
                const bytes = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                    bytes.set(c, off);
                    off += c.length;
                }
                let body: string | Uint8Array = looksBinary(bytes) ? bytes : decoder.decode(bytes);
                const original = body;
                const ctx = { ...makeCtx(details, tabUrl), contentType: contentTypeOf(details.responseHeaders) };
                for (const transform of script.handlers.modifyResponse) {
                    try {
                        const out = await transform(ctx, body);
                        if (out !== undefined && out !== null && out !== body) {
                            const size = (b: any) => (typeof b === "string" ? b.length : (b?.byteLength ?? 0));
                            log(details.tabId, `[${scriptName}] modifyResponse applied (${size(body)}b → ${size(out)}b) ${details.url}`, "info", scriptId);
                            body = out;
                        } else logTapped(details.tabId, scriptName, "modifyResponse", details.url, scriptId);
                    } catch (e: any) {
                        scriptError(scriptId, formatScriptError(scriptName, e, "modifyResponse"));
                    }
                }
                const outBytes = typeof body === "string" ? encoder.encode(body) : body;
                recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, original, modified: body === original ? null : body });
                filter.write(outBytes);
                filter.close();
            };
        } catch (e: any) {
            scriptError(scriptId, formatScriptError(scriptName, e, "filterResponseData"));
        }
    }
}

// ---- shared helpers ----

/** request-level diagnostics: visible in the LOG panel at logLevel: debug */
function trace(details: WebRequestDetailsLike, msg: string): void {
    log(details.tabId, `[webrequest] ${msg}`, "debug");
}

function describeResult(r: any): string {
    if (r === undefined) return "undefined";
    if (r === null) return "null";
    try {
        const json = JSON.stringify(r);
        return json.length > 200 ? json.slice(0, 197) + "..." : json;
    } catch {
        return String(r);
    }
}

function describeHeaderMods(m: { set?: Record<string, string>; remove?: string[] }): string {
    const parts: string[] = [];
    if (m.set && Object.keys(m.set).length) parts.push(`set ${Object.keys(m.set).join(", ")}`);
    if (m.remove?.length) parts.push(`remove ${m.remove.join(", ")}`);
    return parts.join("; ");
}

export function makeCtx(details: WebRequestDetailsLike, tabUrl: string | null): any {
    const headers: { [n: string]: string } = {};
    for (const h of details.requestHeaders || []) {
        headers[h.name.toLowerCase()] = h.value || "";
    }
    return {
        url: details.url,
        method: details.method,
        tabUrl: tabUrl || "",
        resourceType: details.type,
        requestHeaders: headers,
    };
}

export function normalize(result: any): HookDisposition {
    if (result.respond) return { kind: "respond", serve: result.respond } as any;
    if (result.cancel) return { kind: "cancel" };
    if (result.redirect) return { kind: "redirect", url: result.redirect };
    if (result.headers) return { kind: "headers", changes: result.headers };
    return { kind: "allow" };
}

export function toDataUrl(mime: string, content: string | Uint8Array): string {
    if (typeof content === "string") {
        return "data:" + mime + ";charset=UTF-8," + encodeURIComponent(content);
    }
    let bin = "";
    for (let i = 0; i < content.length; i++) bin += String.fromCharCode(content[i]);
    return "data:" + mime + ";base64," + btoa(bin);
}

export function guessMime(filePath: string | null, requestUrl: string, fallback = "application/octet-stream"): string {
    const ext = (filePath || requestUrl).split("?")[0].split(".").pop()?.toLowerCase() || "";
    const table: { [e: string]: string } = {
        js: "application/javascript", mjs: "application/javascript", json: "application/json",
        css: "text/css", html: "text/html", htm: "text/html", xml: "application/xml",
        txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
        woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
        mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wasm: "application/wasm",
    };
    if (filePath && filePath.startsWith("data:")) {
        return filePath.slice(5).split(";")[0] || "text/plain";
    }
    return table[ext] || fallback;
}

function readFileSyncValue(fileRef: string): string {
    if (fileRef.startsWith("data:")) {
        const commaIdx = fileRef.indexOf(",");
        if (fileRef.slice(5, commaIdx).includes("base64")) {
            return atob(fileRef.slice(commaIdx + 1));
        }
        return decodeURIComponent(fileRef.slice(commaIdx + 1));
    }
    return fileRef;
}

function contentTypeOf(headers: { name: string; value?: string }[] | undefined): string | undefined {
    const h = headers?.find((x) => x.name.toLowerCase() === "content-type");
    return h?.value;
}

function looksBinary(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 512);
    for (let i = 0; i < n; i++) {
        if (bytes[i] === 0) return true;
    }
    return false;
}

/** in-memory store for main-frame served replacements */
export const serveStore = new Map<string, { content: string; mime: string }>();

function serializeRespondBody(body: any): string | Uint8Array {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return body;
    return JSON.stringify(body);
}

/** Merge stacked header mods: set keys later-wins, removes accumulate. */
export function mergeHeaderMods(base: HeaderChanges | undefined, add: HeaderChanges): HeaderChanges {
    return {
        set: { ...(base?.set || {}), ...(add.set || {}) },
        remove: [...(base?.remove || []), ...(add.remove || [])],
    };
}

interface FirefoxReplacement {
    content: string | Uint8Array;
    mime: string;
    scriptId: string;
    scriptName: string;
    via: "replaceResponse" | "respond";
}

/** requestId → a replacement body Firefox writes in place at onHeadersReceived */
const pendingFirefoxReplace = new Map<string, FirefoxReplacement>();

/** a replacement's mime when the URL has no telling extension */
const TYPE_MIME: Record<string, string> = { xmlhttprequest: "application/json", main_frame: "text/html", sub_frame: "text/html", stylesheet: "text/css", script: "application/javascript" };

/** the mime + bytes a replaceResponse result stands for (null: not a body) */
export function replacementContent(details: { url: string; type?: string }, replacement: any): { mime: string; content: string | Uint8Array } | null {
    const mimeFor = (fileRef: string | null) =>
        fileRef
            ? guessMime(fileRef, details.url)
            : guessMime(null, details.url, TYPE_MIME[details.type || ""]);
    if (replacement && typeof replacement === "object" && !ArrayBuffer.isView(replacement) && replacement.file) {
        return { mime: mimeFor(replacement.file), content: readFileSyncValue(replacement.file) };
    }
    if (typeof replacement === "string" || replacement instanceof Uint8Array) {
        return { mime: mimeFor(null), content: replacement };
    }
    return null;
}

function isRedirectStatus(status: number | undefined): boolean {
    return status !== undefined && status >= 300 && status < 400 && status !== 304;
}

/**
 * Response headers for an in-place replacement: the new type, and none that
 * describe the upstream bytes (length, encoding, digests, ranges).
 */
export function replacementHeaders(mime: string, content: string | Uint8Array): HeaderChanges {
    const type = typeof content === "string" && !/charset=/i.test(mime) && /^(text\/|application\/(json|javascript|xml)|image\/svg)/i.test(mime) ? `${mime}; charset=utf-8` : mime;
    return {
        set: { "Content-Type": type },
        remove: ["Content-Length", "Content-Encoding", "Content-MD5", "Content-Range", "Digest", "Repr-Digest", "Content-Digest", "ETag"],
    };
}

/** script header changes first, the replacement's own headers win */
function mergeReplacementHeaders(changes: HeaderChanges | null, fix: HeaderChanges): HeaderChanges {
    const removeFix = new Set((fix.remove || []).map((n) => n.toLowerCase()));
    const set = Object.fromEntries(Object.entries(changes?.set || {}).filter(([n]) => !removeFix.has(n.toLowerCase()) && n.toLowerCase() !== "content-type"));
    return { set: { ...set, ...fix.set }, remove: [...(changes?.remove || []), ...(fix.remove || [])] };
}

/** requestId → script awaiting a Firefox stream filter */
const pendingFirefoxStreams = new Map<string, { entry: { id: string; name: string; compiled: CompiledScript }; tabUrl: string | null }>();

/** requestId → request header mods already computed by onRequest (issue: run once) */
const pendingRequestHeaderMods = new Map<string, HeaderChanges>();
