import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { makePageShim, domHandlersFor } from "../src/shared/pageShim";
import { isNetKind, isPageLayer, normalizeRoute, pageWorld, routeLabel } from "../src/shared/route";
import { inertRemote } from "../src/shared/remote";

const shim = (world?: "page" | "isolated") => makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world });

describe("wt.onPage", () => {
    it("registers kind onDocument, labelled onPage", () => {
        const c = compileScript(`wt.onPage("*://a.com/*", () => {});\nwt.onPage("*://b.com/*", () => {});`);
        expect(c.error).toBeNull();
        const [a, b] = c.handlers.onDocument.map((h) => h.route);
        expect(a.kind).toBe("onDocument");
        expect(a.api).toBe("onPage");
        expect([a.index, b.index]).toEqual([0, 1]);
        expect([routeLabel(a), routeLabel(b)]).toEqual(["onPage #1", "onPage #2"]);
    });

    it("runs isolated by default; js \"page\" runs in the page", () => {
        const c = compileScript(`wt.onPage({ url: "*", js: "isolated" }, () => {});\nwt.onPage({ url: "*", js: "page" }, () => {});\nwt.onPage("*", () => {});`);
        expect(c.error).toBeNull();
        const [iso, page, plain] = c.handlers.onDocument.map((h) => h.route);
        expect(iso.world).toBe("isolated");
        expect("world" in page).toBe(false);
        expect([iso, page, plain].map(pageWorld)).toEqual(["isolated", "page", "isolated"]);
    });

    it("returns a handle whose calls reject in the background", async () => {
        const c = compileScript(`module.exports.h = wt.onPage("*", () => ({ f: () => 1 }));`);
        expect(c.error).toBeNull();
        const h = c.exports.h;
        expect(h.then).toBeUndefined();
        await expect(h.f()).rejects.toThrow();
    });
});

describe("wt.onPage js / dom / unsafe", () => {
    const code = [
        `wt.onPage({ url: "*", js: "page" }, () => {});`,
        `wt.onPage({ url: "*", dom: "overlay" }, () => {});`,
        `wt.onPage({ url: "*", dom: "overlay", when: "document_idle" }, () => {});`,
        `wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => {});`,
        `wt.onPage({ url: "*", js: "isolated", dom: "page" }, () => {});`,
    ].join("\n");

    it("js picks the world, dom: \"overlay\" registers an overlay handler", () => {
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const [page, iso] = c.handlers.onDocument.map((h) => h.route);
        expect(pageWorld(page)).toBe("page");
        expect(pageWorld(iso)).toBe("isolated");
        const [frame, idle, layer] = c.handlers.onOverlay.map((h) => h.route);
        expect([frame.index, idle.index, layer.index]).toEqual([0, 1, 2]);
        expect([frame.api, idle.api, layer.api]).toEqual(["onPage", "onPage", "onPage"]);
        expect([frame.when, idle.when]).toEqual(["document_end", "document_idle"]);
        expect([frame, idle, layer].map(isPageLayer)).toEqual([false, false, true]);
        expect(isNetKind(frame.kind)).toBe(false);
        expect(isNetKind("onDocument")).toBe(false);
        expect(isNetKind("onRequest")).toBe(true);
    });

    it("labels number wt.onPage calls in source order, of either kind", () => {
        const c = compileScript(code);
        const labels = c.meta.routes.map((r) => `${routeLabel(r)}@${r.line}`);
        expect(labels).toEqual(["onPage #1@1", "onPage #5@5", "onPage #2@2", "onPage #3@3", "onPage #4@4"]);
    });

    it("js: \"page\" with dom: \"overlay\" needs unsafe: true; unsafe applies to nothing else", () => {
        expect(compileScript(`wt.onPage({ url: "*", js: "page", dom: "overlay" }, () => {});`).error).toMatch(/wt\.onPage: js: "page" with dom: "overlay" .*unsafe: true/);
        expect(compileScript(`wt.onPage({ url: "*", dom: "overlay", unsafe: true }, () => {});`).error).toBeNull();
        expect(compileScript(`wt.onPage({ url: "*", js: "page", unsafe: true }, () => {});`).error).toMatch(/"unsafe" applies only to js: "page" with dom: "overlay"/);
    });

    it("rejects bad values, and the options on network routes", () => {
        expect(() => normalizeRoute("onDocument", { url: "*", js: "main" }, 0, "onPage")).toThrow(/js must be "isolated" or "page"/);
        expect(() => normalizeRoute("onDocument", { url: "*", dom: "layer" }, 0, "onPage")).toThrow(/dom must be "page" or "overlay"/);
        expect(() => normalizeRoute("onOverlay", { url: "*", unsafe: "yes" }, 0, "onPage")).toThrow(/unsafe must be true or false/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: "page", js: "page" }, 0)).toThrow(/"js" applies to onPage only/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: "page", dom: "overlay" }, 0)).toThrow(/"dom" applies to onPage only/);
    });

    it("the page shim counts overlay calls like the background, and collects the page-world overlay apart", () => {
        const s = shim();
        s.wt.onPage({ url: "*", js: "page" }, () => "page");
        s.wt.onPage({ url: "*", dom: "overlay" }, () => "frame");
        s.wt.onPage({ url: "*", dom: "overlay" }, () => "frame 2");
        s.wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => "layer");
        expect(s.dom.map((d) => d.fn({}))).toEqual(["page"]);
        expect(s.layers.map((d) => [d.h, d.fn({}), routeLabel(d.route)])).toEqual([["overlay:2", "layer", "onPage #4"]]);
        const iso = shim("isolated");
        iso.wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => {});
        expect(iso.dom).toEqual([]);
    });
});

