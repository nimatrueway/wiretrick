/**
 * Blocking-webRequest strategy: Firefox and MV2-capable Chromium browsers
 * (ungoogled-chromium, Brave, Opera…). Redirect/block, request/response
 * headers and synchronous replaceResponse (handler or onRequest result) work everywhere with no
 * debugger involvement.
 *
 * Runs only handler routes whose strategy is "extension".
 *
 * How a replacement (a replaceResponse handler, or the onRequest `replaceResponse` result) is served:
 * - Firefox: in place — the request proceeds and filterResponseData swaps
 *   the body, so the URL is kept (the upstream status code is, too).
 * - Chromium: webRequest can't touch bodies, so the only way is a redirect —
 *   to a data: URL, or for page loads to the extension's serve.html (the
 *   address bar shows the extension URL and the page loses its origin).
 *   Neither can carry a status: non-200 replacements aren't served here.
 *
 * Response-body streaming (onResponseBody via filterResponseData) and
 * awaiting async handlers are Firefox-only. MV3 has no blocking webRequest
 * at all.
 */
import { recordNetBody } from "../../network";
import { isThenable, type Routed } from "../../../shared/compile";
import { effectiveStrategy, routeGroups, routeLabel, routeMatches, type RouteMeta } from "../../../shared/route";
import { formatScriptError } from "../../../shared/scriptError";
import type { HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log, logObserved, noteBodySkip, scriptError } from "../logs";
import { bodyKind } from "../../../shared/bodyKind";
import { dlogLevel } from "../../../shared/debugLog";
import { IS_FIREFOX } from "./helperState";
import { compileMv2, ownsAny } from "./strategyScripts";
import { HeaderStack, mergeHeaderEdits, overrideLine, type Who, type Winner } from "../../../shared/precedence";
import { makeMissedThrottle } from "../../../shared/missedTap";
import { reportSkipped } from "../skipped";

type Kind = "onRequest" | "onResponseHeaders" | "replaceResponse" | "onResponseBody";

/** a script's webrequest-owned handlers (each with its route) */
interface Entry {
    id: string;
    name: string;
    handlers: Record<Kind, Routed[]>;
}

const KINDS: Kind[] = ["onRequest", "onResponseHeaders", "replaceResponse", "onResponseBody"];

export class ExtensionStrategy implements InterceptionStrategy {
    readonly name = "extension";

