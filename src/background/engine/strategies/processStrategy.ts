/**
 * Tier P: the "process" strategy — a local helper (rescript-helper, Rust)
 * is a loopback MITM proxy that Chrome reaches through a PAC
 * (processRouting.ts) for the hosts of process-owned scripts only. It
 * pauses matching requests CDP-Fetch style over native messaging; this
 * class runs the scripts' handlers and answers continue / fulfill /
 * redirect / fail. No debugger, no banner, every handler kind (sync and
 * async), every resource type (documents, scripts, images, workers...).
 *
 * Handler chains share src/shared/bodyOps.ts with the hook and debugger
 * tiers: MV2 compiles in the background page, MV3 runs in the sandbox.
 */
import { compileScript, makeModuleResolver, makeScriptOverrides } from "../../../shared/compile";
import { runOp, type BodyOp, type OpScript } from "../../../shared/bodyOps";
import { hostPatternOf, type SystemProxyInfo } from "../../../shared/pac";
import { matchAny } from "../../../shared/matcher";
import { dlogLevel } from "../../../shared/debugLog";
import type { Script } from "../scriptStore";
import { scriptStorageGet, scriptStorageSet } from "../scriptStore";
import { log } from "../logs";
import { analyzeScripts, evalProxyDecision, runBodyOp } from "../../compileHost";
import { ProcessRouting } from "../../processRouting";
import { listsProcess, setProcessActive } from "./processState";

export const NM_HOST = "com.rescript_override.helper";

type Pairs = [string, string][];

interface Owned {
    id: string;
    name: string;
    match: string[];
    req: boolean;
    resHeaders: boolean;
    body: boolean;
}

interface HelperReady {
    port: number;
    version: string;
    caPem: string;
    caFingerprint: string;
    caPath: string;
}

export interface ProcessStatus {
    state: "idle" | "unsupported" | "connecting" | "ready" | "missing" | "error";
    extensionId: string;
    /** process-listed scripts (names) */
    scripts: string[];
    version?: string;
    port?: number;
    caPath?: string;
    caFingerprint?: string;
    /** null = not probed yet */
    caTrusted?: boolean | null;
    routing?: { active: boolean; reason?: string; mode?: string; note?: string };
    error?: string;
    trust?: { ok: boolean; msg: string };
}

const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" && typeof (globalThis as any).browser.webRequest?.filterResponseData === "function";

// ---- small helpers (exported for tests) ----

export function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any);
    return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** no NUL in the first 512 bytes → treat as text */
export function looksTextual(b: Uint8Array): boolean {
    const n = Math.min(b.length, 512);
    for (let i = 0; i < n; i++) if (b[i] === 0) return false;
    return true;
}

/** lowercased name → value (duplicates joined like fetch's Headers) */
export function pairsToObject(pairs: Pairs): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of pairs) {
        const n = k.toLowerCase();
        out[n] = n in out ? `${out[n]}, ${v}` : v;
    }
    return out;
}

/** apply {set, remove} header changes to a pair list (case-insensitive) */
export function applyHeaderMods(pairs: Pairs, mods: { set?: Record<string, any>; remove?: string[] } | null | undefined): Pairs {
    if (!mods) return pairs;
    const set = mods.set || {};
    const drop = new Set([...(mods.remove || []), ...Object.keys(set)].map((n) => n.toLowerCase()));
    const out: Pairs = pairs.filter(([k]) => !drop.has(k.toLowerCase()));
    for (const [k, v] of Object.entries(set)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const x of v) out.push([k, String(x)]);
        else out.push([k, String(v)]);
    }
    return out;
}

function withNoStore(pairs: Pairs): Pairs {
    return [...pairs.filter(([k]) => !/^(cache-control|expires|etag|last-modified)$/i.test(k)), ["cache-control", "no-store"]];
}

