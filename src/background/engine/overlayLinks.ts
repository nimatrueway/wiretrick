/**
 * L2 for overlays: what a page's bridge may do for a script's overlay
 * (`tt.onOverlay`) over its `tt-bridge` port — get the script's code, use
 * its stores, `tt.fetch` from the background, and bypass page fetches.
 *
 * A renderer may be compromised, so the bridge is only trusted as far as
 * its frame: everything is per script and granted by `overlay.open`, which
 * checks that the frame is a tab's top frame and that the script has an
 * overlay matching the page (a URL on the frame's own origin). Other
 * scripts' code and stores stay out of reach.
 *
 * L6 (Chrome MV3): a script's onPage code runs in a
 * `chrome.userScripts` world (background/userScripts.ts, hook/isolated.ts)
 * whose port comes here. It gets its code (`iso.load`, only where the
 * script has isolated onPage code for the frame's URL), its Log lines and
 * `tt.storage`, and — top frame only — the calls to and from the script's
 * overlay, relayed through that tab's top-frame bridge (L2 `iso.call` /
 * `iso.result`). Each side only reaches the same tab's top frame and the
 * same script; anything else is dropped.
 *
 * L5: the Editor's Preview tab (`tt-preview`, the Editor page only) runs
 * one script's overlay in a frame of its own: the same grant as a page's
 * overlay, for whichever script the Editor names, at a URL it picks.
 */
import { onBridgeConnect, type BridgeLink } from "./bridgePorts";
import { endpointPair, portEndpoint, ISO_STORE_TAG, type Endpoint, type IsoInit, type OverlayInit, type WireOps } from "../../shared/wire";
import { isRpcCall, isRpcResult, NOT_RUNNING, type RpcCall, type RpcResult } from "../../shared/rpc";
import { USER_SCRIPTS_OFF } from "../../shared/userScriptsStatus";
import { contextTag, type ScriptLogLevel } from "../../shared/scriptLog";
import { dlogLevel } from "../../shared/debugLog";
import { routeMatches, sampleUrl, type RouteMeta } from "../../shared/route";
import type { ShippedLib } from "../../shared/scriptImports";
import { fetchFor, storeOwner } from "./stores";
import { reactChunkSource } from "../reactChunk";
import { pages, pagesReady } from "./pages";
import { addBypass, addBypassRule } from "./bypass";

/** a script's overlay as its frame runs it (pipeline.ts `hookBundle`) */
export interface OverlayRun {
    name: string;
    code: string;
    codeHash: string;
    routes: RouteMeta[];
    params: Record<string, any>;
    libs: ShippedLib[];
    react: boolean;
}

interface Grant {
    url: string;
    name: string;
    nonce: string;
    /** the overlay frame confirmed its nonce (Firefox: ttOverlayNonce) */
    seen: boolean;
    expires: number;
    /** the overlay's link to the store owner (created on first use) */
    store: Endpoint | null;
    /** the page the overlay is on: the only one whose `tt.pageStore` copies it reaches */
    page: string;
}

/** Chrome's documentId of a port's frame (undefined: Firefox) */
const docOf = (port: chrome.runtime.Port | undefined): string | undefined => (port?.sender as any)?.documentId;
/** two ports in the same document (or the browser can't tell) */
const sameDoc = (a: chrome.runtime.Port | undefined, b: chrome.runtime.Port | undefined): boolean => {
    const x = docOf(a);
    const y = docOf(b);
    return !x || !y || x === y;
};
/** a store op's page is the grant's (or none: a global store) */
const pageOk = (a: { page?: unknown } | undefined, g: { page: string }): boolean => a?.page === undefined || a.page === g.page;

/** the page a frame is part of: its tab's top document's */
async function pageOfFrame(tabId: number, frameId: number, port: chrome.runtime.Port): Promise<string> {
    await pagesReady;
    return (frameId === 0 ? pages.forRequest({ tabId, frameId: 0, documentId: docOf(port) }) : pages.current(tabId)) ?? "";
}

