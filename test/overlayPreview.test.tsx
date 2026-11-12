import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { ref } from "valtio";
import { endpointPair, messagePortEndpoint, type Endpoint } from "../src/shared/wire";
import { NO_PAGE_IN_PREVIEW } from "../src/shared/rpc";

function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
        get length() {
            return m.size;
        },
        key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => m.get(k) ?? null,
        setItem: (k, v) => void m.set(k, String(v)),
        removeItem: (k) => void m.delete(k),
        clear: () => m.clear(),
    };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** a fake background: the L5 handlers the preview uses, and what it was asked */
function background() {
    const calls: { op: string; a: any; s?: string }[] = [];
    const links: Endpoint[] = [];
    let hash = "h1";
    let failOpen = "";
    const connect = () => {
        const [ui, bg] = endpointPair();
        links.push(bg);
        bg.handle("preview.open", (a, s) => {
            calls.push({ op: "preview.open", a, s });
            if (failOpen) throw new Error(`preview.open: ${failOpen}`);
            return { url: a.url || "https://app.example/", name: "Switch", handlers: 2, matching: a.url.includes("nowhere") ? 0 : 1 };
        });
        bg.handle("overlay.init", (_a, s) => ({ s: s!, name: "Switch", code: "", codeHash: hash, routes: [], url: "https://app.example/", params: {}, stores: {}, page: "p1", libs: [], react: false }));
        bg.handle("store.sub", (a, s) => (calls.push({ op: "store.sub", a, s }), { rev: 1, data: { on: false }, ops: [] }));
        bg.handle("fetch", (a, s) => (calls.push({ op: "fetch", a, s }), { status: 200, statusText: "", headers: [], body: "ok", url: a.request.url }) as any);
        bg.on("store.set", (a, s) => calls.push({ op: "store.set", a, s }));
        bg.on("log", (a, s) => calls.push({ op: "log", a, s }));
        return ui;
    };
    return {
        calls,
        links,
        connect,
        setHash: (h: string) => void (hash = h),
        failOpen: (why: string) => void (failOpen = why),
        opens: () => calls.filter((c) => c.op === "preview.open"),
    };
}

/** a stand-in for the frame's window: catches the port the host hands it */
function fakeFrame() {
    let port: MessagePort | null = null;
    const win = { postMessage: (msg: any, _o: string, ports: MessagePort[]) => msg?.ttOverlay === true && (port = ports[0]) } as unknown as Window;
    return { win, ep: () => messagePortEndpoint(port!) };
}

let bg: ReturnType<typeof background>;
let mod: typeof import("../src/ui/state/preview");

beforeEach(async () => {
    cleanup();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("chrome", { runtime: { id: "ext", getURL: (p: string) => `chrome-extension://ext/${p}` } });
    vi.resetModules();
    mod = await import("../src/ui/state/preview");
    bg = background();
    mod.setPreviewConnect(bg.connect);
});
afterEach(() => {
    mod.stopPreview();
    vi.unstubAllGlobals();
});

