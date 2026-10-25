/**
 * The "helper" strategy — a local helper (wiretrick-helper, Rust)
 * is a loopback MITM proxy that Chrome reaches through a PAC
 * (helperRouting.ts) for the hosts of helper-owned routes only. It
 * pauses matching requests CDP-Fetch style over native messaging; this
 * class runs the scripts' handlers and answers continue / fulfill /
 * redirect / fail. No debugger, no banner, every handler kind (sync and
 * async), every resource type (documents, scripts, images, workers...).
 *
 * Handler chains share src/shared/bodyOps.ts with the page and debugger
 * strategies: MV2 compiles in the background page, MV3 runs in the sandbox.
 */
import { runOp, type BodyOp, type OpScript } from "../../../shared/bodyOps";
import { bodyKind, getTextTypes } from "../../../shared/bodyKind";
import { bytesToBase64, base64ToBytes } from "../../../shared/bytesPack";
import { hostPatternOf, type SystemProxyInfo } from "../../../shared/pac";
import { routeMatches, takesBinary, type RouteMeta } from "../../../shared/route";
import { dlogLevel } from "../../../shared/debugLog";
import { helperInstallCommand, helperInstallShell, isHelperOutdated, MIN_HELPER_VERSION } from "../../../shared/helperInstall";
import type { Script } from "../scriptStore";
import { log, noteHelperSkip } from "../logs";
import { reportSkipped } from "../skipped";
import { winnerOf } from "../../../shared/precedence";
import { evalProxyDecision, runBodyOp } from "../../compileHost";
import { recordNetBody } from "../../network";
import { ClaimCache, correlator } from "../requestCorrelator";
import { HelperRouting } from "../../helperRouting";
import { IS_FIREFOX, setHelperActive } from "./helperState";
import { compileMv2, ownedRoutes, ownsAny, type OwnedRoute } from "./strategyScripts";

export const NM_HOST = "com.wiretrick.helper";

type Pairs = [string, string][];

/** helper route JSON (helper/src/nm.rs Route): one per helper-owned handler route */
export interface HelperRoute {
    match: string[];
    exclude: string[];
    /** uppercase; [] = any */
    methods: string[];
    req: boolean;
    resHeaders: boolean;
    body: boolean;
    /** onResponseBody with `binary: true` / "both": the helper sends binary bodies too */
    binary: boolean;
}

type Flag = "req" | "resHeaders" | "body" | "binary";

/** what a route needs the helper to pause */
export function helperRouteOf(route: RouteMeta): HelperRoute {
    return {
        match: route.url,
        exclude: route.exclude,
        methods: route.methods ?? [],
        req: route.kind === "onRequest" || route.kind === "replaceResponse",
        resHeaders: route.kind === "onResponseHeaders",
        body: route.kind === "onResponseBody",
        binary: route.kind === "onResponseBody" && takesBinary(route),
    };
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
    /** scripts with helper-owned handlers (names) */
    scripts: string[];
    version?: string;
    /** the helper is older than MIN_HELPER_VERSION — reinstall it */
    outdated?: boolean;
    port?: number;
    caPath?: string;
    caFingerprint?: string;
    /** null = not probed yet */
    caTrusted?: boolean | null;
    routing?: { active: boolean; reason?: string; mode?: string; note?: string };
    error?: string;
    trust?: { ok: boolean; msg: string };
}

// ---- small helpers (exported for tests) ----

export { bytesToBase64, base64ToBytes };

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