describe("page shim worlds", () => {
    const src = (wt: any) => {
        wt.onPage({ url: "*://a.com/*", js: "page" }, () => "page");
        wt.onPage("*://a.com/*", () => "iso");
        wt.onPage({ url: "*://a.com/*", js: "page" }, () => "page 2");
    };

    it("page collects only page-world handlers, with background-matching indexes", () => {
        const s = shim();
        src(s.wt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["page", "page 2"]);
        expect(s.dom.map((d) => d.route.index)).toEqual([0, 2]);
    });

    it("isolated collects only isolated handlers", () => {
        const s = shim("isolated");
        src(s.wt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["iso"]);
        expect(domHandlersFor(s.dom, "https://b.com/").length).toBe(0);
    });

    it("overlay handles reject; the page world says why", async () => {
        await expect(shim().wt.onPage({ url: "*", dom: "overlay" }, () => {}).ping()).rejects.toThrow(/isolated/);
        await expect(shim("isolated").wt.onPage({ url: "*", dom: "overlay" }, () => {}).ping()).rejects.toThrow(/overlay/);
    });

    it("store can be declared at top level but not used; fetch rejects", async () => {
        const s = shim().wt.globalStore("x", { n: 1 });
        expect(s.then).toBeUndefined();
        expect(() => s.n).toThrow(/wt\.globalStore/);
        await expect(shim().wt.fetch("/")).rejects.toThrow(/wt\.fetch/);
    });

    it("isolated code gets the stores it's given; page-world code never does", () => {
        const made: string[] = [];
        const stores = {
            store: (name: string, initial: object, persist: boolean | string[]) => (made.push(`g:${name}:${JSON.stringify(persist)}`), { ...initial }),
            pageStore: (name: string, initial: object) => (made.push(`p:${name}`), { ...initial }),
        };
        const iso = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "isolated", stores });
        expect(iso.wt.globalStore("a", { n: 1 }, { persist: ["n"] }).n).toBe(1);
        expect(iso.wt.pageStore("b", { m: 2 }).m).toBe(2);
        expect(made).toEqual(['g:a:["n"]', "p:b"]);
        expect(() => iso.wt.pageStore("a", {})).toThrow(/already has a store named "a"/);
        expect(() => iso.wt.globalStore("c", [])).toThrow(/initial must be an object/);
        const main = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "page", stores });
        expect(() => main.wt.pageStore("b", { m: 2 }).m).toThrow(/page-world code.*drop js: "page"/);
        expect(made.length).toBe(2);
    });
});

describe("inertRemote", () => {
    it("isn't a thenable or JSON-able, and any method rejects", async () => {
        const r: any = inertRemote("nope");
        expect(r.then).toBeUndefined();
        expect(r.toJSON).toBeUndefined();
        await expect(r.anything(1)).rejects.toThrow("nope");
    });
});
