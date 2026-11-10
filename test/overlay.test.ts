// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { endpointPair, type Endpoint, type OverlayInit } from "../src/shared/wire";
import { StoreOwner, type StoreOwnerDeps } from "../src/background/engine/storeOwner";
import { startOverlay, type OverlayRuntime } from "../src/overlay/overlayRuntime";
import { clipPathFor, normalizeRects, MAX_RECTS, type Rect } from "../src/shared/overlayRects";
import { DisconnectedError, type RpcCall, type RpcResult } from "../src/shared/rpc";
import { toWireResponse } from "../src/shared/wtFetch";
import { ReplicaHub } from "../src/shared/storeReplica";

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function memDeps(): StoreOwnerDeps {
    const storage = new Map<string, Record<string, any>>();
    return {
        storageAll: async (s) => structuredClone(storage.get(s) ?? {}),
        storageSet: async (s, k, v) => {
            const o = storage.get(s) ?? {};
            o[k] = structuredClone(v);
            storage.set(s, o);
        },
        sessionGet: async () => undefined,
        sessionSet: async () => {},
        persistDelayMs: 1,
        sessionDelayMs: 1,
    };
}

interface Harness {
    rt: OverlayRuntime;
    bridge: Endpoint;
    owner: StoreOwner;
    logs: { level: string; msg: string }[];
    pageFetches: { url: string; method: string; credentials?: string; bypass: boolean }[];
    bgFetches: string[];
    calls: RpcCall[];
    rects: Rect[][];
    storage: Map<string, any>;
    /** shortcut.add / shortcut.remove as the bridge got them */
    keys: string[];
}

let running: OverlayRuntime[] = [];
afterEach(() => {
    for (const r of running) r.stop();
    running = [];
    document.body.innerHTML = "";
    document.head.innerHTML = "";
});

/** an overlay frame wired to a fake bridge (the L3 provider) */
async function start(code: string, over: Partial<OverlayInit> = {}): Promise<Harness> {
    const [frame, bridge] = endpointPair();
    const owner = new StoreOwner(memDeps());
    const h: Omit<Harness, "rt"> = { bridge, owner, logs: [], pageFetches: [], bgFetches: [], calls: [], rects: [], storage: new Map(), keys: [] };
    // the store ops go to the owner, as the bridge relays them over L2
    owner.attach(bridge, { all: false });
    bridge.handle("pagefetch", async ({ request, bypass }) => {
        h.pageFetches.push({ url: request.url, method: request.method, credentials: request.credentials, bypass });
        return toWireResponse(new Response(JSON.stringify({ from: "page", url: request.url }), { headers: { "content-type": "application/json" } }));
    });
    bridge.handle("fetch", async ({ request }) => {
        h.bgFetches.push(request.url);
        return toWireResponse(new Response("bg"));
    });
    bridge.handle("storage.get", async ({ key }) => ({ value: h.storage.get(key) }));
    bridge.handle("storage.set", async ({ key, value }) => (h.storage.set(key, value), {}));
    bridge.on("log", (a) => h.logs.push(a));
    bridge.on("rpc.call", (c) => h.calls.push(c));
    bridge.on("rects", (a) => h.rects.push(a.rects));
    bridge.on("shortcut.add", (a) => h.keys.push(`add ${a.id} ${a.keys} ${a.priority}`));
    bridge.on("shortcut.remove", (a) => h.keys.push(`remove ${a.id}`));
    const init: OverlayInit = { s: "s1", name: "demo", code, codeHash: "h", routes: [], url: "https://x.com/app/page", params: {}, stores: {}, page: "p1", libs: [], react: false, phase: "document_end", ...over } as OverlayInit;
    const rt = await startOverlay(frame, init, { win: window as any, doc: document, watchRects: false, trustedKey: () => true });
    running.push(rt);
    return { ...h, rt };
}

