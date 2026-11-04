import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { makePageShim, domHandlersFor } from "../src/shared/pageShim";
import { isNetKind, normalizeRoute, pageWorld, routeLabel } from "../src/shared/route";
import { inertRemote } from "../src/shared/remote";

const shim = (world?: "main" | "isolated") => makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world });

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

    it("keeps world only when isolated", () => {
        const c = compileScript(`wt.onPage({ url: "*", world: "isolated" }, () => {});\nwt.onPage({ url: "*", world: "main" }, () => {});`);
        const [iso, main] = c.handlers.onDocument.map((h) => h.route);
        expect(iso.world).toBe("isolated");
        expect("world" in main).toBe(false);
        expect(pageWorld(iso)).toBe("isolated");
        expect(pageWorld(main)).toBe("main");
    });

    it("rejects a bad world, and world on onOverlay/network routes", () => {
        expect(() => normalizeRoute("onDocument", { url: "*", world: "page" }, 0, "onPage")).toThrow(/wt\.onPage/);
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
        wt.onPage("*://a.com/*", () => "main");
        wt.onPage({ url: "*://a.com/*", world: "isolated" }, () => "iso");
        wt.onDocument("*://a.com/*", () => "legacy");
    };

    it("main collects only main-world handlers, with background-matching indexes", () => {
        const s = shim();
        src(s.wt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["main", "legacy"]);
        expect(s.dom.map((d) => d.route.index)).toEqual([0, 2]);
    });

    it("isolated collects only isolated handlers", () => {
        const s = shim("isolated");
        src(s.wt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["iso"]);
        expect(domHandlersFor(s.dom, "https://b.com/").length).toBe(0);
    });

    it("onOverlay handles reject; main world says why", async () => {
        await expect(shim().wt.onOverlay("*", () => {}).ping()).rejects.toThrow(/isolated/);
        await expect(shim("isolated").wt.onOverlay("*", () => {}).ping()).rejects.toThrow(/overlay/);
    });

    it("store can be declared at top level but not used; fetch rejects", async () => {
        const s = shim().wt.globalStore("x", { n: 1 });
        expect(s.then).toBeUndefined();
        expect(() => s.n).toThrow(/wt\.globalStore/);
        await expect(shim().wt.fetch("/")).rejects.toThrow(/wt\.fetch/);
    });

    it("isolated code gets the stores it's given; main-world code never does", () => {
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
        const main = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "main", stores });
        expect(() => main.wt.pageStore("b", { m: 2 }).m).toThrow(/main-world page code.*world: "isolated"/);
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
