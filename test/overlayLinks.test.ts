import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetched: any[] = [];
const bypasses: any[] = [];
const rules: any[] = [];
const attached: any[] = [];
vi.mock("../src/background/engine/stores", () => ({
    fetchFor: async (s: string, request: any, bypass: boolean) => (fetched.push({ s, request, bypass }), { status: 200, statusText: "", headers: [], body: "ok", url: request.url }),
    storeOwner: {
        init: async (ids: string[]) => Object.fromEntries(ids.map((s) => [s, { n: { value: 1, persist: false } }])),
        attach: (ep: any, o: any) => {
            attached.push(o);
            ep.handle("store.sub", (a: any, s: any) => ({ sub: a, s }));
        },
    },
}));
vi.mock("../src/background/engine/bypass", () => ({
    addBypass: (r: any) => (bypasses.push(r), () => {}),
    addBypassRule: async (...a: any[]) => (rules.push(a), () => {}),
}));

import { serveLink, confirmNonce, setupOverlayLinks, revalidateOverlayLinks, resetOverlayLinks, type OverlayRun } from "../src/background/engine/overlayLinks";
import { endpointPair, type Endpoint } from "../src/shared/wire";

const run = (name: string): OverlayRun => ({ name, code: "code", codeHash: "h", routes: [], params: {}, libs: [], react: false });
let runs: Record<string, string[]> = {};
const NONCE = "0123456789abcdef0123";
const PAGE = "https://a.example/app";

function bridge(o: { tabId?: number; frameId?: number; senderUrl?: string } = {}): Endpoint {
    const [ext, page] = endpointPair();
    serveLink({ tabId: o.tabId ?? 4, frameId: o.frameId ?? 0, ep: ext, port: { sender: { url: o.senderUrl ?? PAGE } } as any });
    return page;
}

describe("overlay links (L2 per-script grants)", () => {
    beforeEach(() => {
        resetOverlayLinks();
        fetched.length = bypasses.length = rules.length = attached.length = 0;
        runs = { [PAGE]: ["s1"] };
        vi.stubGlobal("chrome", { runtime: { id: "ext", getURL: (p: string) => `chrome-extension://ext/${p}` } });
        setupOverlayLinks({ overlayRuns: async (url) => new Map((runs[url] ?? []).map((s) => [s, run(`Script ${s}`)])) });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("overlay.open is refused off the top frame, with a short nonce, cross-origin, or for a script with no overlay", async () => {
        await expect(bridge({ frameId: 2 }).call("overlay.open", { nonce: NONCE, url: PAGE }, "s1")).rejects.toThrow(/top-frame/);
        const b = bridge();
        await expect(b.call("overlay.open", { nonce: "short", url: PAGE }, "s1")).rejects.toThrow(/refused/);
        await expect(b.call("overlay.open", { nonce: NONCE, url: "https://evil.example/" }, "s1")).rejects.toThrow(/refused/);
        await expect(b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s2")).rejects.toThrow(/no overlay/);
        await expect(b.call("overlay.open", { nonce: NONCE, url: PAGE }, undefined as any)).rejects.toThrow();
        await expect(b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1")).resolves.toEqual({});
    });

    it("overlay.init needs a grant and hands over only that script's code and stores", async () => {
        const b = bridge();
        await expect(b.call("overlay.init", {}, "s1")).rejects.toThrow(/no overlay here/);
        await b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1");
        const init = await b.call("overlay.init", {}, "s1");
        expect(init).toMatchObject({ s: "s1", name: "Script s1", code: "code", url: PAGE, stores: { n: { value: 1 } } });
        await expect(b.call("overlay.init", {}, "s2")).rejects.toThrow(/no overlay here/);
    });

    it("store, fetch and bypass ops are refused without a grant", async () => {
        const b = bridge();
        await expect(b.call("store.sub", { name: "n" } as any, "s1")).rejects.toThrow(/no overlay here/);
        await expect(b.call("fetch", { request: { method: "GET", url: "https://x/" } } as any, "s1")).rejects.toThrow(/no overlay here/);
        await expect(b.call("bypass.add", { method: "GET", url: "https://x/" } as any, "s1")).rejects.toThrow(/no overlay here/);
        b.push("store.set", { name: "n", ops: [] } as any, "s1");
        await new Promise((r) => setTimeout(r, 5));
        expect(attached).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it("granted: store subscriptions go through a per-overlay owner link; fetch and bypass are tagged with the script", async () => {
        const b = bridge({ tabId: 11 });
        await b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1");
        expect(await b.call("store.sub", { name: "n" } as any, "s1")).toEqual({ sub: { name: "n" }, s: "s1" });
        expect(attached).toEqual([{ all: false }]);
        await b.call("fetch", { request: { method: "GET", url: "https://x/" }, bypass: true } as any, "s1");
        expect(fetched).toEqual([{ s: "s1", request: { method: "GET", url: "https://x/" }, bypass: true }]);
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        // the bridge can't pick the tab: the link's own one is used
        await b.call("bypass.add", { method: "GET", url: "https://x/", tabId: 99 } as any, "s1");
        vi.useRealTimers();
        expect(bypasses[0]).toMatchObject({ method: "GET", url: "https://x/", tabId: 11, scriptId: "s1", scriptName: "Script s1" });
        expect(rules).toEqual([["GET", "https://x/", 11]]);
        await expect(b.call("bypass.add", { method: 1 } as any, "s1")).rejects.toThrow(/malformed/);
    });

    it("overlay.closed and a closed link drop the grant", async () => {
        const b = bridge();
        await b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1");
        b.push("overlay.closed", {} as any, "s1");
        await new Promise((r) => setTimeout(r, 5));
        await expect(b.call("overlay.init", {}, "s1")).rejects.toThrow(/no overlay here/);
    });

    it("confirmNonce is one-time and checks the tab and the overlay page", async () => {
        const b = bridge({ tabId: 4 });
        await b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1");
        const frame = { tab: { id: 4 }, url: "chrome-extension://ext/overlay.html#" + NONCE } as any;
        expect(confirmNonce({ ...frame, tab: { id: 5 } }, NONCE)).toBe(false);
        expect(confirmNonce({ ...frame, url: PAGE }, NONCE)).toBe(false);
        expect(confirmNonce(frame, "other")).toBe(false);
        expect(confirmNonce(frame, NONCE)).toBe(true);
        expect(confirmNonce(frame, NONCE)).toBe(false);
    });

    it("revalidation drops grants of overlays that no longer match", async () => {
        const b = bridge();
        await b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1");
        runs = {};
        await revalidateOverlayLinks();
        await expect(b.call("overlay.init", {}, "s1")).rejects.toThrow(/no overlay here/);
    });
});
