import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { makePageShim, domHandlersFor } from "../src/shared/pageShim";
import { isNetKind, normalizeRoute, pageWorld, routeLabel } from "../src/shared/route";
import { inertRemote, SITE_NO_STORES, SiteCannotCallError } from "../src/shared/remote";

const shim = (world?: "page" | "isolated") => makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world });

describe("tt.onPage", () => {
    it("registers kind onDocument, labelled onPage", () => {
        const c = compileScript(`tt.onPage("*://a.com/*", () => {});\ntt.onPage("*://b.com/*", () => {});`);
        expect(c.error).toBeNull();
        const [a, b] = c.handlers.onDocument.map((h) => h.route);
        expect(a.kind).toBe("onDocument");
        expect(a.api).toBe("onPage");
        expect([a.index, b.index]).toEqual([0, 1]);
        expect([routeLabel(a), routeLabel(b)]).toEqual(["onPage #1", "onPage #2"]);
    });

    it("tt.onSite runs in the site's world, tt.onPage in the isolated world", () => {
        const c = compileScript(`tt.onPage("*", () => {});\ntt.onSite("*", () => {});\ntt.onPage({ url: "*", when: "document_idle" }, () => {});`);
        expect(c.error).toBeNull();
        const [iso, site, idle] = c.handlers.onDocument.map((h) => h.route);
        expect([iso, site, idle].map(pageWorld)).toEqual(["isolated", "page", "isolated"]);
        expect([iso, site, idle].map((r) => r.api)).toEqual(["onPage", "onSite", "onPage"]);
        expect([iso, site, idle].map((r) => r.key)).toEqual(["onPage:0", "onSite:0", "onPage:1"]);
        expect([iso, site, idle].map(routeLabel)).toEqual(["onPage #1", "onSite #1", "onPage #2"]);
        expect([iso, site, idle].map((r) => r.when)).toEqual(["document_end", "document_start", "document_idle"]);
    });

    it("returns a handle whose calls reject in the background", async () => {
        const c = compileScript(`module.exports.h = tt.onPage("*", () => ({ f: () => 1 }));`);
        expect(c.error).toBeNull();
        const h = c.exports.h;
        expect(h.then).toBeUndefined();
        await expect(h.f()).rejects.toThrow();
    });
});

describe("tt.onOverlay", () => {
    const code = [`tt.onSite("*", () => {});`, `tt.onOverlay("*", () => {});`, `tt.onOverlay({ url: "*", when: "document_idle" }, () => {});`, `tt.onPage("*", () => {});`].join("\n");

    it("registers overlay handlers, keyed and labelled apart from page handlers", () => {
        const c = compileScript(code);
        expect(c.error).toBeNull();
        const [frame, idle] = c.handlers.onOverlay.map((h) => h.route);
        expect([frame.index, idle.index]).toEqual([0, 1]);
        expect([frame.key, idle.key]).toEqual(["onOverlay:0", "onOverlay:1"]);
        expect([frame.when, idle.when]).toEqual(["document_end", "document_idle"]);
        expect(isNetKind(frame.kind)).toBe(false);
        expect(isNetKind("onDocument")).toBe(false);
        expect(isNetKind("onRequest")).toBe(true);
        expect(c.meta.routes.map((r) => `${routeLabel(r)}@${r.line}`)).toEqual(["onSite #1@1", "onPage #1@4", "onOverlay #1@2", "onOverlay #2@3"]);
    });
});


describe("page shim worlds", () => {
    const src = (tt: any) => {
        tt.onSite("*://a.com/*", () => "site");
        tt.onPage("*://a.com/*", () => "iso");
        tt.onOverlay("*://a.com/*", () => "overlay");
        tt.onSite("*://a.com/*", () => "site 2");
    };

    it("the site's world collects only onSite handlers, keyed like the background", () => {
        const s = shim();
        src(s.tt);
        expect(s.dom.map((d) => d.fn({}))).toEqual(["site", "site 2"]);
        expect(s.dom.map((d) => [d.h, d.route.index])).toEqual([
            ["onSite:~0", 0],
            ["onSite:~1", 2],
        ]);
    });

    it("the isolated world collects only onPage handlers", () => {
        const s = shim("isolated");
        src(s.tt);
        expect(s.dom.map((d) => [d.h, d.fn({})])).toEqual([["onPage:~0", "iso"]]);
        expect(domHandlersFor(s.dom, "https://b.com/").length).toBe(0);
    });

    it("the compiler's keys win over call order", () => {
        const s = shim("isolated");
        s.tt.onPage.k(3)("*", () => 0);
        s.tt.onPage("*", () => 1);
        s.tt.onPage.k(3)("*", () => 2);
        expect(s.dom.map((d) => d.h)).toEqual(["onPage:3", "onPage:~1", "onPage:3#1"]);
    });

    it("in the site's world handles throw SiteCannotCallError where they're called, and are reported", () => {
        const seen: Error[] = [];
        const s = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, onSiteCall: (e) => seen.push(e) });
        const h = s.tt.onOverlay("*", () => {});
        expect(() => h.ping()).toThrow(SiteCannotCallError);
        expect(() => s.tt.onSite("*", () => {}).ping()).toThrow(/onSite code can't call handles/);
        expect(seen.map((e) => e.name)).toEqual(["SiteCannotCallError", "SiteCannotCallError"]);
    });

    it("isolated handles go through `call`, with where their handler runs; without it they're inert", async () => {
        const asked: string[] = [];
        const routes: any[] = [];
        const iso = makePageShim({
            params: {},
            log: () => {},
            storage: { get: () => undefined, set: () => undefined },
            world: "isolated",
            call: (api, key, route) => ((asked.push(`${api}/${key}`), routes.push(route), { ping: async () => "pong" }) as any),
        });
        await expect(iso.tt.onOverlay("*", () => {}).ping()).resolves.toBe("pong");
        iso.tt.onSite("*://a.test/*", () => {});
        expect(asked).toEqual(["onOverlay/onOverlay:~0", "onSite/onSite:~0"]);
        expect(routes.map((r) => r.url)).toEqual([["*"], ["*://a.test/*"]]);
        await expect(shim("isolated").tt.onOverlay("*", () => {}).ping()).rejects.toThrow();
    });

    it("store can be declared at top level but not used; fetch rejects", async () => {
        const s = shim().tt.globalStore("x", { n: 1 });
        expect(s.then).toBeUndefined();
        expect(() => s.n).toThrow(/tt\.globalStore/);
        await expect(shim().tt.fetch("/")).rejects.toThrow(/tt\.fetch/);
    });

    it("isolated code gets the stores it's given; the site's world never does", () => {
        const made: string[] = [];
        const stores = {
            store: (name: string, initial: object, persist: boolean | string[]) => (made.push(`g:${name}:${JSON.stringify(persist)}`), { ...initial }),
            pageStore: (name: string, initial: object) => (made.push(`p:${name}`), { ...initial }),
        };
        const iso = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "isolated", stores });
        expect(iso.tt.globalStore("a", { n: 1 }, { persist: ["n"] }).n).toBe(1);
        expect(iso.tt.pageStore("b", { m: 2 }).m).toBe(2);
        expect(made).toEqual(['g:a:["n"]', "p:b"]);
        expect(() => iso.tt.pageStore("a", {})).toThrow(/already has a store named "a"/);
        expect(() => iso.tt.globalStore("c", [])).toThrow(/initial must be an object/);
        const site = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "page", stores });
        expect(() => site.tt.pageStore("b", { m: 2 }).m).toThrow(SITE_NO_STORES);
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