/** webRequest filter URLs for a set of `match` URLPatterns (valid match patterns only) */
export function filterUrlsFor(patterns: string[]): string[] {
    const out = new Set<string>();
    for (const p of patterns) {
        const host = hostPatternOf(p);
        // valid match-pattern hosts: "*", "*.x.y", or a plain host (no ports, no inner stars)
        if (host === null || !/^(\*|(\*\.)?[a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+|:\*)?$/i.test(host)) return ["<all_urls>"];
        out.add(`*://${host.replace(/:(\d+|\*)$/, "")}/*`);
    }
    return [...out];
}

/** a helper pause's request: webRequest context + requestId (engine/requestCorrelator.ts) */
interface PauseContext {
    tabId: number;
    /** "" = unknown: route `resourceTypes` aren't checked (bodyOps) */
    type: string;
    tabUrl: string;
    requestId?: string;
}

export class HelperStrategy {
    /** status changes (manager UI) */
    onStatus: (s: ProcessStatus) => void = () => {};

    private routing = new HelperRouting();
    /**
     * helper message id → its webRequest request, claimed once per message.
     * The helper numbers a request's request and response pauses separately,
     * so each stage claims from its own FIFO.
     */
    private reqClaims = new ClaimCache<number>(correlator, "helper:req");
    private resClaims = new ClaimCache<number>(correlator, "helper:res");
    private port: chrome.runtime.Port | null = null;
    private helper: HelperReady | null = null;
    private system: SystemProxyInfo | null = null;
    private owned: OwnedRoute[] = [];
    private mv2Ops: OpScript[] = [];
    private mv3Plain: { id: string; name: string; code: string; updatedAt: number; enabled: boolean }[] = [];
    private mv3Params: { [scriptId: string]: Record<string, any> } = {};
    private decisionSource = `function __resUser() { return "DIRECT"; }`;
    private chunks = new Map<number, string[]>();
    private loaded: Promise<void> = Promise.resolve();
    private state: ProcessStatus["state"] = "idle";
    private error: string | undefined;
    private caTrusted: boolean | null = null;
    private warnedOutdated?: string;
    private trust: ProcessStatus["trust"];
    private backoff = 1000;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private pushing: Promise<void> = Promise.resolve();

    constructor() {
        this.routing.onLost = () => {
            setHelperActive(false);
            this.emit();
        };
    }

    // ---- lifecycle ----

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        this.loaded = this.load(scripts, paramValues || {}).catch((e: any) => {
            dlogLevel("helper", "error", `helper strategy reload failed: ${e?.message || e}`);
        });
    }

    private async load(scripts: Script[], paramValues: { [scriptId: string]: Record<string, any> }): Promise<void> {
        // routes come from the pipeline's analyzed meta (with real params)
        const owned = ownedRoutes(scripts, "helper");
        if (IS_FIREFOX || typeof (chrome.runtime as any).connectNative !== "function") {
            this.owned = [];
            this.state = owned.length ? "unsupported" : "idle";
            return;
        }
        if (__MV3__) {
            this.mv3Plain = scripts.map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: s.enabled }));
            this.mv3Params = paramValues;
        } else {
            this.mv2Ops = compileMv2(scripts, paramValues, (s) => ownsAny(s, "helper")).map((c) => ({ id: c.id, name: c.name, handlers: c.compiled.handlers }));
        }
        this.owned = owned;
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
        if (this.port) {
            // an outdated helper keeps running until we drop it; restart so a
            // freshly reinstalled binary gets spawned
            if (!this.helper || !isHelperOutdated(this.helper.version)) return;
            this.disconnect();
        }
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
            setHelperActive(false);
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
                dlogLevel("helper", "error", `local helper unavailable (${err}) — handlers using the "helper" strategy don't run until it is installed. Install it by pasting this into ${helperInstallShell()}: ${helperInstallCommand(chrome.runtime.id)}`);
            } else {
                this.state = "error";
                this.error = err;
                dlogLevel("helper", "warn", `local helper disconnected (${err}) — reconnecting in ${this.backoff / 1000}s`);
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
        setHelperActive(false);
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
            const routes = this.owned.map((o) => helperRouteOf(o.route));
            const d = await this.routing.decision(this.system);
            if (!d.ok) {
                this.send({ t: "config", routes: [], upstream: "direct", textTypes: getTextTypes() });
                await this.routing.clear();
                this.routing.status = { active: false, reason: d.reason };
                setHelperActive(false);
                dlogLevel("helper", "warn", `helper strategy inactive: ${d.reason}`);
                this.emit();
                return;
            }
            this.decisionSource = d.decision.source;
            // routes first: the helper must know them before traffic arrives
            this.send({ t: "config", routes, upstream: d.decision.upstream, textTypes: getTextTypes() });
            const applied = await this.routing.apply(helper.port, this.owned.flatMap((o) => o.route.url), this.system);
            setHelperActive(applied.ok);
            if (applied.ok && applied.decision.note) dlogLevel("helper", "warn", applied.decision.note);
            this.emit();
            if (applied.ok) void this.probe();
        });
        return this.pushing;
    }

    private async probe(): Promise<void> {
        const ok = await this.routing.probe();
        if (ok !== this.caTrusted) {
            this.caTrusted = ok;
            if (!ok) dlogLevel("helper", "warn", `Chrome does not trust the helper certificate yet — intercepted HTTPS sites will show certificate errors. Run: wiretrick-helper trust-ca (or use "Trust certificate" in the Editor)`);
            this.emit();
        }
    }

    trustCa(): void {
        this.send({ t: "trustCa" });
    }

    forgetTab(tabId: number): void {
        correlator.forgetTab(tabId);
    }

    status(): ProcessStatus {
        return {
            state: this.state,
            extensionId: chrome.runtime.id,
            scripts: [...new Set(this.owned.map((o) => o.name))],
            version: this.helper?.version,
            outdated: this.helper ? isHelperOutdated(this.helper.version) : undefined,
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
            dlogLevel("helper", "warn", `helper send failed: ${e?.message || e}`);
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
                dlogLevel("helper", "info", `local helper ${m.version} ready on 127.0.0.1:${m.port}`);
                if (isHelperOutdated(m.version) && this.warnedOutdated !== m.version) {
                    this.warnedOutdated = m.version;
                    dlogLevel(
                        "helper",
                        "error",
                        `local helper v${m.version} is older than this extension needs (v${MIN_HELPER_VERSION}+) — upgrade it by re-running this in ${helperInstallShell()}: ${helperInstallCommand(chrome.runtime.id)}`,
                    );
                }
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
                void this.onReq(m)
                    .catch((e) => this.fallback(m.id, "request", e))
                    .finally(() => this.reqClaims.forget(m.id));
                return;
            case "res":
                void this.onRes(m)
                    .catch((e) => this.fallback(m.id, "response", e))
                    .finally(() => this.resClaims.forget(m.id));
                return;
            case "needUpstream":
                void evalProxyDecision(this.decisionSource, m.url, m.host)
                    .catch(() => "DIRECT")
                    .then((proxy) => this.send({ t: "upstream", id: m.id, proxy }));
                return;
            case "trustResult":
                this.trust = { ok: !!m.ok, msg: String(m.msg || "") };
                dlogLevel("helper", m.ok ? "info" : "warn", `trust helper certificate: ${m.msg}`);
                this.caTrusted = null;
                this.emit();
                void this.probe();
                return;
            case "log":
                dlogLevel("helper", m.level === "warn" || m.level === "error" ? m.level : m.level === "debug" ? "debug" : "info", m.msg);
                return;
        }
    }

    private fallback(id: number, stage: string, e: any): void {
        dlogLevel("helper", "error", `process ${stage} handling failed: ${e?.message || e}`);
        this.chunks.delete(id);
        this.send({ t: "continue", id });
    }

    private run(op: BodyOp, args: any): Promise<any> {
        args.tier = "helper";
        if (__MV3__) return runBodyOp(this.mv3Plain, this.mv3Params, op, args);
        return runOp(this.mv2Ops, op, args, {
            log: (scriptId, level, msg, kind) => log(args.tabId ?? -1, `[helper] ${msg}`, level, scriptId, kind, undefined, args.requestId),
            debug: (msg) => dlogLevel("helper", "debug", msg),
        });
    }

    /** a process route wanting `flag` matches (resourceTypes: extension-side only — the helper can't see them) */
    private matching(url: string, method: string, type: string, flag: Flag): boolean {
        return this.owned.some((o) => helperRouteOf(o.route)[flag] && routeMatches(o.route, url, method, type || undefined));
    }

    /**
     * The webRequest request behind helper message `id`: the oldest pending
     * same method + URL request this stage hasn't claimed (a cache hit never
     * reaches the helper); unclaimed, the newest one's context only.
     */
    private context(m: { id: number; url: string; method: string }, stage: "req" | "res"): PauseContext {
        const r = (stage === "req" ? this.reqClaims : this.resClaims).claim(m.id, m.method, m.url, { pendingOnly: true });
        if (r) return { tabId: r.tabId, type: r.type, tabUrl: r.tabUrl, requestId: r.requestId };
        const hit = correlator.latest(m.method, m.url);
        return hit ? { tabId: hit.tabId, type: hit.type, tabUrl: hit.tabUrl } : { tabId: -1, type: "", tabUrl: "" };
    }

    private async onReq(m: { id: number; url: string; method: string; headers: Pairs }): Promise<void> {
        await this.loaded;
        const c = this.context(m, "req");
        if (!this.matching(m.url, m.method, c.type, "req")) {
            this.send({ t: "continue", id: m.id });
            return;
        }
        const args = { url: m.url, method: m.method, tabId: c.tabId, resourceType: c.type, tabUrl: c.tabUrl, requestHeaders: pairsToObject(m.headers), requestId: c.requestId };
        const dec = await this.run("requestDecision", args);
        const req = { url: m.url, method: m.method, type: c.type };
        reportSkipped(c.tabId, req, winnerOf(dec, "helper"), c.requestId);
        // answered here: no response pause will come for it
        if (c.requestId && (dec?.kind === "respond" || dec?.kind === "redirect" || dec?.kind === "cancel")) correlator.mark(c.requestId, "helper:res");
        if (dec?.kind === "respond") {
            recordNetBody({ tabId: c.tabId, url: m.url, method: m.method, modified: dec.content, mime: dec.mime, status: dec.status || 200, requestId: c.requestId });
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
            if (c.requestId) correlator.mark(c.requestId, "helper:res");
            reportSkipped(c.tabId, req, winnerOf(rep, "helper"), c.requestId);
            recordNetBody({ tabId: c.tabId, url: m.url, method: m.method, modified: rep.content, mime: rep.mime, status: 200, requestId: c.requestId });
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
        const c = this.context(m, "res");
        const reqHeaders = {};
        const base = { url: m.url, method: m.method, tabId: c.tabId, resourceType: c.type, tabUrl: c.tabUrl, requestHeaders: reqHeaders, status: m.status, requestId: c.requestId };
        let headers = m.headers;
        let headersChanged = false;
        if (this.matching(m.url, m.method, c.type, "resHeaders")) {
            const mods = await this.run("responseHeaders", { ...base, statusLine: `HTTP/1.1 ${m.status}`, responseHeaders: m.headers.map(([name, value]) => ({ name, value })) });
            if (mods) {
                headers = applyHeaderMods(headers, mods);
                headersChanged = true;
            }
        }
        if (m.body === "chunks" && this.matching(m.url, m.method, c.type, "body")) {
            const bytes = parts.length === 1 ? base64ToBytes(parts[0]) : concat(parts.map(base64ToBytes));
            const contentType = pairsToObject(headers)["content-type"] || "";
            const binary = bodyKind(contentType, bytes) === "binary";
            let out: string | Uint8Array | null = null;
            if (!binary || this.matching(m.url, m.method, c.type, "binary")) {
                // binary bodies reach `binary: true` routes only (bodyOps filters)
                const body: string | Uint8Array = binary ? bytes : new TextDecoder().decode(bytes);
                out = await this.run("transform", { ...base, body, contentType });
            } else {
                dlogLevel("helper", "debug", `binary body (${contentType || "sniffed"}) skipped: no onResponseBody route with binary: true: ${m.url}`);
                noteHelperSkip(m.url, "binary", contentType, c.requestId);
            }
            recordNetBody({ tabId: c.tabId, url: m.url, method: m.method, original: bytes, modified: out, requestId: c.requestId });
            if (out !== null && out !== undefined) {
                this.send({ t: "fulfill", id: m.id, status: m.status, headers: withNoStore(headers), body: bytesToBase64(typeof out === "string" ? new TextEncoder().encode(out) : out) });
                return;
            }
        } else if (m.body.startsWith("skipped:") && this.matching(m.url, m.method, c.type, "body")) {
            dlogLevel("helper", "debug", `onResponseBody not run (${m.body.slice(8)}): ${m.url}`);
            noteHelperSkip(m.url, m.body.slice(8), pairsToObject(m.headers)["content-type"] || "", c.requestId);
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