const answer = (h: Harness, value: any) => h.bridge.push("rpc.result", { cid: h.calls[h.calls.length - 1].cid, ok: true, value });
const callOverlay = (h: Harness, call: Omit<RpcCall, "cid">): Promise<RpcResult> =>
    new Promise((resolve) => {
        const cid = Math.random().toString(36).slice(2);
        h.bridge.on("rpc.result", (r) => r.cid === cid && resolve(r));
        h.bridge.push("rpc.call", { cid, ...call });
    });

describe("overlay runtime", () => {
    it("runs overlay handlers whose route matches, at their `when`; network and onPage registrations stay inert", async () => {
        const h = await start(`
            wt.onRequest({ url: "*", strategy: "page" }, () => { throw new Error("network handlers don't run here"); });
            wt.onPage("*", () => { document.body.dataset.page = "ran"; });
            wt.onOverlay("*://x.com/*", (ctx) => { document.body.dataset.a = ctx.url; });
            wt.onOverlay({ url: "*://x.com/*", when: "document_idle" }, () => { document.body.dataset.b = "1"; });
            wt.onOverlay("*://other.com/*", () => { document.body.dataset.c = "1"; });
        `);
        expect(document.body.dataset.a).toBe("https://x.com/app/page");
        expect(document.body.dataset.b).toBeUndefined();
        expect(document.body.dataset.c).toBeUndefined();
        expect(document.body.dataset.page).toBeUndefined();
        h.bridge.push("when", { phase: "document_idle" });
        await settle();
        expect(document.body.dataset.b).toBe("1");
        expect([...h.rt.ran]).toEqual([0, 1]);
        expect(h.logs.filter((l) => l.level === "error")).toEqual([]);
    });

    it("a save runs its handlers at once, whatever their `when`", async () => {
        const code = `wt.onOverlay({ url: "*", when: "document_idle" }, () => { document.body.dataset.idle = String(Number(document.body.dataset.idle || 0) + 1); });`;
        const h = await start(code, { phase: "document_start" });
        await settle();
        expect(document.body.dataset.idle).toBeUndefined();
        h.bridge.push("overlay.update", { s: "s1", name: "demo", code: code + "\n// v2", codeHash: "h2", routes: [], url: "https://x.com/app/page", params: {}, stores: {}, page: "p1", libs: [], react: false, phase: "document_start" } as OverlayInit);
        await settle();
        expect(document.body.dataset.idle).toBe("1");
        h.bridge.push("when", { phase: "document_idle" });
        await settle();
        expect(document.body.dataset.idle).toBe("1");
        delete document.body.dataset.idle;
    });

    it("reports handler errors and compile errors to the script's log", async () => {
        const h = await start(`wt.onOverlay("*", () => { throw new Error("kaboom"); });`);
        await settle();
        expect(h.logs.some((l) => l.level === "error" && /kaboom/.test(l.msg) && /demo/.test(l.msg))).toBe(true);
        const r = await callOverlay(h, { h: "onOverlay:0", fn: "f", args: [] });
        expect(r.error?.message).toMatch(/not running/);
        const bad = await start(`wt.onOverlay("*", () => {}`);
        await settle();
        expect(bad.logs.some((l) => l.level === "error" && /compile/.test(l.msg))).toBe(true);
    });

    it("`fetch` and `wt.fetch` fetch as the page (relative URLs against the page); from: \"background\" goes to the background", async () => {
        const g = await start(`wt.onOverlay("*", () => ({ go: async () => [await (await fetch("/api/x")).json(), await (await wt.fetch("https://x.com/y", { method: "POST", body: "b" })).json(), await (await wt.fetch("https://api.z/q", { from: "background" })).text()] }));`);
        const r = await callOverlay(g, { h: "onOverlay:0", fn: "go", args: [] });
        expect(r.ok).toBe(true);
        expect(r.value).toEqual([{ from: "page", url: "https://x.com/api/x" }, { from: "page", url: "https://x.com/y" }, "bg"]);
        expect(g.pageFetches.map((f) => [f.method, f.url])).toEqual([
            ["GET", "https://x.com/api/x"],
            ["POST", "https://x.com/y"],
        ]);
        expect(g.bgFetches).toEqual(["https://api.z/q"]);
    });

    it("wt.fetch bypass passes through to the bridge", async () => {
        const g = await start(`wt.onOverlay("*", () => ({ go: async () => (await wt.fetch("/raw", { bypass: true })).status }));`);
        expect((await callOverlay(g, { h: "onOverlay:0", fn: "go", args: [] })).value).toBe(200);
        expect(g.pageFetches[0]).toMatchObject({ url: "https://x.com/raw", bypass: true });
    });

    it("stores are replicas of the background's, live both ways", async () => {
        const h = await start(`const st = wt.globalStore("ui", { on: false, n: 0 });\nwt.onOverlay("*", () => ({ flip: () => { st.on = !st.on; return st.on; }, read: () => ({ ...st }) }));`);
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "flip", args: [] })).value).toBe(true);
        await settle();
        expect(h.owner.get("s1", "ui")?.data).toEqual({ on: true, n: 0 });
        // another context (the background, another tab) changes it
        const [a, b] = endpointPair();
        h.owner.attach(a, { all: true });
        const other = new ReplicaHub({ ctx: "bg", log: () => {} });
        other.attach(b);
        const st = other.store("s1", "ui", { on: false, n: 0 });
        await settle();
        st.n = 9;
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "read", args: [] })).value).toEqual({ on: true, n: 9 });
    });

    it("its first render sees the snapshot from hello", async () => {
        const h = await start(`const st = wt.globalStore("ui", { on: false });\nwt.onOverlay("*", () => { document.body.dataset.on = String(st.on); });`, { stores: { ui: { rev: 3, data: { on: true } } as any } });
        expect(document.body.dataset.on).toBe("true");
        void h;
    });

    it("wt.storage goes to the script's storage through the bridge", async () => {
        const h = await start(`wt.onOverlay("*", () => ({ go: async () => { await wt.storage.set("k", 4); return wt.storage.get("k"); } }));`);
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "go", args: [] })).value).toBe(4);
        expect(h.storage.get("k")).toBe(4);
    });

    it("ctx.onNavigate fires for in-place navigations, and ctx.url follows", async () => {
        const h = await start(`wt.onOverlay("*", (ctx) => { const seen = []; const off = ctx.onNavigate((u) => seen.push(u)); return { seen: () => seen, off: () => off() }; });`);
        h.bridge.push("nav", { url: "https://x.com/app/other" });
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "seen", args: [] })).value).toEqual(["https://x.com/app/other"]);
        await callOverlay(h, { h: "onOverlay:0", fn: "off", args: [] });
        h.bridge.push("nav", { url: "https://x.com/app/third" });
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "seen", args: [] })).value).toEqual(["https://x.com/app/other"]);
        // later handlers see the new URL; relative fetches resolve against it
        const g = await start(`wt.onOverlay({ url: "*", when: "document_idle" }, (ctx) => ({ url: () => ctx.url, f: async () => (await (await fetch("rel")).json()).url }));`);
        g.bridge.push("nav", { url: "https://x.com/b/c" });
        g.bridge.push("when", { phase: "document_idle" });
        await settle();
        expect((await callOverlay(g, { h: "onOverlay:0", fn: "url", args: [] })).value).toBe("https://x.com/b/c");
        expect((await callOverlay(g, { h: "onOverlay:0", fn: "f", args: [] })).value).toBe("https://x.com/b/rel");
    });

    it("calls onPage functions through the bridge (onPage:N), and answers calls into its handles (onOverlay:N)", async () => {
        const h = await start(`const page = wt.onPage("*", () => ({ count: () => 0 }));\nwt.onOverlay("*", () => ({ ask: async (sel) => "matches: " + (await page.count(sel)), picked: (t) => "got " + t }));`);
        const asked = callOverlay(h, { h: "onOverlay:0", fn: "ask", args: ["a"] });
        await settle();
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]).toMatchObject({ h: "onPage:0", fn: "count", args: ["a"] });
        answer(h, 3);
        expect((await asked).value).toBe("matches: 3");
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "picked", args: ["DIV"] })).value).toBe("got DIV");
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "nope", args: [] })).error?.message).toMatch(/no such function/);
    });

    it("calls into a handler that hasn't run yet wait for it", async () => {
        const h = await start(`wt.onOverlay({ url: "*", when: "document_idle" }, () => ({ ping: () => "pong" }));`);
        const r = callOverlay(h, { h: "onOverlay:0", fn: "ping", args: [] });
        await settle();
        h.bridge.push("when", { phase: "document_idle" });
        expect((await r).value).toBe("pong");
    });

    it("pending calls into onPage code reject with DisconnectedError when the link closes", async () => {
        const h = await start(`const page = wt.onPage("*", () => ({}));\nwt.onOverlay("*", () => ({ ask: () => page.count().catch((e) => e.name) }));`);
        const asked = callOverlay(h, { h: "onOverlay:0", fn: "ask", args: [] });
        await settle();
        expect(h.calls).toHaveLength(1);
        // only the overlay's pending calls fail; a client of its own handles is rejected the same way
        const client = h.rt.client;
        const p = client.remote("onPage:0").x().catch((e: any) => e);
        h.bridge.close("the bridge went away");
        expect(await p).toBeInstanceOf(DisconnectedError);
        void asked;
    });

    it("ctx.shortcut registers with the bridge, runs on shortcut.fire and on keys pressed in the frame, and unregisters", async () => {
        const h = await start(`wt.onOverlay("*", (ctx) => {
            const seen = [];
            const off = ctx.shortcut("Alt+Shift+H", () => seen.push("h"));
            ctx.shortcut("Mod+K", async () => { seen.push("k"); throw new Error("boom"); }, { priority: "after-page" });
            return { seen: () => seen, off: () => off(), bad: (k, p) => { try { ctx.shortcut(k, () => {}, p && { priority: p }); return "ok"; } catch (e) { return e.message; } } };
        });`);
        await settle();
        expect(h.keys).toEqual(["add 1 Alt+Shift+H before-page", "add 2 Mod+K after-page"]);
        h.bridge.push("shortcut.fire", { id: "2" });
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "seen", args: [] })).value).toEqual(["k"]);
        expect(h.logs.some((l) => l.level === "error" && l.msg.includes("ctx.shortcut") && l.msg.includes("boom"))).toBe(true);
        // focus in the frame: it matches its own keys (in its text fields too)
        const e = new KeyboardEvent("keydown", { key: "H", code: "KeyH", altKey: true, shiftKey: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        const input = document.body.appendChild(document.createElement("input"));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "H", code: "KeyH", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        input.remove();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "seen", args: [] })).value).toEqual(["k", "h", "h"]);
        await callOverlay(h, { h: "onOverlay:0", fn: "off", args: [] });
        await settle();
        expect(h.keys[h.keys.length - 1]).toBe("remove 1");
        h.bridge.push("shortcut.fire", { id: "1" });
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "H", code: "KeyH", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "seen", args: [] })).value).toEqual(["k", "h", "h"]);
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "bad", args: ["Hyper+K"] })).value).toMatch(/unknown modifier/);
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "bad", args: ["Alt+K", "first"] })).value).toMatch(/priority/);
        // "" (a cleared shortcut param) adds nothing
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "bad", args: [""] })).value).toBe("ok");
        await settle();
        expect(h.keys).toHaveLength(3);
    });

    it('ctx.shortcut: a function returning "pass" leaves a key pressed in the frame to the frame', async () => {
        const h = await start(`wt.onOverlay("*", (ctx) => {
            let n = 0;
            ctx.shortcut("Alt+P", () => (n++ % 2 ? undefined : "pass"));
        });`);
        await settle();
        const press = () => {
            const e = new KeyboardEvent("keydown", { key: "p", code: "KeyP", altKey: true, bubbles: true, cancelable: true });
            document.body.dispatchEvent(e);
            return e.defaultPrevented;
        };
        expect([press(), press()]).toEqual([false, true]);
    });

    it("overlay.update recompiles in place: handlers run again, claims carry over, the old run's listeners go", async () => {
        const v1 = `wt.onOverlay("*", (ctx) => {
            ctx.style("b{}");
            const box = ctx.once("box", () => document.body.appendChild(document.createElement("i")));
            box.textContent = "v1";
            ctx.shortcut("Mod+K", () => {});
            return { who: () => "v1" };
        });`;
        const h = await start(v1);
        await settle();
        expect(document.querySelectorAll("i").length).toBe(1);
        const keysBefore = h.keys.length;
        h.bridge.push("overlay.update", { s: "s1", name: "demo", code: v1.replace(/v1/g, "v2"), codeHash: "h2", routes: [], url: "https://x.com/app/page", params: {}, stores: {}, page: "p1", libs: [], react: false, phase: "document_end" } as OverlayInit);
        await settle();
        expect(document.querySelectorAll("i").length).toBe(1);
        expect(document.querySelector("i")!.textContent).toBe("v2");
        expect(document.head.querySelectorAll("style").length).toBe(1);
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "who", args: [] })).value).toBe("v2");
        // the old run's shortcut went; the new run's came
        expect(h.keys.slice(keysBefore).map((k) => k.split(" ")[0])).toEqual(expect.arrayContaining(["remove", "add"]));
        // a broken save keeps the running code
        h.bridge.push("overlay.update", { s: "s1", name: "demo", code: `wt.onOverlay("*", () => {`, codeHash: "h3", routes: [], url: "https://x.com/app/page", params: {}, stores: {}, page: "p1", libs: [], react: false, phase: "document_end" } as OverlayInit);
        await settle();
        expect((await callOverlay(h, { h: "onOverlay:0", fn: "who", args: [] })).value).toBe("v2");
        expect(document.querySelectorAll("i").length).toBe(1);
        // a save without the handler drops what it claimed
        h.bridge.push("overlay.update", { s: "s1", name: "demo", code: ``, codeHash: "h4", routes: [], url: "https://x.com/app/page", params: {}, stores: {}, page: "p1", libs: [], react: false, phase: "document_end" } as OverlayInit);
        await settle();
        expect(document.head.querySelectorAll("style").length).toBe(0);
    });

    it("reports its visible areas", async () => {
        const h = await start(`wt.onOverlay("*", () => { document.body.innerHTML = "<button>hi</button>"; });`);
        h.rt.measure();
        await settle();
        expect(h.rects.length).toBeGreaterThan(0);
        expect(Array.isArray(h.rects[0])).toBe(true);
    });
});