/** a link to the store owner for one context of script `s`: the patches of the stores it subscribed to go out on `out`, tagged `tag` */
function ownerLink(out: Endpoint, tag: string): Endpoint {
    const [replicaSide, ownerSide] = endpointPair();
    storeOwner.attach(ownerSide, { all: false });
    for (const op of ["store.patch", "store.reject", "store.drop"] as const) replicaSide.on(op, (a: any) => !out.closed && out.push(op, a, tag));
    return replicaSide;
}

/** a context's store ops (`store.declare`, `store.set`, `store.sub`) on `ep`, for whichever script/grant `target` names */
function serveStoreOps(ep: Endpoint, target: (s: string | undefined) => { s: string; page: string; link(): Endpoint } | undefined): void {
    ep.on("store.declare", (a, s) => {
        const t = target(s);
        if (t) t.link().push("store.declare", a, t.s);
    });
    ep.on("store.set", (a, s) => {
        const t = target(s);
        if (t && pageOk(a, t)) t.link().push("store.set", a, t.s);
    });
    ep.handle("store.sub", (a, s): Promise<WireOps["store.sub"]["res"]> => {
        const t = target(s);
        if (!t) throw new Error("store.sub: this script's stores aren't reachable here");
        if (!pageOk(a, t)) throw new Error("store.sub: not this frame's page");
        return t.link().call("store.sub", a, t.s);
    });
}

const NONCE_TTL_MS = 60_000;
const BYPASS_TTL_MS = 10_000;

/** a script's isolated onPage code as its user-script world runs it (pipeline.ts `hookBundle`) */
export type IsoRun = Omit<IsoInit, "s" | "stores" | "page">;

export interface OverlayLinkDeps {
    overlayRuns(url: string): Promise<Map<string, OverlayRun>>;
    /** MV3: the scripts with isolated onPage code for a frame's URL */
    isoRuns?(url: string, top: boolean): Promise<Map<string, IsoRun>>;
    /** MV2: the scripts with isolated onPage code for a frame's URL (the bridge runs it) */
    isoScripts?(url: string, top: boolean): Promise<Set<string>>;
    /** chrome.userScripts can't run (the overlay's calls into isolated code say so) */
    userScriptsOff?(): Promise<boolean>;
    storageGet?(s: string, key: string): Promise<any>;
    storageSet?(s: string, key: string, value: any): Promise<void>;
    /** script `s`'s code assigned a param (`lib`: an imported library's) */
    paramSet?(s: string, key: string, value: any, lib?: string): Promise<void>;
    log?(tabId: number, s: string, level: ScriptLogLevel, msg: string, ctx: string): void;
    /** isolated onPage code ran on the frame's document */
    ran?(tabId: number, s: string, name: string, api: string, url: string): void;
    /** the Editor preview: script `s`'s overlay with every onOverlay route, whether or not it matches (throws why there's none) */
    previewRun?(s: string): Promise<OverlayRun>;
}

let overlayRuns: (url: string) => Promise<Map<string, OverlayRun>> = async () => new Map();
let deps: OverlayLinkDeps = { overlayRuns };
const grants = new Map<BridgeLink, Map<string, Grant>>();
let installed = false;

export const USER_SCRIPT_PORT = "tt-user-script";
/** how long a relayed call waits for the other side's link (a page still loading) */
const LINK_WAIT_MS = 5000;

/** an isolated runtime's L6 link; bound to one script by its first `iso.load` */
interface IsoLink {
    tabId: number;
    frameId: number;
    ep: Endpoint;
    port: chrome.runtime.Port;
    s: string | null;
    /** the page its frame is part of (set by `iso.load`) */
    page?: string;
    /** its link to the store owner (created on first use) */
    store?: Endpoint | null;
}
/** each tab's top-frame bridge (the overlay's side of the relay) */
const topBridges = new Map<number, BridgeLink>();
/** bound links: `${tabId}:${frameId}:${scriptId}` */
const isoLinks = new Map<string, IsoLink>();
/** relayed calls by cid (until answered, or a link closes: calls have no time limit): `toIso` = the overlay called isolated code, `toOverlay` = the other way */
const relayed = new Map<string, { dir: "toIso" | "toOverlay"; s: string; iso: IsoLink; bridge: BridgeLink }>();
/** woken whenever a bridge or isolated link comes up */
const linkWaiters = new Set<() => void>();
const isoKey = (tabId: number, frameId: number, s: string) => `${tabId}:${frameId}:${s}`;
const callError = (cid: string, message: string, name = "WtCallError"): RpcResult => ({ cid, ok: false, error: { name, message } });

