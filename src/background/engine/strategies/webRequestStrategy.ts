/**
 * Blocking-webRequest strategy: Firefox and MV2-capable Chromium browsers
 * (ungoogled-chromium, Brave, Opera…). Redirect/cancel, request/response
 * headers and synchronous respond/replaceResponse work everywhere with no
 * debugger involvement.
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
import { log, scriptError } from "../logs";
import { dlogLevel } from "../../../shared/debugLog";
import { parseStrategyList } from "../../../shared/metaParser";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { isProcessOwned } from "./processState";

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
    }

    /** Free per-request caches (also called by the pipeline on error/complete). */
    pruneRequest(requestId: string): void {
        pendingFirefoxStreams.delete(requestId);
        pendingRequestHeaderMods.delete(requestId);
    }

    supportsBodyModification(): boolean {
        return IS_FIREFOX;
    }

    private scriptsFor(url: string, phase: "request" | "response"): { id: string; name: string; compiled: CompiledScript }[] {
        // process-owned scripts run in the helper tier (never twice)
        return this.compiled.filter(
            (c) => matchAny(c.compiled.meta.match, url) && c.compiled.meta.phase.includes(phase) && !isProcessOwned(c.compiled.meta.strategy)
        );
    }

    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HookDisposition> {
        for (const entry of this.scriptsFor(details.url, "request")) {
            const script = entry.compiled;
            try {
                for (const onRequestHandler of script.handlers.onRequest) {
                    const result = onRequestHandler(makeCtx(details, tabUrl));
                    if (isThenable(result)) {
                        if (IS_FIREFOX) {
                            // Firefox blocking listeners accept promises natively
                            return result.then((r: any): HookDisposition => {
                                if (r && r.headers && (r.headers.set || r.headers.remove)) {
                                    pendingRequestHeaderMods.set(
                                        details.requestId,
                                        mergeHeaderMods(pendingRequestHeaderMods.get(details.requestId), r.headers)
                                    );
                                }
                                return r && (r.redirect || r.cancel) ? normalize(r) : { kind: "allow" };
                            });
                        }
                        // Chrome: blocking webRequest cannot await — the
                        // result would be decided too late
                        scriptError(entry.id, "async onRequest: Chrome's blocking webRequest cannot await. Return synchronously for redirect/cancel/headers, or add 'cdp' to the declareScript strategy list to handle it in the debugger tier.");
                        continue;
                    }
                    // cache header mods so onBeforeSendHeaders doesn't re-run the handler
                    if (result && result.headers && (result.headers.set || result.headers.remove)) {
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
                        // data-URL redirects cannot carry a status — non-200
                        // responds need the CDP tier (request-stage fulfill
                        // honors status); the hook tier short-circuits first
                        // for page-initiated requests
                        if (result.respond.status && result.respond.status !== 200) {
                            log(details.tabId, `[${entry.name}] onRequest → respond ${result.respond.status} (via debugger tier) ${details.url}`, "info", entry.id);
                            return { kind: "needsCdp" };
                        }
                        // status 200 (or none): data-URL is exact
                        return this.staticServe(details, body, mime, entry.id, entry.name);
                    }
                    if (result && (result.redirect || result.cancel)) {
                        log(details.tabId, `[${entry.name}] onRequest → ${JSON.stringify(result).slice(0, 200)}`, "info", entry.id);
                        return normalize(result);
                    }
                }
                if (script.handlers.replaceResponse.length) {
                    let replacement: any = undefined;
                    for (const replaceHandler of script.handlers.replaceResponse) {
                        replacement = replaceHandler(makeCtx(details, tabUrl));
                        if (replacement !== undefined && replacement !== null) break;
                    }
                    if (isThenable(replacement)) {
                        if (IS_FIREFOX) {
                            return replacement.then((r: any) => {
                                if (r === undefined || r === null) return { kind: "allow" } as HookDisposition;
                                return this.staticReplace(details, r, entry.id, entry.name);
                            });
                        }
                        // Chrome: let the request continue; the CDP tier awaits
                        // the handler and fulfills the body
                        return { kind: "needsCdp" };
                    }
                    if (replacement !== undefined && replacement !== null) {
                        return this.staticReplace(details, replacement, entry.id, entry.name);
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
        return { kind: "allow" };
    }

    handleBeforeSendHeaders(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        return this.collectHeaderChanges(details, tabUrl, "request", "headers");
    }

    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        // Firefox streaming: wire the filter when response headers arrive.
        const pending = pendingFirefoxStreams.get(details.requestId);
        if (pending && IS_FIREFOX) {
            pendingFirefoxStreams.delete(details.requestId);
            this.wireFirefoxStream(details, pending.entry.compiled, pending.tabUrl ?? tabUrl, pending.entry.id, pending.entry.name);
        }
        return this.collectHeaderChanges(details, tabUrl, "response", "headers");
    }


    dispose(): void {
        this.compiled = [];
    }

    private staticServe(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string, scriptId: string, scriptName: string): HookDisposition {
        log(details.tabId, `[${scriptName}] serve ${mime} (${content.length}b)`, "info", scriptId);
        recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: content, mime, status: 200 });
        if (details.type === "main_frame") {
            const rid = "serve_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            serveStore.set(rid, { content: typeof content === "string" ? content : new TextDecoder().decode(content), mime });
            return { kind: "redirect", url: chrome.runtime.getURL("serve.html?rid=" + rid) };
        }
        return { kind: "redirect", url: toDataUrl(mime, content) };
    }

    private staticReplace(details: WebRequestDetailsLike, replacement: any, scriptId: string, scriptName: string): HookDisposition {
        const mimeFor = (fileRef: string | null) =>
            fileRef
                ? guessMime(fileRef, details.url)
                : guessMime(null, details.url, details.type === "xmlhttprequest" ? "application/json" : undefined);

        const serve = (mime: string, content: string | Uint8Array): HookDisposition => {
            log(details.tabId, `[${scriptName}] replaceResponse → ${mime} (${content.length} bytes)`, "info", scriptId);
            recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: content, mime, status: 200 });
            // Chrome blocks top-level data: navigations — serve main frames
            // from an extension page instead
            if (details.type === "main_frame") {
                const rid = "serve_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                serveStore.set(rid, { content: typeof content === "string" ? content : new TextDecoder().decode(content), mime });
                return { kind: "redirect", url: chrome.runtime.getURL("serve.html?rid=" + rid) };
            }
            return { kind: "redirect", url: toDataUrl(mime, content) };
        };

        if (replacement && typeof replacement === "object" && !ArrayBuffer.isView(replacement) && replacement.file) {
            return serve(mimeFor(replacement.file), readFileSyncValue(replacement.file));
        }
        if (typeof replacement === "string") {
            return serve(mimeFor(null), replacement);
        }
        if (replacement instanceof Uint8Array) {
            return serve(mimeFor(null), replacement);
        }
        return { kind: "allow" };
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

        for (const entry of this.scriptsFor(details.url, ctxPhase)) {
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
                        return result.then((r: any) => (r && r.headers ? { ...r.headers } : null));
                    }
                    scriptError(entry.id, "async onResponseHeaders: Chrome's blocking webRequest cannot await. Add 'cdp' to the declareScript strategy list to apply async header changes in the debugger tier.");
                    continue;
                }
                const mods = (result as any)?.headers;
                if (mods && (mods.set || mods.remove)) {
                    changes = changes || {};
                    changes.set = { ...changes.set, ...mods.set };
                    changes.remove = [...(changes.remove || []), ...(mods.remove || [])];
                }
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
                        if (out !== undefined && out !== null) body = out;
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

/** requestId → script awaiting a Firefox stream filter */
const pendingFirefoxStreams = new Map<string, { entry: { id: string; name: string; compiled: CompiledScript }; tabUrl: string | null }>();

/** requestId → request header mods already computed by onRequest (issue: run once) */
const pendingRequestHeaderMods = new Map<string, HeaderChanges>();
