import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { makePageShim, domHandlersFor } from "../src/shared/pageShim";
import { isNetKind, isPageLayer, normalizeRoute, pageWorld, routeLabel } from "../src/shared/route";
import { inertRemote } from "../src/shared/remote";

const shim = (world?: "page" | "isolated") => makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world });

describe("wt.onPage", () => {
    it("is onDocument under a new name, sharing its index sequence", () => {
        const c = compileScript(`wt.onPage("*://a.com/*", () => {});\nwt.onDocument("*://b.com/*", () => {});`);
        expect(c.error).toBeNull();
        const [a, b] = c.handlers.onDocument.map((h) => h.route);
        expect(a.kind).toBe("onDocument");
        expect(a.api).toBe("onPage");
        expect(b.api).toBeUndefined();
        expect([a.index, b.index]).toEqual([0, 1]);
        expect(routeLabel(a)).toContain("onPage");
        expect(routeLabel(b)).toContain("onDocument");
    });

    it("runs isolated by default; world \"page\" (or its old name \"main\") runs in the page", () => {
        const c = compileScript(
            `wt.onPage({ url: "*", world: "isolated" }, () => {});\nwt.onPage({ url: "*", world: "page" }, () => {});\nwt.onPage({ url: "*", world: "main" }, () => {});\nwt.onPage("*", () => {});\nwt.onDocument("*", () => {});`
        );
        expect(c.error).toBeNull();
        const [iso, page, main, plain, legacy] = c.handlers.onDocument.map((h) => h.route);
        expect(iso.world).toBe("isolated");
        expect("world" in page).toBe(false);
        expect([iso, page, main, plain, legacy].map(pageWorld)).toEqual(["isolated", "page", "page", "isolated", "isolated"]);
    });

    it("rejects a bad world, and world on onOverlay/network routes", () => {
        expect(() => normalizeRoute("onDocument", { url: "*", world: "MAIN" }, 0, "onPage")).toThrow(/wt\.onPage: world must be "isolated" or "page"/);
        expect(() => normalizeRoute("onOverlay", { url: "*", world: "isolated" }, 0)).toThrow(/world/);
        expect(() => normalizeRoute("onRequest", { url: "*", world: "isolated" }, 0)).toThrow(/world/);
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
        `wt.onOverlay("*", () => {});`,
        `wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => {});`,
        `wt.onPage({ url: "*", js: "isolated", dom: "page" }, () => {});`,
    ].join("\n");

    it("js picks the world, dom: \"overlay\" registers an overlay handler", () => {
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const [page, iso] = c.handlers.onDocument.map((h) => h.route);
        expect(pageWorld(page)).toBe("page");
        expect(pageWorld(iso)).toBe("isolated");
        const [frame, legacy, layer] = c.handlers.onOverlay.map((h) => h.route);
        expect([frame.index, legacy.index, layer.index]).toEqual([0, 1, 2]);
        expect(frame.api).toBe("onPage");
        expect(legacy.api).toBeUndefined();
        expect([frame, legacy, layer].map(isPageLayer)).toEqual([false, false, true]);
    });

    it("labels number wt.onPage calls in source order, of either kind", () => {
        const c = compileScript(code);
        const labels = c.meta.routes.map((r) => `${routeLabel(r)}@${r.line}`);
        expect(labels).toEqual(["onPage #1@1", "onPage #4@5", "onPage #2@2", "onOverlay #1@3", "onPage #3@4"]);
    });

    it("js: \"page\" with dom: \"overlay\" needs unsafe: true; unsafe applies to nothing else", () => {
        expect(compileScript(`wt.onPage({ url: "*", js: "page", dom: "overlay" }, () => {});`).error).toMatch(/wt\.onPage: js: "page" with dom: "overlay" .*unsafe: true/);
        expect(compileScript(`wt.onPage({ url: "*", world: "page", dom: "overlay" }, () => {});`).error).toMatch(/unsafe: true/);
        expect(compileScript(`wt.onPage({ url: "*", dom: "overlay", unsafe: true }, () => {});`).error).toBeNull();
        expect(compileScript(`wt.onPage({ url: "*", js: "page", unsafe: true }, () => {});`).error).toMatch(/"unsafe" applies only to js: "page" with dom: "overlay"/);
    });

    it("rejects bad values, js with world, and the options on wt.onOverlay / network routes", () => {
        expect(() => normalizeRoute("onDocument", { url: "*", js: "main" }, 0, "onPage")).toThrow(/js must be "isolated" or "page"/);
        expect(() => normalizeRoute("onDocument", { url: "*", dom: "layer" }, 0, "onPage")).toThrow(/dom must be "page" or "overlay"/);
        expect(() => normalizeRoute("onDocument", { url: "*", js: "page", world: "page" }, 0, "onPage")).toThrow(/old name of "js"/);
        expect(() => normalizeRoute("onOverlay", { url: "*", unsafe: "yes" }, 0, "onPage")).toThrow(/unsafe must be true or false/);
        expect(() => normalizeRoute("onOverlay", { url: "*", js: "page" }, 0)).toThrow(/"js" applies to wt\.onPage only/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: "page", dom: "overlay" }, 0)).toThrow(/"dom" applies to onPage only/);
    });

    it("the page shim counts overlay calls like the background, and collects the page-world overlay apart", () => {
        const s = shim();
        s.wt.onPage({ url: "*", js: "page" }, () => "page");
        s.wt.onPage({ url: "*", dom: "overlay" }, () => "frame");
        s.wt.onOverlay("*", () => "legacy");
        s.wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => "layer");
        expect(s.dom.map((d) => d.fn({}))).toEqual(["page"]);
        expect(s.layers.map((d) => [d.h, d.fn({}), routeLabel(d.route)])).toEqual([["overlay:2", "layer", "onPage #3"]]);
        const iso = shim("isolated");
        iso.wt.onPage({ url: "*", js: "page", dom: "overlay", unsafe: true }, () => {});
        expect(iso.dom).toEqual([]);
    });
});

describe("wt.onOverlay", () => {
    it("registers an onOverlay route that is not a network kind", () => {
        const c = compileScript(`wt.onOverlay({ url: "*://x.com/*", when: "document_idle" }, () => {});`);
        expect(c.error).toBeNull();
        expect(c.handlers.onOverlay.length).toBe(1);
        const r = c.meta.routes.find((x) => x.kind === "onOverlay")!;
        expect(r.when).toBe("document_idle");
        expect(isNetKind(r.kind)).toBe(false);
        expect(isNetKind("onDocument")).toBe(false);
        expect(isNetKind("onRequest")).toBe(true);
    });
});

describe("page shim worlds", () => {
    const src = (wt: any) => {
        wt.onPage({ url: "*://a.com/*", world: "page" }, () => "page");
        wt.onPage("*://a.com/*", () => "iso");
        wt.onDocument({ url: "*://a.com/*", world: "main" }, () => "legacy");
    };

    it("page collects only page-world handlers, with background-matching indexes", () => {
        const s = shim();
        src(s.wt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["page", "legacy"]);
        expect(s.dom.map((d) => d.route.index)).toEqual([0, 2]);
    });

    it("isolated collects only isolated handlers", () => {
        const s = shim("isolated");
        src(s.wt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["iso"]);
        expect(domHandlersFor(s.dom, "https://b.com/").length).toBe(0);
    });

    it("onOverlay handles reject; the page world says why", async () => {
        await expect(shim().wt.onOverlay("*", () => {}).ping()).rejects.toThrow(/isolated/);
        await expect(shim("isolated").wt.onOverlay("*", () => {}).ping()).rejects.toThrow(/overlay/);
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
