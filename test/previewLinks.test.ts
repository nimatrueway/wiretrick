import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetched: any[] = [];
const closedStores: string[] = [];
vi.mock("../src/background/engine/stores", () => ({
    fetchFor: async (s: string, request: any, bypass: boolean) => (fetched.push({ s, request, bypass }), { status: 200, statusText: "", headers: [], body: "ok", url: request.url }),
    storeOwner: {
        init: async (ids: string[]) => Object.fromEntries(ids.map((s) => [s, { on: { value: true, persist: true } }])),
        attach: (ep: any) => {
            ep.handle("store.sub", (a: any, s: any) => ({ sub: a, s }));
            ep.onClose((why: string) => closedStores.push(why));
        },
    },
}));
vi.mock("../src/background/engine/bypass", () => ({ addBypass: () => () => {}, addBypassRule: async () => () => {} }));

import { addPreviewPort, confirmNonce, pushPreviewUpdate, resetOverlayLinks, servePreviewLink, setupOverlayLinks, type OverlayRun } from "../src/background/engine/overlayLinks";
import { normalizeRoute } from "../src/shared/route";
import { endpointPair, type Endpoint } from "../src/shared/wire";

const NONCE = "0123456789abcdef0123";
const route = (url: string) => normalizeRoute("onOverlay", { url }, 0);
const run = (name: string, urls: string[]): OverlayRun => ({ name, code: `code ${name}`, codeHash: `h ${name}`, routes: urls.map(route), params: {}, libs: [], react: false });
const scripts: Record<string, OverlayRun> = {};
const logs: any[] = [];
const storage = new Map<string, any>();

