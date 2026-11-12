/**
 * L2: the `tt-bridge` ports content-script bridges open to the background,
 * one per frame, kept in a registry by tab and frame. Phase 1 uses them
 * for `bundle.update` only. The overlay (Phase 2) adds its store, fetch
 * and bypass handlers through `onBridgeConnect`, each checking that the
 * script `s` has an overlay in that tab and frame — until then a bridge
 * can't reach any script's stores or the background's fetch.
 */
import { portEndpoint, type Endpoint } from "../../shared/wire";
import { dlogLevel } from "../../shared/debugLog";

export const BRIDGE_PORT = "tt-bridge";

export interface BridgeLink {
    tabId: number;
    frameId: number;
    ep: Endpoint;
    port: chrome.runtime.Port;
}

const links = new Map<number, Map<number, BridgeLink>>();
const connectFns: ((link: BridgeLink) => void)[] = [];

/** a bridge connected (runtime.onConnect, port name `tt-bridge`); false if the port isn't one */
export function addBridgePort(port: chrome.runtime.Port): boolean {
    if (port.name !== BRIDGE_PORT) return false;
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId;
    // only content scripts in a tab: an extension page or another extension has no tab
    if (typeof tabId !== "number" || tabId < 0 || typeof frameId !== "number" || port.sender?.id !== chrome.runtime.id) {
        port.disconnect();
        return true;
    }
    const ep = portEndpoint(port, { batchMs: 16, debug: (m) => dlogLevel("wire", "debug", `bridge tab ${tabId} frame ${frameId}: ${m}`) });
    const link: BridgeLink = { tabId, frameId, ep, port };
    let frames = links.get(tabId);
    if (!frames) links.set(tabId, (frames = new Map()));
    const old = frames.get(frameId);
    frames.set(frameId, link);
    if (old) {
        old.ep.close("replaced by a new port");
        old.port.disconnect();
    }
    ep.onClose(() => {
        const f = links.get(tabId);
        if (f?.get(frameId) !== link) return;
        f.delete(frameId);
        if (!f.size) links.delete(tabId);
    });
    for (const fn of connectFns) fn(link);
    return true;
}

/** run `fn` for every bridge that connects (Phase 2: register overlay handlers) */
export function onBridgeConnect(fn: (link: BridgeLink) => void): void {
    connectFns.push(fn);
}

/** the open bridge links, all or one tab's */
export function bridgeLinks(tabId?: number): BridgeLink[] {
    const tabs = tabId === undefined ? [...links.values()] : [links.get(tabId)].filter((x): x is Map<number, BridgeLink> => !!x);
    return tabs.flatMap((f) => [...f.values()]);
}

/** scripts changed: tell every connected bridge (the rest get the one-shot `bundleUpdate`) */
export function pushBundleUpdate(scripts: { s: string; codeHash: string }[]): number {
    const all = bridgeLinks();
    for (const l of all) l.ep.push("bundle.update", { scripts });
    return all.length;
}
