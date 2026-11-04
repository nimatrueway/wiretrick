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

import { serveLink, serveIsoLink, pushIsoUpdate, confirmNonce, setupOverlayLinks, revalidateOverlayLinks, resetOverlayLinks, type IsoRun, type OverlayRun } from "../src/background/engine/overlayLinks";
import { NOT_RUNNING, type RpcCall, type RpcResult } from "../src/shared/rpc";
import { USER_SCRIPTS_OFF } from "../src/shared/userScriptsStatus";
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

describe("the L6 ⇄ L2 relay (MV3 isolated world ⇄ overlay)", () => {
    const isoRun = (name: string): IsoRun => ({ name, src: "src", codeHash: "c", params: {}, libs: [], overlay: true });
    let isoRunsFor: Record<string, string[]> = {};
    let off = false;
    const logs: any[] = [];
    const storage = new Map<string, any>();
    const tick = () => new Promise((r) => setTimeout(r, 5));

    function iso(o: { tabId?: number; frameId?: number; senderUrl?: string } = {}): Endpoint {
        const [ext, page] = endpointPair();
        serveIsoLink({ tabId: o.tabId ?? 4, frameId: o.frameId ?? 0, ep: ext, port: { sender: { url: o.senderUrl ?? PAGE } } as any, s: null });
        return page;
    }
    /** pushes `op` arrives with, per endpoint */
    function collect(ep: Endpoint, op: string): { a: any; s: any }[] {
        const got: { a: any; s: any }[] = [];
        ep.on(op as any, (a: any, s: any) => void got.push({ a, s }));
        return got;
    }
    const call = (cid: string, h = "page:0"): RpcCall => ({ cid, h, fn: "f", args: [] });
    async function overlayBridge(o: { tabId?: number; frameId?: number } = {}): Promise<Endpoint> {
        const b = bridge(o);
        await b.call("overlay.open", { nonce: NONCE, url: PAGE }, "s1");
        return b;
    }

    beforeEach(() => {
        resetOverlayLinks();
        runs = { [PAGE]: ["s1"] };
        isoRunsFor = { [PAGE]: ["s1", "s2"] };
        off = false;
        logs.length = 0;
        storage.clear();
        vi.stubGlobal("chrome", { runtime: { id: "ext", getURL: (p: string) => `chrome-extension://ext/${p}` } });
        setupOverlayLinks({
            overlayRuns: async (url) => new Map((runs[url] ?? []).map((s) => [s, run(`Script ${s}`)])),
            isoRuns: async (url) => new Map((isoRunsFor[url] ?? []).map((s) => [s, isoRun(`Script ${s}`)])),
            userScriptsOff: async () => off,
            storageGet: async (s, key) => storage.get(`${s}/${key}`),
            storageSet: async (s, key, value) => void storage.set(`${s}/${key}`, value),
            log: (tabId, s, level, msg, ctx) => void logs.push({ tabId, s, level, msg, ctx }),
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("iso.load binds the link to one script: same origin only, only a script with isolated code here", async () => {
        await expect(iso({ senderUrl: "https://evil.example/" }).call("iso.load", { url: PAGE }, "s1")).rejects.toThrow(/refused/);
        await expect(iso().call("iso.load", { url: PAGE }, "s3")).rejects.toThrow(/no isolated onPage code/);
        const l = iso();
        expect(await l.call("iso.load", { url: PAGE }, "s1")).toMatchObject({ s: "s1", name: "Script s1", src: "src", overlay: true });
        // it stays bound: another script's code, logs and storage are refused
        await expect(l.call("iso.load", { url: PAGE }, "s2")).rejects.toThrow(/refused/);
        await expect(l.call("storage.get", { key: "k" }, "s2")).rejects.toThrow(/refused/);
        await l.call("storage.set", { key: "k", value: 1 }, "s1");
        expect(await l.call("storage.get", { key: "k" }, "s1")).toEqual({ value: 1 });
        l.push("log", { level: "info", msg: "hi" }, "s1");
        l.push("log", { level: "info", msg: "not mine" }, "s2");
        await tick();
        expect(logs).toEqual([{ tabId: 4, s: "s1", level: "info", msg: "hi", ctx: "isolated › a.example" }]);
    });

    it("an unbound link can't log, store or call", async () => {
        const l = iso();
        await expect(l.call("storage.get", { key: "k" }, "s1")).rejects.toThrow(/refused/);
        const b = await overlayBridge();
        const calls = collect(b, "iso.call");
        l.push("rpc.call", call("c1", "overlay:0"), "s1");
        l.push("log", { level: "info", msg: "x" }, "s1");
        await tick();
        expect(calls).toEqual([]);
        expect(logs).toEqual([]);
    });

    it("round trip: the overlay calls isolated code and gets its answer; isolated code calls the overlay", async () => {
        const b = await overlayBridge();
        const l = iso();
        await l.call("iso.load", { url: PAGE }, "s1");
        const inIso = collect(l, "rpc.call");
        const toBridge = collect(b, "iso.result");
        b.push("iso.call", call("c1"), "s1");
        await tick();
        expect(inIso).toEqual([{ a: call("c1"), s: "s1" }]);
        l.push("rpc.result", { cid: "c1", ok: true, value: 3 } as RpcResult, "s1");
        await tick();
        expect(toBridge).toEqual([{ a: { cid: "c1", ok: true, value: 3 }, s: "s1" }]);

        const inBridge = collect(b, "iso.call");
        const toIso = collect(l, "rpc.result");
        l.push("rpc.call", call("c2", "overlay:0"), "s1");
        await tick();
        expect(inBridge).toEqual([{ a: call("c2", "overlay:0"), s: "s1" }]);
        b.push("iso.result", { cid: "c2", ok: true, value: "picked" } as RpcResult, "s1");
        await tick();
        expect(toIso).toEqual([{ a: { cid: "c2", ok: true, value: "picked" }, s: "s1" }]);
        // a result is delivered once
        b.push("iso.result", { cid: "c2", ok: true, value: "again" } as RpcResult, "s1");
        await tick();
        expect(toIso).toHaveLength(1);
    });

    it("wrong tab: calls never cross tabs (the overlay's call times out as not running)", async () => {
        const b = await overlayBridge({ tabId: 4 });
        const other = iso({ tabId: 5 });
        await other.call("iso.load", { url: PAGE }, "s1");
        const inOther = collect(other, "rpc.call");
        const results = collect(b, "iso.result");
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        b.push("iso.call", call("c1"), "s1");
        await vi.advanceTimersByTimeAsync(5100);
        vi.useRealTimers();
        await tick();
        expect(inOther).toEqual([]);
        expect(results.map((r) => r.a.error?.message)).toEqual([NOT_RUNNING]);
        // and the other tab's isolated code doesn't reach this tab's overlay
        const inBridge = collect(b, "iso.call");
        const l5 = collect(other, "rpc.result");
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        other.push("rpc.call", call("c2", "overlay:0"), "s1");
        await vi.advanceTimersByTimeAsync(5100);
        vi.useRealTimers();
        await tick();
        expect(inBridge).toEqual([]);
        expect(l5.map((r) => r.a.error?.message)).toEqual([NOT_RUNNING]);
    });

    it("wrong frame: a subframe's isolated code can't call the overlay, and a subframe bridge can't call isolated code", async () => {
        const b = await overlayBridge();
        const sub = iso({ frameId: 3 });
        await sub.call("iso.load", { url: PAGE }, "s1");
        const inBridge = collect(b, "iso.call");
        const subResults = collect(sub, "rpc.result");
        sub.push("rpc.call", call("c1", "overlay:0"), "s1");
        await tick();
        expect(inBridge).toEqual([]);
        expect(subResults.map((r) => r.a.error?.message)).toEqual([NOT_RUNNING]);

        const top = iso();
        await top.call("iso.load", { url: PAGE }, "s1");
        const inTop = collect(top, "rpc.call");
        const subBridge = bridge({ frameId: 3 });
        const subBridgeResults = collect(subBridge, "iso.result");
        subBridge.push("iso.call", call("c2"), "s1");
        await tick();
        expect(inTop).toEqual([]);
        expect(subBridgeResults).toEqual([]);
    });

    it("wrong script: a bridge without that script's overlay, or a link bound to another script, is ignored", async () => {
        const b = await overlayBridge();
        const l2 = iso();
        await l2.call("iso.load", { url: PAGE }, "s2");
        const in2 = collect(l2, "rpc.call");
        // s2 has no overlay open on this bridge
        b.push("iso.call", call("c1"), "s2");
        await tick();
        expect(in2).toEqual([]);
        // s2's link can't speak for s1
        const inBridge = collect(b, "iso.call");
        l2.push("rpc.call", call("c2", "overlay:0"), "s1");
        await tick();
        expect(inBridge).toEqual([]);
        // nor answer a call made to s1's code
        const l1 = iso();
        await l1.call("iso.load", { url: PAGE }, "s1");
        const results = collect(b, "iso.result");
        b.push("iso.call", call("c3"), "s1");
        await tick();
        l2.push("rpc.result", { cid: "c3", ok: true, value: "forged" } as RpcResult, "s2");
        l2.push("rpc.result", { cid: "c3", ok: true, value: "forged" } as RpcResult, "s1");
        await tick();
        expect(results).toEqual([]);
        l1.push("rpc.result", { cid: "c3", ok: true, value: "real" } as RpcResult, "s1");
        await tick();
        expect(results.map((r) => r.a.value)).toEqual(["real"]);
    });

    it("user scripts off: the overlay's call rejects with the hint", async () => {
        off = true;
        const b = await overlayBridge();
        const results = collect(b, "iso.result");
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        b.push("iso.call", call("c1"), "s1");
        await vi.advanceTimersByTimeAsync(5100);
        vi.useRealTimers();
        await tick();
        expect(results.map((r) => r.a.error?.message)).toEqual([USER_SCRIPTS_OFF]);
    });

    it("a closing side answers the other's pending calls; overlay.closed and iso.update reach the isolated link", async () => {
        const b = await overlayBridge();
        const l = iso();
        await l.call("iso.load", { url: PAGE }, "s1");
        const closed = collect(l, "overlay.closed");
        const updates = collect(l, "iso.update");
        const toIso = collect(l, "rpc.result");
        l.push("rpc.call", call("c1", "overlay:0"), "s1");
        await tick();
        pushIsoUpdate();
        b.push("overlay.closed", {} as any, "s1");
        await tick();
        expect(closed).toHaveLength(1);
        expect(updates).toHaveLength(1);
        b.close("gone");
        await tick();
        expect(toIso.map((r) => r.a.error?.name)).toEqual(["DisconnectedError"]);

        const b2 = await overlayBridge();
        const toBridge = collect(b2, "iso.result");
        b2.push("iso.call", call("c2"), "s1");
        await tick();
        l.close("gone");
        await tick();
        expect(toBridge.map((r) => r.a.error?.name)).toEqual(["DisconnectedError"]);
    });
});
