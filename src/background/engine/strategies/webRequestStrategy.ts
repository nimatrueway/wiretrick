/**
 * Firefox-class strategy: blocking webRequest + filterResponseData.
 * Also the header/redirect engine used by both browsers — redirect/cancel and
 * static replaceResponse work here with no debugger involvement.
 *
 * Chrome body streaming (modifyResponse) is NOT implemented here; on Chrome
 * chromeBodyStrategy takes over for bodies.
 */
import { match, matchReplace, matchAny } from "../../../shared/matcher";
import { compileScript, serializeHandlers, type CompiledScript } from "../../../shared/compile";
import type { BodyScriptInfo, HeaderChanges, HookDisposition, InterceptionStrategy, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log, scriptError } from "../logs";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";

const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" &&
    typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

export class WebRequestStrategy implements InterceptionStrategy {
    readonly name = "webrequest";

    private compiled: CompiledScript[] = [];

    reload(scripts: Script[]): void {
        this.compiled = scripts.filter((s) => s.enabled).map((s) => {
            const c = compileScript(s.code);
            c.meta = s.meta;
            if (c.error) scriptError(s.id, c.error);
            return c;
        });
    }

    supportsBodyModification(): boolean {
        return IS_FIREFOX;
    }

    private scriptsFor(url: string, phase: "request" | "response"): CompiledScript[] {
        return this.compiled.filter(
            (c) => matchAny(c.meta.match, url) && c.meta.phase.includes(phase)
        );
    }

    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): HookDisposition {
        for (const script of this.scriptsFor(details.url, "request")) {
            if (tabUrl && !matchAny(tabUrl === details.url ? ["<all>"] : script.meta.match, tabUrl) && script.meta.match.length === 0) {
                continue;
            }
            try {
                if (script.handlers.onRequest) {
                    const result = script.handlers.onRequest(makeCtx(details, tabUrl));
                    if (result && (result.redirect || result.cancel || result.headers)) {
                        log(details.tabId, `[${script.meta.name}] onRequest → ${JSON.stringify(result).slice(0, 200)}`, "info", scriptIdOf(script));
                        return normalize(result);
                    }
                }
                if (script.handlers.replaceResponse) {
                    const replacement = script.handlers.replaceResponse(makeCtx(details, tabUrl));
                    if (replacement !== undefined && replacement !== null) {
                        return this.staticReplace(details, script, replacement);
                    }
                }
                if (script.handlers.modifyResponse && IS_FIREFOX) {
                    // Firefox: stream via filterResponseData at onHeadersReceived time;
                    // here we only mark the request so the header-phase hook wires the filter.
                    pendingFirefoxStreams.set(details.requestId, script);
                }
            } catch (e: any) {
                scriptError(scriptIdOf(script), `onRequest threw: ${e.message || e}`);
            }
        }
        return { kind: "allow" };
    }

    handleBeforeSendHeaders(details: WebRequestDetailsLike, tabUrl: string | null): HeaderChanges | null {
        return this.collectHeaderChanges(details, tabUrl, "request", "headers");
    }

    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): HeaderChanges | null {
        // Firefox streaming: wire the filter when response headers arrive.
        const pending = pendingFirefoxStreams.get(details.requestId);
        if (pending && IS_FIREFOX) {
            pendingFirefoxStreams.delete(details.requestId);
            this.wireFirefoxStream(details, pending, tabUrl);
        }
        return this.collectHeaderChanges(details, tabUrl, "response", "headers");
    }

    getTransformsForUrl(url: string, tabUrl: string | null): BodyScriptInfo[] {
        return this.scriptsFor(url, "request")
            .filter((s) => s.handlers.modifyResponse)
            .map((s) => ({
                scriptId: scriptIdOf(s),
                transformSrc: s.handlers.modifyResponse!.toString(),
                meta: s.meta,
            }));
    }

    dispose(): void {
        this.compiled = [];
    }

    private staticReplace(details: WebRequestDetailsLike, script: CompiledScript, replacement: any): HookDisposition {
        const mimeFor = (fileRef: string | null) =>
            fileRef
                ? guessMime(fileRef, details.url)
                : guessMime(null, details.url, details.type === "xmlhttprequest" ? "application/json" : undefined);

        const serve = (mime: string, content: string | Uint8Array) => {
            log(details.tabId, `[${script.meta.name}] replaceResponse → ${mime} (${content.length} bytes)`, "info", scriptIdOf(script));
            return { kind: "redirect" as const, url: toDataUrl(mime, content) } as HookDisposition;
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
    ): HeaderChanges | null {
        let changes: HeaderChanges | null = null;
        const ctxPhase = phase === "response" ? "response" : "request";
        for (const script of this.scriptsFor(details.url, ctxPhase)) {
            const handler = ctxPhase === "response" ? script.handlers.onResponseHeaders : script.handlers.onRequest;
            if (!handler) continue;
            try {
                const ctx = makeCtx(details, tabUrl);
                if (ctxPhase === "response") {
                    (ctx as any).statusLine = details.statusLine || "";
                    (ctx as any).responseHeaders = details.responseHeaders || [];
                }
                const result = handler(ctx);
                const mods = result?.headers;
                if (mods && (mods.set || mods.remove)) {
                    changes = changes || {};
                    changes.set = { ...changes.set, ...mods.set };
                    changes.remove = [...(changes.remove || []), ...(mods.remove || [])];
                }
            } catch (e: any) {
                scriptError(scriptIdOf(script), `header handler threw: ${e.message || e}`);
            }
        }
        return changes;
    }

    private wireFirefoxStream(details: WebRequestDetailsLike, script: CompiledScript, tabUrl: string | null): void {
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
                const ctx = { ...makeCtx(details, tabUrl), contentType: contentTypeOf(details.responseHeaders) };
                try {
                    const out = await script.handlers.modifyResponse!(ctx, body);
                    body = out === undefined || out === null ? body : out;
                } catch (e: any) {
                    scriptError(scriptIdOf(script), `modifyResponse threw: ${e.message || e}`);
                }
                const outBytes = typeof body === "string" ? encoder.encode(body) : body;
                filter.write(outBytes);
                filter.close();
            };
        } catch (e: any) {
            scriptError(scriptIdOf(script), `filterResponseData failed: ${e.message || e}`);
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

export function scriptIdOf(_s: CompiledScript): string {
    // CompiledScripts don't carry ids; logs use the script name instead.
    return "";
}

export function normalize(result: any): HookDisposition {
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

/** requestId → script awaiting a Firefox stream filter */
const pendingFirefoxStreams = new Map<string, CompiledScript>();