    private entries: Entry[] = [];

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        // MV3: no blocking webRequest — the pipeline warns per handler (strategyUnavailable)
        if (__MV3__) {
            this.entries = [];
            return;
        }
        this.entries = compileMv2(scripts, paramValues, (s) => ownsAny(s, "extension")).map(({ id, name, compiled }) => {
            // a compile error is a problem (Problems view), not a Log line
            const handlers = {} as Record<Kind, Routed[]>;
            for (const k of KINDS) handlers[k] = compiled.handlers[k].filter((h) => effectiveStrategy(h.route) === "extension");
            dlogLevel("extension", "debug", `loaded "${name}" routes: ${KINDS.flatMap((k) => handlers[k].map((h) => `${routeLabel(h.route)} ${JSON.stringify(h.route.url)}`)).join(", ") || "none"}${compiled.error ? ` ERROR: ${compiled.error}` : ""}`);
            return { id, name, handlers };
        });
    }

    /** names of the scripts this strategy runs for `url` (diagnostics) */
    matchingNames(url: string): string[] {
        return this.entries.filter((e) => KINDS.some((k) => e.handlers[k].some((h) => routeMatches(h.route, url)))).map((e) => e.name);
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

    /** the entry's `kind` handlers whose route matches this request */
    private hits(e: Entry, kind: Kind, details: WebRequestDetailsLike): Routed[] {
        return e.handlers[kind].filter((h) => routeMatches(h.route, details.url, details.method, details.type));
    }

    /**
     * Same order as every strategy (precedence.ts): every script's onRequest,
     * then every replaceResponse; the first final result ends it. Firefox
     * awaits async handlers in place and carries on with the rest.
     */
    handleBeforeRequest(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HookDisposition> {
        const matched = this.entries.filter((e) => KINDS.some((k) => this.hits(e, k, details).length));
        if (!matched.length) return { kind: "allow" };
        trace(details, `onBeforeRequest ${details.type} ${details.method} ${details.url} (tab url: ${tabUrl ?? "unknown"}) → scripts: ${matched.map((m) => `"${m.name}"`).join(", ")}`);
        const steps: { entry: Entry; h: Routed; kind: "onRequest" | "replaceResponse" }[] = [];
        for (const kind of ["onRequest", "replaceResponse"] as const) {
            for (const entry of matched) for (const h of this.hits(entry, kind, details)) steps.push({ entry, h, kind });
        }
        const finish = (): HookDisposition => {
            // Firefox: stream via filterResponseData at onHeadersReceived time;
            // here we only mark the request so the header-phase hook wires the filter.
            // (Chromium can't read bodies here — the pipeline warns at load.)
            if (IS_FIREFOX) {
                for (const entry of matched) {
                    const transforms = this.hits(entry, "onResponseBody", details);
                    if (!transforms.length) continue;
                    const list = pendingFirefoxStreams.get(details.requestId)?.list ?? [];
                    list.push({ id: entry.id, name: entry.name, handlers: transforms });
                    pendingFirefoxStreams.set(details.requestId, { list, tabUrl });
                }
            }
            trace(details, `onBeforeRequest ${details.url} → allow (no final decision)`);
            return { kind: "allow" };
        };
        const run = (i: number): MaybePromise<HookDisposition> => {
            for (; i < steps.length; i++) {
                const step = steps[i];
                let result: any;
                try {
                    result = step.h.fn(ctxFor(details, tabUrl, step.h.route));
                } catch (e: any) {
                    scriptError(step.entry.id, formatScriptError(step.entry.name, e, step.kind));
                    continue;
                }
                if (isThenable(result)) {
                    if (!IS_FIREFOX) {
                        // Chrome: blocking webRequest cannot await — the result would be decided too late
                        scriptError(step.entry.id, `async ${routeLabel(step.h.route)}: Chrome's blocking webRequest cannot await. Return synchronously, or set strategy: "debugger" or "helper" on this route.`);
                        continue;
                    }
                    // Firefox blocking listeners accept promises natively
                    const next = i + 1;
                    return Promise.resolve(result).then(
                        (r) => this.decide(details, step, r) ?? run(next),
                        (e: any) => {
                            scriptError(step.entry.id, formatScriptError(step.entry.name, e, step.kind));
                            return run(next);
                        }
                    );
                }
                const d = this.decide(details, step, result);
                if (d) return d;
            }
            return finish();
        };
        return run(0);
    }

    /** one handler's result: a final disposition, or null to carry on */
    private decide(details: WebRequestDetailsLike, step: { entry: Entry; h: Routed; kind: "onRequest" | "replaceResponse" }, result: any): HookDisposition | null {
        const { entry, h } = step;
        const who: Who = { scriptId: entry.id, scriptName: entry.name, kind: step.kind, index: h.route.index };
        const final = (d: HookDisposition, outcome: Winner["outcome"], target?: string): HookDisposition => {
            // not served (e.g. a non-200 replacement on webRequest): nothing took priority
            if (d.kind !== "allow" || pendingFirefoxReplace.has(details.requestId)) {
                reportSkipped(details.tabId, { url: details.url, method: details.method, type: details.type }, { ...who, strategy: "extension", outcome, target });
            }
            return d;
        };
        if (step.kind === "replaceResponse") {
            if (result === undefined || result === null) {
                logObserved(details.tabId, entry.name, "replaceResponse", details.url, entry.id);
                return null;
            }
            const d = this.replace(details, result, entry.id, entry.name);
            return d.kind === "allow" && !pendingFirefoxReplace.has(details.requestId) ? null : final(d, "replace");
        }
        const hasHeaders = !!(result && result.headers && (result.headers.set || result.headers.remove));
        if (hasHeaders) {
            log(details.tabId, `[${entry.name}] onRequest → request headers (${describeHeaderMods(result.headers)}) ${details.url}`, "info", entry.id);
            // cached so onBeforeSendHeaders doesn't re-run the handler; the later handler wins per header
            const stack = pendingRequestHeaderMods.get(details.requestId) ?? new HeaderStack();
            for (const o of stack.add(result.headers, who)) {
                if (overrideThrottle(`${o.header}|${o.by.scriptId}|${o.by.index}|${o.over.scriptId}|${o.over.index}`)) log(details.tabId, overrideLine(o, "request", details.url), "warn", entry.id);
            }
            pendingRequestHeaderMods.set(details.requestId, stack);
        }
        if (result && result.replaceResponse) {
            const d = this.replaceFromRequest(details, result.replaceResponse, entry);
            return d.kind === "allow" && !pendingFirefoxReplace.has(details.requestId) ? null : final(d, "replace");
        }
        if (result && (result.redirect || result.block)) {
            log(details.tabId, `[${entry.name}] onRequest → ${result.block ? `block ${details.url}` : `redirect ${details.url} → ${result.redirect}`}`, "info", entry.id);
            return final(normalize(result), result.block ? "block" : "redirect", result.block ? undefined : result.redirect);
        }
        trace(details, `[${entry.name}] onRequest returned ${describeResult(result)} (no redirect/block/replaceResponse) for ${details.url}`);
        if (!hasHeaders) logObserved(details.tabId, entry.name, "onRequest", details.url, entry.id);
        return null;
    }

    handleBeforeSendHeaders(details: WebRequestDetailsLike, _tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        // request-phase header mods were computed once in handleBeforeRequest
        const cached = pendingRequestHeaderMods.get(details.requestId);
        return cached && !cached.empty ? cached.result() : null;
    }

    handleHeadersReceived(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        // Firefox in-place replacement: swap the body, fix the headers to match
        const rep = pendingFirefoxReplace.get(details.requestId);
        if (rep && IS_FIREFOX && !isRedirectStatus(details.statusCode)) {
            // a replacement is final: no onResponseHeaders/onResponseBody on it
            pendingFirefoxReplace.delete(details.requestId);
            pendingFirefoxStreams.delete(details.requestId);
            this.wireFirefoxReplace(details, rep);
            return mergeReplacementHeaders(null, replacementHeaders(rep.mime, rep.content));
        }
        const changes = this.responseHeaderChanges(details, tabUrl);
        // Firefox streaming: wire the filter when response headers arrive.
        const pending = pendingFirefoxStreams.get(details.requestId);
        if (pending && IS_FIREFOX && !isRedirectStatus(details.statusCode)) {
            pendingFirefoxStreams.delete(details.requestId);
            // a binary Content-Type with no `binary: true` route: don't buffer it at all
            const ct = contentTypeOf(details.responseHeaders) || "";
            const binaryOk = pending.list.some((e) => e.handlers.some((h) => h.route.binary));
            if (bodyKind(ct, null) === "binary" && !binaryOk) {
                noteBodySkip("extension", details.url, "binary", ct);
                trace(details, `binary body (${ct}), no binary: true route — onResponseBody skipped ${details.url}`);
            } else this.wireFirefoxStream(details, pending.list, pending.tabUrl ?? tabUrl);
        }
        return changes;
    }

    dispose(): void {
        this.entries = [];
    }

    /** onRequest `replaceResponse` result: 200 only (neither a redirect nor a stream filter carries a status) */
    private replaceFromRequest(details: WebRequestDetailsLike, rep: any, entry: { id: string; name: string }): HookDisposition {
        const body = serializeRespondBody(rep.body);
        const mime = rep.mime || guessMime(null, details.url, "application/json");
        const status = rep.status ?? 200;
        if (status !== 200) {
            log(details.tabId, `[${entry.name}] onRequest → replaceResponse ${status} not served: webRequest can't set a response status (only 200) — set strategy: "debugger" or "helper" on this route ${details.url}`, "warn", entry.id);
            return { kind: "allow" };
        }
        if (IS_FIREFOX) return this.firefoxReplaceLater(details, body, mime, entry.id, entry.name, "onRequest");
        log(details.tabId, `[${entry.name}] onRequest → replaceResponse 200 ${mime} (${body.length}b) ${details.url}`, "info", entry.id);
        return this.redirectServe(details, body, mime);
    }

    /** A replaceResponse result: in place on Firefox, by redirect on Chromium. */
    private replace(details: WebRequestDetailsLike, replacement: any, scriptId: string, scriptName: string): HookDisposition {
        const r = replacementContent(details, replacement);
        if (!r) return { kind: "allow" };
        if (IS_FIREFOX) return this.firefoxReplaceLater(details, r.content, r.mime, scriptId, scriptName, "replaceResponse");
        log(details.tabId, `[${scriptName}] replaceResponse → ${r.mime} (${r.content.length} bytes) ${details.url}`, "info", scriptId);
        return this.redirectServe(details, r.content, r.mime);
    }

    /**
     * Chromium only: webRequest can't write a body, so the replacement is
     * served by redirecting — the URL changes (see the header comment).
     */
    private redirectServe(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string): HookDisposition {
        recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, modified: content, mime, status: 200 });
        // Chrome blocks top-level data: navigations — serve main frames from an extension page instead
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
    private firefoxReplaceLater(details: WebRequestDetailsLike, content: string | Uint8Array, mime: string, scriptId: string, scriptName: string, via: "replaceResponse" | "onRequest"): HookDisposition {
        pendingFirefoxReplace.set(details.requestId, { content, mime, scriptId, scriptName, via });
        return { kind: "allow" };
    }

    private wireFirefoxReplace(details: WebRequestDetailsLike, rep: FirefoxReplacement): void {
        const what = rep.via === "onRequest" ? `onRequest → replaceResponse 200 ${rep.mime} (${rep.content.length}b)` : `replaceResponse → ${rep.mime} (${rep.content.length} bytes)`;
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

    /** onResponseHeaders in list order; the later handler wins per header. Firefox awaits async ones in place. */
    private responseHeaderChanges(details: WebRequestDetailsLike, tabUrl: string | null): MaybePromise<HeaderChanges | null> {
        const steps: { entry: Entry; h: Routed }[] = [];
        for (const entry of this.entries) for (const h of this.hits(entry, "onResponseHeaders", details)) steps.push({ entry, h });
        if (!steps.length) return null;
        const stack = new HeaderStack();
        const apply = ({ entry, h }: { entry: Entry; h: Routed }, result: any) => {
            const mods = result?.headers;
            if (!(mods && (mods.set || mods.remove))) return logObserved(details.tabId, entry.name, "onResponseHeaders", details.url, entry.id);
            log(details.tabId, `[${entry.name}] onResponseHeaders → ${describeHeaderMods(mods)} ${details.url}`, "info", entry.id);
            for (const o of stack.add(mods, { scriptId: entry.id, scriptName: entry.name, kind: "onResponseHeaders", index: h.route.index })) {
                if (overrideThrottle(`r|${o.header}|${o.by.scriptId}|${o.by.index}|${o.over.scriptId}|${o.over.index}`)) log(details.tabId, overrideLine(o, "response", details.url), "warn", entry.id);
            }
        };
        const done = (): HeaderChanges | null => (stack.empty ? null : stack.result());
        const run = (i: number): MaybePromise<HeaderChanges | null> => {
            for (; i < steps.length; i++) {
                const step = steps[i];
                let result: any;
                try {
                    const ctx = ctxFor(details, tabUrl, step.h.route);
                    (ctx as any).statusLine = details.statusLine || "";
                    (ctx as any).responseHeaders = details.responseHeaders || [];
                    result = step.h.fn(ctx);
                } catch (e: any) {
                    scriptError(step.entry.id, formatScriptError(step.entry.name, e, "onResponseHeaders"));
                    continue;
                }
                if (isThenable(result)) {
                    if (!IS_FIREFOX) {
                        scriptError(step.entry.id, `async ${routeLabel(step.h.route)}: Chrome's blocking webRequest cannot await. Return synchronously, or set strategy: "debugger" or "helper" on this route.`);
                        continue;
                    }
                    const next = i + 1;
                    return Promise.resolve(result).then(
                        (r) => (apply(step, r), run(next)),
                        (e: any) => (scriptError(step.entry.id, formatScriptError(step.entry.name, e, "onResponseHeaders")), run(next))
                    );
                }
                apply(step, result);
            }
            return done();
        };
        return run(0);
    }

    private wireFirefoxStream(details: WebRequestDetailsLike, list: StreamEntry[], tabUrl: string | null): void {
        const first = list[0];
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
                // text → string; binary → bytes, to `binary: true` routes only
                const contentType = contentTypeOf(details.responseHeaders);
                const binary = bodyKind(contentType, bytes) === "binary";
                let body: string | Uint8Array = binary ? bytes : decoder.decode(bytes);
                const original = body;
                if (binary && !list.some((e) => e.handlers.some((h) => h.route.binary))) noteBodySkip("extension", details.url, "binary", contentType || "");
                for (const { id: scriptId, name: scriptName, handlers } of list) for (const h of handlers) {
                    if (binary && !h.route.binary) continue;
                    const ctx = { ...ctxFor(details, tabUrl, h.route), contentType };
                    // a text body an earlier binary route returned as bytes is still text here
                    if (typeof body !== "string" && !h.route.binary) body = decoder.decode(body);
                    try {
                        const out = await h.fn(ctx, body);
                        if (out !== undefined && out !== null && out !== body) {
                            const size = (b: any) => (typeof b === "string" ? b.length : (b?.byteLength ?? 0));
                            log(details.tabId, `[${scriptName}] onResponseBody applied (${size(body)}b → ${size(out)}b) ${details.url}`, "info", scriptId);
                            body = out;
                        } else logObserved(details.tabId, scriptName, "onResponseBody", details.url, scriptId);
                    } catch (e: any) {
                        scriptError(scriptId, formatScriptError(scriptName, e, "onResponseBody"));
                    }
                }
                const outBytes = typeof body === "string" ? encoder.encode(body) : body;
                recordNetBody({ tabId: details.tabId, url: details.url, method: details.method, original, modified: body === original ? null : body });
                filter.write(outBytes);
                filter.close();
            };
        } catch (e: any) {
            scriptError(first.id, formatScriptError(first.name, e, "filterResponseData"));
        }
    }
}