function linksChanged(): void {
    for (const w of [...linkWaiters]) w();
}

/** `find()`, now or once a link comes up within LINK_WAIT_MS */
function whenLinked<T>(find: () => T | undefined): Promise<T | undefined> {
    const now = find();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
        const check = () => {
            const v = find();
            if (!v) return;
            done(v);
        };
        const done = (v: T | undefined) => {
            linkWaiters.delete(check);
            clearTimeout(timer);
            resolve(v);
        };
        const timer = setTimeout(() => done(undefined), LINK_WAIT_MS);
        linkWaiters.add(check);
    });
}

function track(cid: string, entry: { dir: "toIso" | "toOverlay"; s: string; iso: IsoLink; bridge: BridgeLink }): void {
    relayed.set(cid, entry);
}
function untrack(cid: string): void {
    relayed.delete(cid);
}

const sameOrigin = (a: string, b: string | undefined): boolean => {
    try {
        const o = new URL(a).origin;
        return !!b && o !== "null" && o === new URL(b).origin;
    } catch {
        return false;
    }
};

/** serve overlays on every bridge link; `runs(url)` → the overlays matching a top-frame page */
export function setupOverlayLinks(d: OverlayLinkDeps): void {
    deps = d;
    overlayRuns = d.overlayRuns;
    if (installed) return;
    installed = true;
    onBridgeConnect(serveLink);
    (globalThis as any).chrome?.runtime?.onMessage?.addListener?.((msg: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => {
        if (msg?.type !== "ttOverlayNonce") return false;
        sendResponse(confirmNonce(sender, msg.nonce));
        return false;
    });
}

/** Firefox overlay frames (not sandboxed) ask: is this nonce one a bridge (or the Editor preview) in my tab just opened? One use. */
export function confirmNonce(sender: chrome.runtime.MessageSender, nonce: unknown): boolean {
    const tabId = sender.tab?.id;
    if (typeof nonce !== "string" || typeof tabId !== "number" || !sender.url?.startsWith(chrome.runtime.getURL("overlay.html"))) return false;
    const mineByTab = [...grants].filter(([link]) => link.tabId === tabId).flatMap(([, mine]) => [...mine.values()]);
    const previewByTab = [...previews].filter((p) => p.tabId === tabId && p.grant).map((p) => p.grant!);
    for (const g of [...mineByTab, ...previewByTab])
        if (g.nonce === nonce && !g.seen && g.expires > Date.now()) {
            g.seen = true;
            return true;
        }
    return false;
}

/** scripts changed: drop the grants of overlays that no longer match their page (the bridge closes them too) */
export async function revalidateOverlayLinks(): Promise<void> {
    const byUrl = new Map<string, Promise<Map<string, OverlayRun>>>();
    for (const [link, mine] of grants)
        for (const [s, g] of [...mine]) {
            if (!byUrl.has(g.url)) byUrl.set(g.url, overlayRuns(g.url).catch(() => new Map()));
            if (!(await byUrl.get(g.url)!).has(s) && mine.get(s) === g && grants.get(link) === mine) {
                g.store?.close("the overlay no longer runs here");
                mine.delete(s);
            }
        }
}

export function serveLink(link: BridgeLink): void {
    const mine = new Map<string, Grant>();
    grants.set(link, mine);
    link.ep.onClose(() => {
        for (const g of mine.values()) g.store?.close("the bridge went away");
        mine.clear();
        grants.delete(link);
    });
    const granted = (op: string, s: string | undefined): Grant => {
        const g = s === undefined ? undefined : mine.get(s);
        if (!g) throw new Error(`${op}: this script has no overlay here`);
        return g;
    };
    /** MV2: the scripts whose isolated onPage code (run by this bridge) may use their stores */
    const isoGrants = new Map<string, { page: string; url?: string; store: Endpoint | null }>();
    link.ep.onClose(() => {
        for (const g of isoGrants.values()) g.store?.close("the bridge went away");
        isoGrants.clear();
    });
    // the overlay's ops come tagged `s`, isolated code's `ISO_STORE_TAG + s`; patches go back tagged the same
    serveStoreOps(link.ep, (tag) => {
        if (tag === undefined) return undefined;
        const [grantsOf, s] = tag.startsWith(ISO_STORE_TAG) ? [isoGrants, tag.slice(ISO_STORE_TAG.length)] : [mine, tag];
        const g = grantsOf.get(s);
        return g && { s, page: g.page, link: () => (g.store && !g.store.closed ? g.store : (g.store = ownerLink(link.ep, tag))) };
    });
    const grantStores = async (op: string, to: Map<string, { page: string; url?: string; store: Endpoint | null }>, s: string, url: string): Promise<{}> => {
        const page = await pageOfFrame(link.tabId, link.frameId, link.port);
        if (link.ep.closed) throw new Error(`${op}: closed`);
        const old = to.get(s);
        if (old?.page === page) {
            old.url = url;
            return {};
        }
        old?.store?.close("the page changed");
        to.set(s, { page, url, store: null });
        return {};
    };
    link.ep.handle("iso.stores", async ({ url }, s) => {
        if (__MV3__ || s === undefined || typeof url !== "string" || !sameOrigin(url, link.port.sender?.url)) throw new Error("iso.stores: refused");
        if (!(await deps.isoScripts?.(url, link.frameId === 0))?.has(s)) throw new Error("iso.stores: this script has no isolated onPage code here");
        return grantStores("iso.stores", isoGrants, s, url);
    });

    link.ep.handle("overlay.open", async ({ nonce, url }, s) => {
        if (s === undefined || link.frameId !== 0) throw new Error("overlay.open: overlays are top-frame only");
        if (typeof nonce !== "string" || nonce.length < 16 || typeof url !== "string" || !sameOrigin(url, link.port.sender?.url)) throw new Error("overlay.open: refused");
        const run = (await overlayRuns(url)).get(s);
        if (!run) throw new Error("overlay.open: this script has no overlay on this page");
        const old = mine.get(s);
        const page = pages.forRequest({ tabId: link.tabId, frameId: 0, documentId: docOf(link.port) }) ?? "";
        mine.set(s, { url, name: run.name, nonce, seen: false, expires: Date.now() + NONCE_TTL_MS, store: old?.page === page ? old.store : null, page });
        if (old?.store && old.page !== page) old.store.close("the page changed");
        return {};
    });
    link.ep.handle("overlay.init", async (_a, s): Promise<OverlayInit> => {
        const g = granted("overlay.init", s);
        const run = (await overlayRuns(g.url)).get(s!);
        if (!run) throw new Error("overlay.init: this script has no overlay on this page");
        const stores = (await storeOwner.init([s!], { page: g.page }))[s!] ?? {};
        return { s: s!, name: run.name, code: run.code, codeHash: run.codeHash, routes: run.routes, url: g.url, params: run.params, stores, page: g.page, libs: run.libs, react: run.react };
    });
    link.ep.on("overlay.closed", (_a, s) => {
        const g = s === undefined ? undefined : mine.get(s);
        if (!g) return;
        g.store?.close("the overlay closed");
        mine.delete(s!);
    });

    link.ep.handle("fetch", (a, s) => {
        granted("fetch", s);
        return fetchFor(s!, a.request, !!a.bypass);
    });
    // a page fetch the bridge is about to make for the overlay: no script's handlers touch it
    link.ep.handle("bypass.add", async (a, s) => {
        const g = granted("bypass.add", s);
        if (typeof a?.method !== "string" || typeof a?.url !== "string") throw new Error("bypass.add: malformed");
        addBypass({ method: a.method, url: a.url, tabId: link.tabId, scriptId: s!, scriptName: g.name }, BYPASS_TTL_MS);
        const remove = await addBypassRule(a.method, a.url, link.tabId);
        setTimeout(remove, BYPASS_TTL_MS);
        return {};
    });

    // ---- the overlay ⇄ isolated-world relay (top frame) ----
    if (link.frameId === 0) topBridges.set(link.tabId, link);
    link.ep.onClose(() => {
        if (topBridges.get(link.tabId) === link) topBridges.delete(link.tabId);
        for (const [cid, r] of [...relayed]) {
            if (r.bridge !== link) continue;
            untrack(cid);
            if (r.dir === "toOverlay") r.iso.ep.push("rpc.result", callError(cid, "the page's bridge went away", "DisconnectedError"), r.s);
        }
    });
    // the overlay calls its script's isolated code
    link.ep.on("iso.call", (call, s) => {
        if (s === undefined || link.frameId !== 0 || !mine.has(s) || !isRpcCall(call)) return;
        // the isolated code of this bridge's document (a newer page's link isn't up yet: wait for it)
        void whenLinked(() => {
            const iso = isoLinks.get(isoKey(link.tabId, 0, s));
            return iso && sameDoc(iso.port, link.port) ? iso : undefined;
        }).then(async (iso) => {
            if (link.ep.closed) return;
            if (!iso) return link.ep.push("iso.result", callError(call.cid, (await deps.userScriptsOff?.()) ? USER_SCRIPTS_OFF : NOT_RUNNING), s);
            track(call.cid, { dir: "toIso", s, iso, bridge: link });
            iso.ep.push("rpc.call", call, s);
        });
    });
    // the overlay's answer to a call from isolated code
    link.ep.on("iso.result", (r, s) => {
        const p = isRpcResult(r) ? relayed.get(r.cid) : undefined;
        if (!p || p.dir !== "toOverlay" || p.bridge !== link || p.s !== s) return;
        untrack(r.cid);
        p.iso.ep.push("rpc.result", r, s);
    });
    link.ep.on("overlay.closed", (_a, s) => {
        const iso = s !== undefined && link.frameId === 0 ? isoLinks.get(isoKey(link.tabId, 0, s)) : undefined;
        if (iso && sameDoc(iso.port, link.port)) iso.ep.push("overlay.closed", {}, s);
    });
    linksChanged();
}

/** L6: a user-script world's port (`runtime.onUserScriptConnect`); false if it isn't one of ours */
export function addUserScriptPort(port: chrome.runtime.Port): boolean {
    if (port.name !== USER_SCRIPT_PORT) return false;
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId;
    if (typeof tabId !== "number" || tabId < 0 || typeof frameId !== "number" || port.sender?.id !== chrome.runtime.id) {
        port.disconnect();
        return true;
    }
    const ep = portEndpoint(port, { debug: (m) => dlogLevel("wire", "debug", `user script tab ${tabId} frame ${frameId}: ${m}`) });
    serveIsoLink({ tabId, frameId, ep, port, s: null });
    return true;
}

export function serveIsoLink(link: IsoLink): void {
    const { tabId, frameId, ep } = link;
    const bound = (s: string | undefined): s is string => s !== undefined && s === link.s;
    ep.onClose(() => {
        link.store?.close("the isolated-world code went away");
        if (link.s !== null && isoLinks.get(isoKey(tabId, frameId, link.s)) === link) isoLinks.delete(isoKey(tabId, frameId, link.s));
        for (const [cid, r] of [...relayed]) {
            if (r.iso !== link) continue;
            untrack(cid);
            if (r.dir === "toIso") r.bridge.ep.push("iso.result", callError(cid, "the isolated-world code went away", "DisconnectedError"), r.s);
        }
    });
    ep.handle("builtin.react", () => reactChunkSource());
    ep.handle("iso.load", async ({ url }, s) => {
        if (typeof s !== "string" || typeof url !== "string" || !sameOrigin(url, link.port.sender?.url) || (link.s !== null && link.s !== s)) throw new Error("iso.load: refused");
        // Chrome may one day say which world the port came from
        const world = (link.port.sender as any)?.userScriptWorldId;
        if (typeof world === "string" && world && world !== s) throw new Error("iso.load: refused");
        const run = (await deps.isoRuns?.(url, frameId === 0))?.get(s);
        if (!run) throw new Error("iso.load: this script has no isolated onPage code here");
        const page = link.page ?? (await pageOfFrame(tabId, frameId, link.port));
        const stores = (await storeOwner.init([s], { page }))[s] ?? {};
        if (ep.closed) throw new Error("iso.load: closed");
        link.page = page;
        if (link.s === null) {
            link.s = s;
            const key = isoKey(tabId, frameId, s);
            const old = isoLinks.get(key);
            isoLinks.set(key, link);
            if (old && old !== link) old.ep.close("replaced by a new link");
            linksChanged();
        }
        return { s, ...run, stores, page };
    });
    serveStoreOps(ep, (s) => (bound(s) && link.page !== undefined ? { s, page: link.page, link: () => (link.store && !link.store.closed ? link.store : (link.store = ownerLink(ep, s))) } : undefined));
    ep.on("log", (a, s) => {
        if (!bound(s) || !["debug", "info", "warn", "error"].includes(a?.level)) return;
        deps.log?.(tabId, s, a.level, String(a.msg ?? "").slice(0, 8000), contextTag("isolated", link.port.sender?.url));
    });
    ep.on("ran", (a, s) => {
        if (bound(s) && link.port.sender?.url) deps.ran?.(tabId, s, String(a?.name ?? ""), a?.api, link.port.sender.url);
    });
    ep.handle("storage.get", async ({ key }, s) => {
        if (!bound(s) || typeof key !== "string") throw new Error("storage.get: refused");
        return { value: await deps.storageGet?.(s, key) };
    });
    ep.handle("storage.set", async ({ key, value }, s) => {
        if (!bound(s) || typeof key !== "string") throw new Error("storage.set: refused");
        await deps.storageSet?.(s, key, value);
        return {};
    });
    ep.handle("param.set", async ({ key, value, lib }, s) => {
        if (!bound(s)) throw new Error("param.set: refused");
        await deps.paramSet?.(s, key, value, lib);
        return {};
    });
    // isolated code calls its overlay (top frame only)
    ep.on("rpc.call", (call, s) => {
        if (!bound(s) || !isRpcCall(call)) return;
        if (frameId !== 0) return ep.push("rpc.result", callError(call.cid, NOT_RUNNING), s);
        void whenLinked(() => {
            const bridge = topBridges.get(tabId);
            return bridge && sameDoc(bridge.port, link.port) ? bridge : undefined;
        }).then((bridge) => {
            if (ep.closed) return;
            if (!bridge) return ep.push("rpc.result", callError(call.cid, NOT_RUNNING), s);
            track(call.cid, { dir: "toOverlay", s, iso: link, bridge });
            bridge.ep.push("iso.call", call, s);
        });
    });
    // its answer to the overlay's call
    ep.on("rpc.result", (r, s) => {
        const p = isRpcResult(r) ? relayed.get(r.cid) : undefined;
        if (!p || p.dir !== "toIso" || p.iso !== link || p.s !== s) return;
        untrack(r.cid);
        p.bridge.ep.push("iso.result", r, s);
    });
}

// ---- L5: the Editor preview ----

export const PREVIEW_PORT = "tt-preview";

interface PreviewLink {
    ep: Endpoint;
    /** the Editor's tab (Firefox: the frame's nonce check) */
    tabId?: number;
    grant: (Grant & { s: string }) | null;
}
const previews = new Set<PreviewLink>();

/** the Editor page's preview port (runtime.onConnect); false if the port isn't one */
export function addPreviewPort(port: chrome.runtime.Port): boolean {
    if (port.name !== PREVIEW_PORT) return false;
    // the Editor page only: content scripts (and Firefox's unsandboxed overlay frames) have other URLs
    const page = (port.sender?.url ?? "").split(/[?#]/)[0];
    if (port.sender?.id !== chrome.runtime.id || page !== chrome.runtime.getURL("editor.html")) {
        port.disconnect();
        return true;
    }
    const ep = portEndpoint(port, { batchMs: 16, debug: (m) => dlogLevel("wire", "debug", `preview: ${m}`) });
    servePreviewLink(ep, port.sender?.tab?.id);
    return true;
}

export function servePreviewLink(ep: Endpoint, tabId?: number): void {
    const link: PreviewLink = { ep, tabId, grant: null };
    previews.add(link);
    const drop = (why: string) => {
        link.grant?.store?.close(why);
        if (link.grant) pages.endVirtual(link.grant.page);
        link.grant = null;
    };
    ep.onClose(() => {
        drop("the preview closed");
        previews.delete(link);
    });
    const granted = (op: string, s: string | undefined): Grant & { s: string } => {
        const g = link.grant;
        if (!g || s === undefined || g.s !== s) throw new Error(`${op}: this script isn't previewed`);
        return g;
    };
    const runOf = async (op: string, s: string): Promise<OverlayRun> => {
        try {
            if (deps.previewRun) return await deps.previewRun(s);
        } catch (e) {
            throw new Error(`${op}: ${(e as Error)?.message ?? e}`);
        }
        throw new Error(`${op}: no preview here`);
    };
    const storeOf = (g: Grant & { s: string }): Endpoint => {
        if (g.store && !g.store.closed) return g.store;
        return (g.store = ownerLink(ep, g.s));
    };

    ep.handle("preview.open", async ({ nonce, url }, s) => {
        if (typeof s !== "string" || typeof nonce !== "string" || nonce.length < 16 || typeof url !== "string") throw new Error("preview.open: refused");
        const run = await runOf("preview.open", s);
        const at = url || sampleUrl(run.routes);
        try {
            new URL(at);
        } catch {
            throw new Error(`preview.open: "${at}" isn't a URL`);
        }
        const old = link.grant;
        if (old && old.s !== s) drop("the preview moved to another script");
        // the preview is a page of its own
        const keep = old?.s === s ? old : null;
        link.grant = { s, url: at, name: run.name, nonce, seen: false, expires: Date.now() + NONCE_TTL_MS, store: keep?.store ?? null, page: keep?.page ?? pages.openVirtual() };
        return { url: at, name: run.name, handlers: run.routes.length, matching: run.routes.filter((r) => routeMatches(r, at)).length };
    });
    ep.handle("overlay.init", async (_a, s): Promise<OverlayInit> => {
        const g = granted("overlay.init", s);
        const run = await runOf("overlay.init", g.s);
        const stores = (await storeOwner.init([g.s], { page: g.page }))[g.s] ?? {};
        return { s: g.s, name: run.name, code: run.code, codeHash: run.codeHash, routes: run.routes, url: g.url, params: run.params, stores, page: g.page, libs: run.libs, react: run.react };
    });
    ep.on("store.declare", (a, s) => {
        if (link.grant && link.grant.s === s) storeOf(link.grant).push("store.declare", a, s);
    });
    ep.on("store.set", (a, s) => {
        if (link.grant && link.grant.s === s && pageOk(a, link.grant)) storeOf(link.grant).push("store.set", a, s);
    });
    ep.handle("store.sub", (a, s) => {
        const g = granted("store.sub", s);
        if (!pageOk(a, g)) throw new Error("store.sub: not the preview's page");
        return storeOf(g).call("store.sub", a, s);
    });
    ep.handle("fetch", (a, s) => fetchFor(granted("fetch", s).s, a.request, !!a.bypass));
    ep.handle("storage.get", async ({ key }, s) => {
        const g = granted("storage.get", s);
        if (typeof key !== "string") throw new Error("storage.get: refused");
        return { value: await deps.storageGet?.(g.s, key) };
    });
    ep.handle("storage.set", async ({ key, value }, s) => {
        const g = granted("storage.set", s);
        if (typeof key !== "string") throw new Error("storage.set: refused");
        await deps.storageSet?.(g.s, key, value);
        return {};
    });
    ep.handle("param.set", async ({ key, value, lib }, s) => {
        await deps.paramSet?.(granted("param.set", s).s, key, value, lib);
        return {};
    });
    ep.on("log", (a, s) => {
        const g = link.grant;
        if (!g || g.s !== s || !["debug", "info", "warn", "error"].includes(a?.level)) return;
        deps.log?.(-1, g.s, a.level, String(a.msg ?? "").slice(0, 8000), "overlay › preview");
    });
}

/** scripts changed: open previews check whether theirs did */
export function pushPreviewUpdate(scripts: { s: string; codeHash: string }[]): void {
    for (const p of previews) p.ep.push("bundle.update", { scripts });
}

/** scripts changed: every isolated runtime loads again (re-runs when its code changed) */
export function pushIsoUpdate(): void {
    for (const l of isoLinks.values()) l.ep.push("iso.update", {}, l.s!);
}

/** tests: forget every link */
export function resetOverlayLinks(): void {
    grants.clear();
    isoLinks.clear();
    topBridges.clear();
    relayed.clear();
    linkWaiters.clear();
    previews.clear();
    deps = { overlayRuns };
}