describe("preview host (state/preview.ts)", () => {
    it("opens the script with a fresh nonce; the frame proves it with that nonce and starts at document_idle", async () => {
        mod.showPreview("s1");
        await tick();
        const { preview } = mod;
        expect(bg.opens()).toEqual([{ op: "preview.open", a: { nonce: preview.nonce, url: "" }, s: "s1" }]);
        expect(preview).toMatchObject({ scriptId: "s1", status: "loading", url: "https://app.example/", name: "Switch", handlers: 2, matching: 1, frameKey: 1 });
        expect(preview.nonce).toMatch(/^[0-9a-f]{32}$/);

        const bad = fakeFrame();
        mod.attachFrame(bad.win);
        await expect(bad.ep().call("hello", { nonce: "f".repeat(32) })).rejects.toThrow(/refused/);

        const f = fakeFrame();
        mod.attachFrame(f.win);
        const frame = f.ep();
        expect(await frame.call("hello", { nonce: preview.nonce })).toMatchObject({ s: "s1", codeHash: "h1", phase: "document_idle" });
        expect(preview.status).toBe("ready");
        await expect(frame.call("hello", { nonce: preview.nonce })).rejects.toThrow(/refused/);
        frame.close();
    });

    it("relays the frame's stores, fetches, storage and logs for that script; page fetches run from the background; onPage calls fail", async () => {
        mod.showPreview("s1");
        await tick();
        const f = fakeFrame();
        mod.attachFrame(f.win);
        const frame = f.ep();
        const patches: any[] = [];
        const results: any[] = [];
        frame.on("store.patch", (a) => patches.push(a));
        frame.on("rpc.result", (r) => results.push(r));
        await frame.call("hello", { nonce: mod.preview.nonce });

        expect(await frame.call("store.sub", { name: "on" })).toEqual({ rev: 1, data: { on: false }, ops: [] });
        frame.push("store.set", { name: "on", op: "o1", ops: [] } as any);
        frame.push("log", { level: "info", msg: "hello" });
        await frame.call("fetch", { request: { method: "GET", url: "https://api.example/a", headers: [] }, bypass: false });
        expect(mod.preview.bgFetches).toBe(0);
        await frame.call("pagefetch", { request: { method: "GET", url: "https://app.example/me", headers: [] }, bypass: true });
        expect(mod.preview.bgFetches).toBe(1);
        await tick();
        expect(bg.calls.filter((c) => c.op !== "preview.open").map((c) => [c.op, c.s])).toEqual([
            ["store.sub", "s1"],
            ["store.set", "s1"],
            ["log", "s1"],
            ["fetch", "s1"],
            ["fetch", "s1"],
        ]);
        expect(bg.calls[bg.calls.length - 1].a).toMatchObject({ request: { url: "https://app.example/me" }, bypass: true });

        bg.links[0].push("store.patch", { name: "on", rev: 2, ops: [] }, "s1");
        bg.links[0].push("store.patch", { name: "on", rev: 9, ops: [] }, "other");
        frame.push("rpc.call", { cid: "c1", h: "page:0", fn: "highlight", args: [] });
        await tick();
        expect(patches).toEqual([{ name: "on", rev: 2, ops: [] }]);
        expect(results).toEqual([{ cid: "c1", ok: false, error: { name: "WtCallError", message: NO_PAGE_IN_PREVIEW } }]);
        frame.close();
    });

    it("a save updates the running frame in place when the overlay changed; a new URL is remembered per script", async () => {
        mod.showPreview("s1");
        await tick();
        const f = fakeFrame();
        mod.attachFrame(f.win);
        const fep = f.ep();
        const updates: any[] = [];
        fep.on("overlay.update", (a) => void updates.push(a));
        await fep.call("hello", { nonce: mod.preview.nonce });
        bg.links[0].push("bundle.update", { scripts: [] });
        await tick();
        expect(updates).toHaveLength(0);
        bg.setHash("h2");
        bg.links[0].push("bundle.update", { scripts: [] });
        await tick();
        expect(bg.opens()).toHaveLength(1);
        expect(updates).toEqual([expect.objectContaining({ codeHash: "h2", phase: "document_idle" })]);
        expect(mod.preview).toMatchObject({ status: "ready", frameKey: 1 });

        mod.setPreviewUrl("https://nowhere.example/x");
        await tick();
        expect(bg.opens().slice(-1)[0].a.url).toBe("https://nowhere.example/x");
        expect(mod.preview.matching).toBe(0);
        expect(JSON.parse(localStorage.getItem("resPreview")!)).toEqual({ urls: { s1: "https://nowhere.example/x" } });
        mod.setPreviewUrl("");
        await tick();
        expect(bg.opens().slice(-1)[0].a.url).toBe("");
    });

    it("says why there's nothing to preview, and opens again when the link drops", async () => {
        bg.failOpen("the script has no overlay handler");
        mod.showPreview("s1");
        await tick();
        expect(mod.preview).toMatchObject({ status: "error", message: "the script has no overlay handler", nonce: "" });
        bg.failOpen("");
        bg.links[0].close("service worker restarted");
        await tick(700);
        expect(bg.links).toHaveLength(2);
        expect(mod.preview.status).toBe("loading");
        expect(mod.preview.nonce).not.toBe("");
        mod.stopPreview();
        await tick();
        expect(bg.links[1].closed).toBe(true);
        expect(mod.preview).toMatchObject({ scriptId: null, status: "idle", nonce: "" });
    });
});