// ---- shared helpers ----

/** request-level diagnostics: visible in the LOG panel at logLevel: debug */
function trace(details: WebRequestDetailsLike, msg: string): void {
    log(details.tabId, `[extension] ${msg}`, "debug");
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

/** ctx for a matched route: + `groups` (named URL-pattern captures) */
function ctxFor(details: WebRequestDetailsLike, tabUrl: string | null, route: RouteMeta): any {
    return { ...makeCtx(details, tabUrl), groups: routeGroups(route, details.url) };
}

export function normalize(result: any): HookDisposition {
    if (result.replaceResponse) return { kind: "respond", serve: result.replaceResponse } as any;
    if (result.block) return { kind: "cancel" };
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

/** in-memory store for main-frame served replacements */
export const serveStore = new Map<string, { content: string; mime: string }>();

function serializeRespondBody(body: any): string | Uint8Array {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return body;
    return JSON.stringify(body);
}

/** Merge stacked header mods: the later edit wins per header (set or remove). */
export function mergeHeaderMods(base: HeaderChanges | undefined, add: HeaderChanges): HeaderChanges {
    return mergeHeaderEdits(base, add);
}

const overrideThrottle = makeMissedThrottle();

interface FirefoxReplacement {
    content: string | Uint8Array;
    mime: string;
    scriptId: string;
    scriptName: string;
    via: "replaceResponse" | "onRequest";
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
    // any other object is a JSON body (as on the other strategies)
    if (replacement && typeof replacement === "object" && !ArrayBuffer.isView(replacement)) {
        return { mime: guessMime(null, details.url, "application/json"), content: JSON.stringify(replacement) };
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

interface StreamEntry {
    id: string;
    name: string;
    handlers: Routed[];
}

/** requestId → the onResponseBody handlers awaiting a Firefox stream filter */
const pendingFirefoxStreams = new Map<string, { list: StreamEntry[]; tabUrl: string | null }>();

/** requestId → request header mods already computed by onRequest (issue: run once) */
const pendingRequestHeaderMods = new Map<string, HeaderStack>();