function editor(tabId = 7): Endpoint {
    const [bg, ui] = endpointPair();
    servePreviewLink(bg, tabId);
    return ui;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the Editor preview link (L5)", () => {
    beforeEach(() => {
        resetOverlayLinks();
        fetched.length = closedStores.length = logs.length = 0;
        storage.clear();
        for (const k of Object.keys(scripts)) delete scripts[k];
        scripts.s1 = run("One", ["https://app.example/dash/*", "https://other.example/*"]);
        scripts.s2 = run("Two", ["https://two.example/"]);
        vi.stubGlobal("chrome", { runtime: { id: "ext", getURL: (p: string) => `chrome-extension://ext/${p}` } });
        setupOverlayLinks({
            overlayRuns: async () => new Map(),
            previewRun: async (s) => {
                if (s === "broken") throw new Error("the script doesn't compile");
                if (!scripts[s]) throw new Error("no such script");
                return scripts[s];
            },
            storageGet: async (s, key) => storage.get(`${s}/${key}`),
            storageSet: async (s, key, value) => void storage.set(`${s}/${key}`, value),
            log: (tabId, s, level, msg, ctx) => logs.push({ tabId, s, level, msg, ctx }),
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("only the Editor page of this extension gets a preview port", () => {
        const port = (sender: any, name = "tt-preview") => ({ name, sender, disconnect: vi.fn(), onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) as any;
        const other = port({ id: "ext", url: "chrome-extension://ext/editor.html" }, "logs");
        expect(addPreviewPort(other)).toBe(false);
        for (const sender of [
            { id: "ext", url: "https://evil.example/editor.html", tab: { id: 1 } },
            { id: "ext", url: "chrome-extension://ext/overlay.html#nonce", tab: { id: 1 } },
            { id: "other", url: "chrome-extension://ext/editor.html" },
            { id: "ext" },
        ]) {
            const p = port(sender);
            expect(addPreviewPort(p)).toBe(true);
            expect(p.disconnect).toHaveBeenCalled();
        }
        const ok = port({ id: "ext", url: "chrome-extension://ext/editor.html?script=s1#x", tab: { id: 3 } });
        expect(addPreviewPort(ok)).toBe(true);
        expect(ok.disconnect).not.toHaveBeenCalled();
    });

    it("preview.open: the routes' first URL by default, or the one asked for; says how many handlers match", async () => {
        const e = editor();
        expect(await e.call("preview.open", { nonce: NONCE, url: "" }, "s1")).toEqual({ url: "https://app.example/dash/", name: "One", handlers: 2, matching: 1 });
        expect(await e.call("preview.open", { nonce: NONCE, url: "https://nowhere.example/" }, "s1")).toMatchObject({ url: "https://nowhere.example/", matching: 0 });
        await expect(e.call("preview.open", { nonce: NONCE, url: "not a url" }, "s1")).rejects.toThrow(/isn't a URL/);
        await expect(e.call("preview.open", { nonce: "short", url: "" }, "s1")).rejects.toThrow(/refused/);
        await expect(e.call("preview.open", { nonce: NONCE, url: "" }, "broken")).rejects.toThrow(/doesn't compile/);
        await expect(e.call("preview.open", { nonce: NONCE, url: "" }, "nope")).rejects.toThrow(/no such script/);
    });

    it("everything is for the previewed script only, and only once it's open", async () => {
        const e = editor();
        await expect(e.call("overlay.init", {}, "s1")).rejects.toThrow(/isn't previewed/);
        await expect(e.call("fetch", { request: { method: "GET", url: "https://x/" } } as any, "s1")).rejects.toThrow(/isn't previewed/);
        await e.call("preview.open", { nonce: NONCE, url: "https://other.example/a" }, "s1");
        expect(await e.call("overlay.init", {}, "s1")).toMatchObject({ s: "s1", name: "One", code: "code One", url: "https://other.example/a", stores: { on: { value: true } } });
        await expect(e.call("overlay.init", {}, "s2")).rejects.toThrow(/isn't previewed/);
        await expect(e.call("store.sub", { name: "on" }, "s2")).rejects.toThrow(/isn't previewed/);
        expect(await e.call("store.sub", { name: "on" }, "s1")).toEqual({ sub: { name: "on" }, s: "s1" });
        await e.call("fetch", { request: { method: "GET", url: "https://x/" }, bypass: false } as any, "s1");
        expect(fetched).toEqual([{ s: "s1", request: { method: "GET", url: "https://x/" }, bypass: false }]);
        await e.call("storage.set", { key: "k", value: 1 }, "s1");
        expect(await e.call("storage.get", { key: "k" }, "s1")).toEqual({ value: 1 });
        e.push("log", { level: "warn", msg: "hi" }, "s1");
        e.push("log", { level: "warn", msg: "not mine" }, "s2");
        await tick();
        expect(logs).toEqual([{ tabId: -1, s: "s1", level: "warn", msg: "hi", ctx: "overlay › preview" }]);
    });

    it("moving to another script closes the old one's store link; closing the preview closes it too", async () => {
        const e = editor();
        await e.call("preview.open", { nonce: NONCE, url: "" }, "s1");
        await e.call("store.sub", { name: "on" }, "s1");
        await e.call("preview.open", { nonce: NONCE, url: "" }, "s1");
        await tick();
        expect(closedStores).toEqual([]);
        await e.call("preview.open", { nonce: NONCE, url: "" }, "s2");
        await tick();
        expect(closedStores).toHaveLength(1);
        await expect(e.call("store.sub", { name: "on" }, "s1")).rejects.toThrow(/isn't previewed/);
        await e.call("store.sub", { name: "on" }, "s2");
        e.close("bye");
        await tick();
        expect(closedStores).toHaveLength(2);
    });

    it("the Firefox frame's nonce check: the Editor's tab, once", async () => {
        const e = editor(7);
        await e.call("preview.open", { nonce: NONCE, url: "" }, "s1");
        const frame = { tab: { id: 7 }, url: "chrome-extension://ext/overlay.html#" + NONCE } as any;
        expect(confirmNonce({ ...frame, tab: { id: 8 } }, NONCE)).toBe(false);
        expect(confirmNonce({ ...frame, url: "chrome-extension://ext/editor.html" }, NONCE)).toBe(false);
        expect(confirmNonce(frame, NONCE)).toBe(true);
        expect(confirmNonce(frame, NONCE)).toBe(false);
    });

    it("scripts changing reach every open preview", async () => {
        const e = editor();
        const got: any[] = [];
        e.on("bundle.update", (a) => got.push(a));
        pushPreviewUpdate([{ s: "s1", codeHash: "x" }]);
        await tick();
        expect(got).toEqual([{ scripts: [{ s: "s1", codeHash: "x" }] }]);
    });
});