describe("overlay rects", () => {
    it("clips to the viewport, rounds outward, drops empty and contained rects", () => {
        expect(normalizeRects([[10.5, 10.5, 20, 20], [12, 12, 2, 2], [0, 0, 0, 5], [-5, -5, 10, 10], [790, 590, 50, 50]], 800, 600)).toEqual([
            [10, 10, 21, 21],
            [790, 590, 10, 10],
            [0, 0, 5, 5],
        ]);
        expect(normalizeRects([[NaN, 0, 1, 1], [0, 0, Infinity, 1], "x" as any, [1, 2, 3] as any], 800, 600)).toEqual([]);
    });

    it("too many rects become their bounding box", () => {
        const many: Rect[] = Array.from({ length: MAX_RECTS + 1 }, (_, i) => [i * 3, 0, 2, 2]);
        expect(normalizeRects(many, 2000, 600)).toEqual([[0, 0, MAX_RECTS * 3 + 2, 2]]);
    });

    it("clip-path is the union of the rects, nothing when empty", () => {
        expect(clipPathFor([])).toBe("polygon(0 0, 0 0, 0 0)");
        expect(clipPathFor([[1, 2, 3, 4], [10, 10, 5, 5]])).toBe('path("M1 2h3v4h-3zM10 10h5v5h-5z")');
    });
});
