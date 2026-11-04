/**
 * L2 for overlays: what a page's bridge may do for a script's overlay
 * (wt.onOverlay) over its `wt-bridge` port — get the script's code, use
 * its stores, `wt.fetch` from the background, and bypass page fetches.
 *
 * A renderer may be compromised, so the bridge is only trusted as far as
 * its frame: everything is per script and granted by `overlay.open`, which
 * checks that the frame is a tab's top frame and that the script has an
 * overlay matching the page (a URL on the frame's own origin). Other
 * scripts' code and stores stay out of reach.
 */
import { onBridgeConnect, type BridgeLink } from "./bridgePorts";
import { endpointPair, type Endpoint, type OverlayInit } from "../../shared/wire";
import type { RouteMeta } from "../../shared/route";
import type { ShippedLib } from "../../shared/scriptImports";
import { fetchFor, storeOwner } from "./stores";
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
    /** the overlay frame confirmed its nonce (Firefox: wtOverlayNonce) */
    seen: boolean;
    expires: number;
    /** the overlay's link to the store owner (created on first use) */
    store: Endpoint | null;
}

const NONCE_TTL_MS = 60_000;
const BYPASS_TTL_MS = 10_000;

let overlayRuns: (url: string) => Promise<Map<string, OverlayRun>> = async () => new Map();
const grants = new Map<BridgeLink, Map<string, Grant>>();
let installed = false;

const sameOrigin = (a: string, b: string | undefined): boolean => {
    try {
        const o = new URL(a).origin;
        return !!b && o !== "null" && o === new URL(b).origin;
    } catch {
        return false;
    }
};

/** serve overlays on every bridge link; `runs(url)` → the overlays matching a top-frame page */
export function setupOverlayLinks(deps: { overlayRuns(url: string): Promise<Map<string, OverlayRun>> }): void {
    overlayRuns = deps.overlayRuns;
    if (installed) return;
    installed = true;
    onBridgeConnect(serveLink);
    (globalThis as any).chrome?.runtime?.onMessage?.addListener?.((msg: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => {
        if (msg?.type !== "wtOverlayNonce") return false;
        sendResponse(confirmNonce(sender, msg.nonce));
        return false;
    });
}

/** Firefox overlay frames (not sandboxed) ask: is this nonce one a bridge in my tab just opened? One use. */
export function confirmNonce(sender: chrome.runtime.MessageSender, nonce: unknown): boolean {
    const tabId = sender.tab?.id;
    if (typeof nonce !== "string" || typeof tabId !== "number" || !sender.url?.startsWith(chrome.runtime.getURL("overlay.html"))) return false;
    for (const [link, mine] of grants) {
        if (link.tabId !== tabId) continue;
        for (const g of mine.values())
            if (g.nonce === nonce && !g.seen && g.expires > Date.now()) {
                g.seen = true;
                return true;
            }
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
    /** the overlay's store link: patches for the stores it subscribed to go back to the bridge, tagged with `s` */
    const storeOf = (s: string, g: Grant): Endpoint => {
        if (g.store && !g.store.closed) return g.store;
        const [replicaSide, ownerSide] = endpointPair();
        storeOwner.attach(ownerSide, { all: false });
        replicaSide.on("store.patch", (a) => link.ep.push("store.patch", a, s));
        replicaSide.on("store.reject", (a) => link.ep.push("store.reject", a, s));
        return (g.store = replicaSide);
    };

    link.ep.handle("overlay.open", async ({ nonce, url }, s) => {
        if (s === undefined || link.frameId !== 0) throw new Error("overlay.open: overlays are top-frame only");
        if (typeof nonce !== "string" || nonce.length < 16 || typeof url !== "string" || !sameOrigin(url, link.port.sender?.url)) throw new Error("overlay.open: refused");
        const run = (await overlayRuns(url)).get(s);
        if (!run) throw new Error("overlay.open: this script has no overlay on this page");
        const old = mine.get(s);
        mine.set(s, { url, name: run.name, nonce, seen: false, expires: Date.now() + NONCE_TTL_MS, store: old?.store ?? null });
        return {};
    });
    link.ep.handle("overlay.init", async (_a, s): Promise<OverlayInit> => {
        const g = granted("overlay.init", s);
        const run = (await overlayRuns(g.url)).get(s!);
        if (!run) throw new Error("overlay.init: this script has no overlay on this page");
        const stores = (await storeOwner.init([s!]))[s!] ?? {};
        return { s: s!, name: run.name, code: run.code, codeHash: run.codeHash, routes: run.routes, url: g.url, params: run.params, stores, libs: run.libs, react: run.react };
    });
    link.ep.on("overlay.closed", (_a, s) => {
        const g = s === undefined ? undefined : mine.get(s);
        if (!g) return;
        g.store?.close("the overlay closed");
        mine.delete(s!);
    });

    link.ep.on("store.declare", (a, s) => {
        const g = s === undefined ? undefined : mine.get(s);
        if (g) storeOf(s!, g).push("store.declare", a, s);
    });
    link.ep.on("store.set", (a, s) => {
        const g = s === undefined ? undefined : mine.get(s);
        if (g) storeOf(s!, g).push("store.set", a, s);
    });
    link.ep.handle("store.sub", (a, s) => storeOf(s!, granted("store.sub", s)).call("store.sub", a, s));

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
}

/** tests: forget every link */
export function resetOverlayLinks(): void {
    grants.clear();
}