describe("the Preview tab (OverlayPreview.tsx)", () => {
    async function setup() {
        // happy-dom doesn't load frames, and says so
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { explorer } = await import("../src/ui/state/explorer");
        const { layout } = await import("../src/ui/state/layout");
        const { actions } = await import("../src/ui/shell/actions");
        actions.showPanelTab = (t) => void (layout.panelTab = t);
        layout.panelHidden = false;
        layout.panelTab = "log";
        explorer.scripts = ref([{ id: "s1", meta: { name: "Switch" } } as any]);
        explorer.selectedId = "s1";
        for (const id of ["editor-area", "app", "sidebar"]) document.body.appendChild(Object.assign(document.createElement("div"), { id }));
        const { PanelDock } = await import("../src/ui/panel/PanelDock");
        render(<PanelDock />);
        return { explorer, layout };
    }
    afterEach(() => {
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    it("is a tab next to the others with a key hint, and runs the open script only while it shows", async () => {
        const { explorer, layout } = await setup();
        const tab = document.getElementById("preview-tab")!;
        expect(tab.textContent).toBe("Preview");
        expect(tab.title).toMatch(/\(Alt\+Shift\+V\)$/);
        expect([...document.querySelectorAll("#panel-tabs .panel-tab")].map((t) => t.textContent)).toEqual(["Problems", "Log", "Network", "Preview"]);
        expect(document.getElementById("preview-view")).toBeNull();
        expect(bg.links).toHaveLength(0);

        await act(async () => {
            fireEvent.click(tab);
            await tick();
        });
        expect(layout.panelTab).toBe("preview");
        expect(document.getElementById("preview-tools")!.hidden).toBe(false);
        const frame = document.querySelector<HTMLIFrameElement>("#preview-view iframe")!;
        expect(frame.getAttribute("src")).toBe(`chrome-extension://ext/overlay.html#${mod.preview.nonce}`);
        expect((document.getElementById("preview-url") as HTMLInputElement).value).toBe("https://app.example/");

        // another file: nothing to preview
        await act(async () => {
            explorer.selectedId = "__settings__";
            await tick();
        });
        expect(document.querySelector("#preview-view .preview-msg")!.textContent).toMatch(/Open a script/);
        expect(document.querySelector("#preview-view iframe")).toBeNull();

        await act(async () => {
            explorer.selectedId = "s1";
            await tick();
        });
        expect(bg.opens()).toHaveLength(2);
        await act(async () => {
            layout.panelTab = "log";
            await tick();
        });
        expect(document.getElementById("preview-view")).toBeNull();
        expect(bg.links.every((l) => l.closed)).toBe(true);
    });

    it("its tools: the URL applies on Enter, the viewport sizes the page, and a page fetch shows the badge", async () => {
        const { layout } = await setup();
        await act(async () => {
            layout.panelTab = "preview";
            await tick();
        });
        const url = document.getElementById("preview-url") as HTMLInputElement;
        await act(async () => {
            fireEvent.change(url, { target: { value: "https://nowhere.example/" } });
            fireEvent.keyDown(url, { key: "Enter" });
            await tick();
        });
        expect(bg.opens().slice(-1)[0].a.url).toBe("https://nowhere.example/");
        expect(document.getElementById("preview-nomatch")).toBeNull(); // not ready yet: no frame said hello

        const select = document.getElementById("preview-viewport") as HTMLSelectElement;
        await act(async () => {
            fireEvent.change(select, { target: { value: "390×844" } });
            await tick();
        });
        const page = document.querySelector<HTMLElement>("#preview-view .preview-page")!;
        expect([page.style.width, page.style.height]).toEqual(["390px", "844px"]);

        expect(document.getElementById("preview-bg-badge")).toBeNull();
        await act(async () => {
            mod.preview.bgFetches = 2;
            mod.preview.status = "ready";
            await tick();
        });
        expect(document.getElementById("preview-bg-badge")!.title).toMatch(/2 page fetches/);
        expect(document.getElementById("preview-nomatch")).not.toBeNull();
    });
});