/** webRequest filter URLs for a set of star patterns (valid match patterns only) */
export function filterUrlsFor(patterns: string[]): string[] {
    const out = new Set<string>();
    for (const p of patterns) {
        const host = hostPatternOf(p);
        // valid match-pattern hosts: "*", "*.x.y", or a plain host (no ports, no inner stars)
        if (host === null || !/^(\*|(\*\.)?[a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?$/i.test(host)) return ["<all_urls>"];
        out.add(`*://${host.replace(/:\d+$/, "")}/*`);
    }
    return [...out];
}

/**
 * Request context (tabId / resourceType / tabUrl) for helper pauses:
 * an observe-only webRequest listener, registered for the routed hosts
 * only, correlated by method + url.
 */
class RequestContext {
    private recent = new Map<string, { tabId: number; type: string; tabUrl: string; at: number }>();
    private tabUrls = new Map<number, string>();
    private listener: ((d: any) => void) | null = null;
    private urls = "";

    watch(patterns: string[]): void {
        const urls = patterns.length ? filterUrlsFor(patterns) : [];
        const key = JSON.stringify(urls);
        if (key === this.urls) return;
        this.urls = key;
        if (this.listener) chrome.webRequest.onBeforeRequest.removeListener(this.listener);
        this.listener = null;
        if (!urls.length) return;
        this.listener = (d: any) => {
            if (d.type === "main_frame") this.tabUrls.set(d.tabId, d.url);
            const tabUrl = d.type === "main_frame" ? d.url : this.tabUrls.get(d.tabId) || d.documentUrl || d.initiator || "";
            this.recent.set(`${d.method} ${d.url}`, { tabId: d.tabId, type: d.type, tabUrl, at: Date.now() });
            if (this.recent.size > 2000) {
                const cutoff = Date.now() - 60_000;
                for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
            }
        };
        try {
            chrome.webRequest.onBeforeRequest.addListener(this.listener, { urls });
        } catch (e: any) {
            dlogLevel("process", "warn", `request-context listener failed: ${e?.message || e}`);
        }
    }

    lookup(method: string, url: string): { tabId: number; type: string; tabUrl: string } {
        const hit = this.recent.get(`${method} ${url}`);
        return hit ? { tabId: hit.tabId, type: hit.type, tabUrl: hit.tabUrl } : { tabId: -1, type: "other", tabUrl: "" };
    }

    forgetTab(tabId: number): void {
        this.tabUrls.delete(tabId);
    }
}

export class ProcessStrategy {
    /** hook-tier claims (page fetch/XHR it already handled) — wired by background.ts */
    isClaimed: (url: string) => boolean = () => false;
    /** status changes (manager UI) */
    onStatus: (s: ProcessStatus) => void = () => {};

    private routing = new ProcessRouting();
    private ctx = new RequestContext();
    private port: chrome.runtime.Port | null = null;
    private helper: HelperReady | null = null;
    private system: SystemProxyInfo | null = null;
    private owned: Owned[] = [];
    private mv2Ops: OpScript[] = [];
    private mv3Plain: { id: string; name: string; code: string; updatedAt: number; enabled: boolean }[] = [];
    private mv3Params: { [scriptId: string]: Record<string, any> } = {};
    private decisionSource = `function __resUser() { return "DIRECT"; }`;
    private chunks = new Map<number, string[]>();
    private loaded: Promise<void> = Promise.resolve();
    private state: ProcessStatus["state"] = "idle";
    private error: string | undefined;
    private caTrusted: boolean | null = null;
    private trust: ProcessStatus["trust"];
    private backoff = 1000;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private pushing: Promise<void> = Promise.resolve();

    constructor() {
        this.routing.onLost = () => {
            setProcessActive(false);
            this.emit();
        };
    }

    // ---- lifecycle ----

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        this.loaded = this.load(scripts, paramValues || {}).catch((e: any) => {
            dlogLevel("process", "error", `process tier reload failed: ${e?.message || e}`);
        });
    }

    private async load(scripts: Script[], paramValues: { [scriptId: string]: Record<string, any> }): Promise<void> {
        const listed = scripts.filter((s) => s.enabled && s.meta.declared && listsProcess(s.meta.strategy));
        if (IS_FIREFOX || typeof (chrome.runtime as any).connectNative !== "function") {
            this.owned = [];
            this.state = listed.length ? "unsupported" : "idle";
            if (listed.length) dlogLevel("process", "info", `process tier is Chrome-only — ${listed.map((s) => `"${s.meta.name}"`).join(", ")} fall through their strategy lists`);
            return;
        }
        const owned: Owned[] = [];
        if (__MV3__) {
            this.mv3Plain = scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: s.enabled }));
            this.mv3Params = paramValues;
            const analyzed = listed.length ? await analyzeScripts(scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt }))) : new Map();
            for (const s of listed) {
                const a = analyzed.get(s.id);
                const h = a?.handlers ?? { onRequest: 1, modifyResponse: 1, replaceResponse: 1, onResponseHeaders: 1 };
                const o = ownedOf(s.id, s.meta.name, s.meta.match, a?.meta?.phase || s.meta.phase, h);
                if (o) owned.push(o);
            }
        } else {
            let resolveSpec: (spec: string) => any = (spec) => {
                throw new Error(`cannot import "${spec}" before the module registry is ready`);
            };
            const overridesFor = (s: { id: string; name: string; code: string }) =>
                makeScriptOverrides(s.id, { get: scriptStorageGet, set: scriptStorageSet }, (id, msg) => log(-1, `[${s.name}] res.log: ${msg}`, "info", id), (id, level, msg) => log(-1, `[${s.name}] console.log: ${msg}`, level, id), paramValues[s.id], (spec) => resolveSpec(spec));
            resolveSpec = makeModuleResolver(
                scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code })),
                overridesFor
            ).resolve;
            const ops: OpScript[] = [];
            for (const s of listed) {
                const c = compileScript(s.code, overridesFor({ id: s.id, name: s.meta.name, code: s.code }));
                if (!c.meta.declared) continue;
                const o = ownedOf(s.id, s.meta.name, s.meta.match, c.meta.phase, {
                    onRequest: c.handlers.onRequest.length,
                    modifyResponse: c.handlers.modifyResponse.length,
                    replaceResponse: c.handlers.replaceResponse.length,
                    onResponseHeaders: c.handlers.onResponseHeaders.length,
                });
                if (!o) continue;
                owned.push(o);
                ops.push({ id: s.id, name: s.meta.name, match: s.meta.match, phase: c.meta.phase, handlers: c.handlers });
            }
            this.mv2Ops = ops;
        }
        this.owned = owned;
        this.ctx.watch(owned.flatMap((o) => o.match));
        if (!owned.length) {
            this.disconnect();
            return;
        }
        if (!this.port) this.connect();
        else if (this.helper) await this.pushConfig();
    }

    /** reconnect now (manager "Retry" after installing the helper) */
    reconnect(): void {
        this.backoff = 1000;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (!this.owned.length) return;
        if (this.port) return;
        this.connect();
    }

    private connect(): void {
        this.state = "connecting";
        this.error = undefined;
        this.emit();
        let port: chrome.runtime.Port;
        try {
            port = chrome.runtime.connectNative(NM_HOST);
        } catch (e: any) {
            this.state = "error";
            this.error = String(e?.message || e);
            this.emit();
            return;
        }
        this.port = port;
        port.onMessage.addListener((m: any) => this.onMessage(m));
        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError?.message || "helper exited";
            if (this.port !== port) return;
            this.port = null;
            this.helper = null;
            this.chunks.clear();
            setProcessActive(false);
            void this.routing.clear();
            if (!this.owned.length) {
                this.state = "idle";
                this.emit();
                return;
            }
            if (/not found|forbidden/i.test(err)) {
                // not installed / not allowed for this extension id: wait for the user
                this.state = "missing";
                this.error = err;
                dlogLevel("process", "warn", `process helper unavailable (${err}) — process-listed scripts fall through their strategy lists. Install it: rescript-helper install --extension-id ${chrome.runtime.id} --trust-ca`);
            } else {
                this.state = "error";
                this.error = err;
                dlogLevel("process", "warn", `process helper disconnected (${err}) — reconnecting in ${this.backoff / 1000}s`);
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    if (!this.port && this.owned.length) this.connect();
                }, this.backoff);
                this.backoff = Math.min(this.backoff * 2, 60_000);
            }
            this.emit();
        });
    }

    private disconnect(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const p = this.port;
        this.port = null;
        this.helper = null;
        this.chunks.clear();
        try {
            p?.disconnect(); // the helper exits when its stdin closes
        } catch {
            /* already gone */
        }
        setProcessActive(false);
        void this.routing.clear();
        this.state = "idle";
        this.error = undefined;
        this.emit();
    }

    /** push routes + upstream mode to the helper, then (re)install the PAC */
    private pushConfig(): Promise<void> {
        this.pushing = this.pushing.then(async () => {
            const helper = this.helper;
            if (!helper || !this.port) return;
            const routes = this.owned.map((o) => ({ match: o.match, req: o.req, resHeaders: o.resHeaders, body: o.body }));
            const d = await this.routing.decision(this.system);
            if (!d.ok) {
                this.send({ t: "config", routes: [], upstream: "direct" });
                await this.routing.clear();
                this.routing.status = { active: false, reason: d.reason };
                setProcessActive(false);
                dlogLevel("process", "warn", `process tier inactive: ${d.reason}`);
                this.emit();
                return;
            }
            this.decisionSource = d.decision.source;
            // routes first: the helper must know them before traffic arrives
            this.send({ t: "config", routes, upstream: d.decision.upstream });
            const applied = await this.routing.apply(helper.port, this.owned.flatMap((o) => o.match), this.system);
            setProcessActive(applied.ok);
            if (applied.ok && applied.decision.note) dlogLevel("process", "warn", applied.decision.note);
            this.emit();
            if (applied.ok) void this.probe();
        });
        return this.pushing;
    }

    private async probe(): Promise<void> {
        const ok = await this.routing.probe();
        if (ok !== this.caTrusted) {
            this.caTrusted = ok;
            if (!ok) dlogLevel("process", "warn", `Chrome does not trust the helper's CA yet — intercepted HTTPS sites will show certificate errors. Run: rescript-helper trust-ca (or use "Trust CA" in the manager)`);
            this.emit();
        }
    }

    trustCa(): void {
        this.send({ t: "trustCa" });
    }

    forgetTab(tabId: number): void {
        this.ctx.forgetTab(tabId);
    }

    status(): ProcessStatus {
        return {
            state: this.state,
            extensionId: chrome.runtime.id,
            scripts: this.owned.map((o) => o.name),
            version: this.helper?.version,
            port: this.helper?.port,
            caPath: this.helper?.caPath,
            caFingerprint: this.helper?.caFingerprint,
            caTrusted: this.helper ? this.caTrusted : undefined,
            routing: this.routing.status,
            error: this.error,
            trust: this.trust,
        };
    }

    private emit(): void {
        try {
            this.onStatus(this.status());
        } catch {
            /* ui gone */
        }
    }

    private send(msg: any): void {
        try {
            this.port?.postMessage(msg);
        } catch (e: any) {
            dlogLevel("process", "warn", `helper send failed: ${e?.message || e}`);
        }
    }

    // ---- helper → extension ----

    private onMessage(m: any): void {
        switch (m?.t) {
            case "ready":
                this.helper = { port: m.port, version: m.version, caPem: m.caPem, caFingerprint: m.caFingerprint, caPath: m.caPath };
                this.state = "ready";
                this.error = undefined;
                this.backoff = 1000;
                this.caTrusted = null;
                dlogLevel("process", "info", `process helper ${m.version} ready on 127.0.0.1:${m.port}`);
                void this.loaded.then(() => this.pushConfig());
                return;
            case "system":
                this.system = { http: m.http, https: m.https, socks: m.socks, bypass: m.bypass || [], pacUrl: m.pacUrl };
                if (this.helper) void this.pushConfig();
                return;
            case "chunk": {
                const list = this.chunks.get(m.id);
                if (list) list.push(m.data);
                else this.chunks.set(m.id, [m.data]);
                return;
            }
            case "req":
                void this.onReq(m).catch((e) => this.fallback(m.id, "request", e));
                return;
            case "res":
                void this.onRes(m).catch((e) => this.fallback(m.id, "response", e));
                return;
            case "needUpstream":
                void evalProxyDecision(this.decisionSource, m.url, m.host)
                    .catch(() => "DIRECT")
                    .then((proxy) => this.send({ t: "upstream", id: m.id, proxy }));
                return;
            case "trustResult":
                this.trust = { ok: !!m.ok, msg: String(m.msg || "") };
                dlogLevel("process", m.ok ? "info" : "warn", `trust CA: ${m.msg}`);
                this.caTrusted = null;
                this.emit();
                void this.probe();
                return;
            case "log":
                dlogLevel("process", m.level === "warn" || m.level === "error" ? m.level : m.level === "debug" ? "debug" : "info", `[helper] ${m.msg}`);
                return;
        }
    }

    private fallback(id: number, stage: string, e: any): void {
        dlogLevel("process", "error", `process ${stage} handling failed: ${e?.message || e}`);
        this.chunks.delete(id);
        this.send({ t: "continue", id });
    }

    private run(op: BodyOp, args: any): Promise<any> {
        args.onlyIds = this.owned.map((o) => o.id);
        if (__MV3__) return runBodyOp(this.mv3Plain, this.mv3Params, op, args);
        return runOp(this.mv2Ops, op, args, {
            log: (scriptId, level, msg) => log(args.tabId ?? -1, `[process] ${msg}`, level, scriptId),
            debug: (msg) => dlogLevel("process", "debug", msg),
        });
    }

    private matching(url: string, flag: "req" | "resHeaders" | "body"): boolean {
        return this.owned.some((o) => o[flag] && matchAny(o.match, url));
    }

    private async onReq(m: { id: number; url: string; method: string; headers: Pairs }): Promise<void> {
        await this.loaded;
        if (this.isClaimed(m.url) || !this.matching(m.url, "req")) {
            this.send({ t: "continue", id: m.id });
            return;
        }
        const c = this.ctx.lookup(m.method, m.url);
        const args = { url: m.url, method: m.method, tabId: c.tabId, resourceType: c.type, tabUrl: c.tabUrl, requestHeaders: pairsToObject(m.headers) };
        const dec = await this.run("requestDecision", args);
        if (dec?.kind === "respond") {
            const headers: Pairs = [["content-type", dec.mime]];
            for (const [k, v] of Object.entries(dec.headers || {})) headers.push([k, String(v)]);
            this.send({ t: "fulfill", id: m.id, status: dec.status || 200, headers: withNoStore(headers), body: bytesToBase64(new TextEncoder().encode(dec.content)) });
            return;
        }
        if (dec?.kind === "redirect") {
            this.send({ t: "redirect", id: m.id, url: dec.url });
            return;
        }
        if (dec?.kind === "cancel") {
            this.send({ t: "fail", id: m.id });
            return;
        }
        // replaceResponse runs here: no upstream round-trip for a replaced body
        const rep = await this.run("replace", { ...args });
        if (rep) {
            this.send({ t: "fulfill", id: m.id, status: 200, headers: withNoStore([["content-type", rep.mime]]), body: bytesToBase64(new TextEncoder().encode(rep.content)) });
            return;
        }
        if (dec?.kind === "headers") {
            this.send({ t: "continue", id: m.id, headers: applyHeaderMods(m.headers, dec.changes) });
            return;
        }
        this.send({ t: "continue", id: m.id });
    }

    private async onRes(m: { id: number; url: string; method: string; status: number; headers: Pairs; body: string }): Promise<void> {
        const parts = this.chunks.get(m.id) || [];
        this.chunks.delete(m.id);
        await this.loaded;
        if (this.isClaimed(m.url)) {
            this.send({ t: "continue", id: m.id });
            return;
        }
        const c = this.ctx.lookup(m.method, m.url);
        const reqHeaders = {};
        const base = { url: m.url, method: m.method, tabId: c.tabId, resourceType: c.type, tabUrl: c.tabUrl, requestHeaders: reqHeaders, status: m.status };
        let headers = m.headers;
        let headersChanged = false;
        if (this.matching(m.url, "resHeaders")) {
            const mods = await this.run("responseHeaders", { ...base, statusLine: `HTTP/1.1 ${m.status}`, responseHeaders: m.headers.map(([name, value]) => ({ name, value })) });
            if (mods) {
                headers = applyHeaderMods(headers, mods);
                headersChanged = true;
            }
        }
        if (m.body === "chunks" && this.matching(m.url, "body")) {
            const bytes = parts.length === 1 ? base64ToBytes(parts[0]) : concat(parts.map(base64ToBytes));
            const textual = looksTextual(bytes);
            let out: string | null = null;
            if (textual || !__MV3__) {
                const body: string | Uint8Array = textual ? new TextDecoder().decode(bytes) : bytes;
                out = await this.run("transform", { ...base, body, contentType: pairsToObject(headers)["content-type"] || "" });
            } else {
                dlogLevel("process", "debug", `binary body skipped for modifyResponse (MV3 passes text only): ${m.url}`);
            }
            if (out !== null && out !== undefined) {
                this.send({ t: "fulfill", id: m.id, status: m.status, headers: withNoStore(headers), body: bytesToBase64(new TextEncoder().encode(out)) });
                return;
            }
        } else if (m.body.startsWith("skipped:") && this.matching(m.url, "body")) {
            dlogLevel("process", "debug", `modifyResponse not run (${m.body.slice(8)}): ${m.url}`);
        }
        this.send(headersChanged ? { t: "continue", id: m.id, headers } : { t: "continue", id: m.id });
    }
}

function concat(list: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) {
        out.set(b, at);
        at += b.length;
    }
    return out;
}

export function ownedOf(
    id: string,
    name: string,
    match: string[],
    phase: string[] | undefined,
    h: { onRequest: number; modifyResponse: number; replaceResponse: number; onResponseHeaders: number }
): Owned | null {
    const ph = phase && phase.length ? phase : ["request", "response"];
    const req = (h.onRequest > 0 && ph.includes("request")) || (h.replaceResponse > 0 && ph.includes("response"));
    const resHeaders = h.onResponseHeaders > 0 && ph.includes("response");
    const body = h.modifyResponse > 0 && ph.includes("response");
    if (!req && !resHeaders && !body) return null;
    return { id, name, match, req, resHeaders, body };
}
