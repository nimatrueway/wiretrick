/** Per-handler routes: normalization, matching, required strategy, and the page-side shim. */
import { describe, expect, it } from "vitest";
import { effectiveStrategy, hookCanSee, normalizeRoute, routeGroups, routeLabel, routeMatches, sampleUrl, scriptUrls } from "../src/shared/route";
import { domHandlersFor, makePageShim } from "../src/shared/pageShim";

describe("normalizeRoute", () => {
    it("accepts { url, strategy } with a string or a list", () => {
        expect(normalizeRoute("onRequest", { url: "*://a.com/*", strategy: "helper" }, 0)).toEqual({ kind: "onRequest", index: 0, url: ["*://a.com/*"], exclude: [], strategy: "helper" });
        expect(normalizeRoute("onRequest", { url: ["*://a.com/*", "*://b.com/*"], strategy: "page" }, 1).url).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(normalizeRoute("onResponseBody", { url: "*", exclude: "*://a.com/*", methods: ["get", "Post"], resourceTypes: ["script"], strategy: "debugger" }, 2)).toEqual({
            kind: "onResponseBody",
            index: 2,
            url: ["*"],
            exclude: ["*://a.com/*"],
            methods: ["GET", "POST"],
            resourceTypes: ["script"],
            strategy: "debugger",
        });
    });

    it("onDocument: when defaults to document_end; request-only options are rejected", () => {
        expect(normalizeRoute("onDocument", "*", 0).when).toBe("document_end");
        expect(normalizeRoute("onDocument", { url: "*", when: "document_idle" }, 0).when).toBe("document_idle");
        expect(() => normalizeRoute("onDocument", { url: "*", when: "later" }, 0)).toThrow(/when must be one of/);
        expect(() => normalizeRoute("onDocument", { url: "*", when: "DOMContentLoaded" }, 0)).toThrow(/when must be one of document_start, document_end, document_idle$/);
        expect(() => normalizeRoute("onDocument", { url: "*", methods: ["GET"] }, 0)).toThrow(/doesn't apply to onDocument/);
        expect(() => normalizeRoute("onRequest", { url: "*", when: "document_idle" }, 0)).toThrow(/onPage\/onOverlay only/);
    });

    it("network handlers require a strategy: bare patterns and strategy-less objects throw", () => {
        for (const kind of ["onRequest", "onResponseHeaders", "replaceResponse", "onResponseBody"] as const) {
            expect(() => normalizeRoute(kind, "*://a.com/*", 0)).toThrow(/bare URL pattern has no strategy — pass \{ url, strategy \}/);
            expect(() => normalizeRoute(kind, ["*://a.com/*"], 0)).toThrow(/bare URL pattern/);
            expect(() => normalizeRoute(kind, { url: "*://a.com/*" }, 0)).toThrow(/missing "strategy"/);
        }
        expect(normalizeRoute("onDocument", "*://a.com/*", 0).url).toEqual(["*://a.com/*"]);
        expect(normalizeRoute("onDocument", ["*://a.com/*"], 0).url).toEqual(["*://a.com/*"]);
    });

    it("rejects missing / malformed routes", () => {
        expect(() => normalizeRoute("onRequest", () => {}, 0)).toThrow(/first argument must be a route \{ url, strategy \}/);
        expect(() => normalizeRoute("onRequest", 42, 0)).toThrow(/first argument/);
        expect(() => normalizeRoute("onRequest", {}, 0)).toThrow(/missing "url"/);
        expect(() => normalizeRoute("onRequest", { url: [1], strategy: "helper" }, 0)).toThrow(/must be strings/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: "auto" }, 0)).toThrow(/unknown strategy/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: ["page"] }, 0)).toThrow(/single value/);
    });
});

describe("routeMatches", () => {
    const r = (raw: unknown) => normalizeRoute("onRequest", typeof raw === "object" && !Array.isArray(raw) ? { strategy: "helper", ...raw } : { url: raw, strategy: "helper" }, 0);

    it("url ∧ ¬exclude", () => {
        const route = r({ url: "https://x.com/api/*", exclude: ["https://x.com/api/health", "https://x.com/api/metrics*"] });
        expect(routeMatches(route, "https://x.com/api/users")).toBe(true);
        expect(routeMatches(route, "https://x.com/api/health")).toBe(false);
        expect(routeMatches(route, "https://x.com/api/metrics/cpu")).toBe(false);
        expect(routeMatches(route, "https://y.com/api/users")).toBe(false);
    });

    it("methods (case-insensitive) and types; unknown method/type passes", () => {
        const route = r({ url: "*", methods: ["POST"], resourceTypes: ["xmlhttprequest"] });
        expect(routeMatches(route, "https://x.com/", "post", "xmlhttprequest")).toBe(true);
        expect(routeMatches(route, "https://x.com/", "GET", "xmlhttprequest")).toBe(false);
        expect(routeMatches(route, "https://x.com/", "POST", "script")).toBe(false);
        expect(routeMatches(route, "https://x.com/")).toBe(true);
    });

    it("empty lists match nothing", () => {
        expect(routeMatches(r([]), "https://x.com/")).toBe(false);
        expect(routeMatches(r({ url: "*", methods: [] }), "https://x.com/", "GET")).toBe(false);
        expect(routeMatches(r({ url: "*", resourceTypes: [] }), "https://x.com/", "GET", "script")).toBe(false);
    });

    it("* and <all_urls> match everything", () => {
        expect(routeMatches(r("*"), "https://x.com/a?b")).toBe(true);
        expect(routeMatches(r("<all_urls>"), "http://localhost:8080/")).toBe(true);
    });

    it("named groups", () => {
        expect(routeGroups(r("https://x.com/users/:id"), "https://x.com/users/42")).toMatchObject({ id: "42" });
        expect(routeGroups(r("*"), "https://x.com/")).not.toHaveProperty("id");
    });
});

describe("strategy", () => {
    it("effectiveStrategy is the route's own strategy", () => {
        expect(effectiveStrategy({ strategy: "debugger" })).toBe("debugger");
        expect(effectiveStrategy(normalizeRoute("onRequest", { url: "*", strategy: "page" }, 0))).toBe("page");
    });

    it("hookCanSee: only fetch/XHR", () => {
        expect(hookCanSee(normalizeRoute("onRequest", { url: "*", strategy: "page" }, 0))).toBe(true);
        expect(hookCanSee(normalizeRoute("onRequest", { url: "*", resourceTypes: ["script"], strategy: "page" }, 0))).toBe(false);
    });

    it("labels and url union", () => {
        const a = normalizeRoute("onResponseBody", { url: ["*://a.com/*", "*://b.com/*"], strategy: "helper" }, 1);
        const b = normalizeRoute("onDocument", "*://a.com/*", 0);
        expect(routeLabel(a)).toBe("onResponseBody #2");
        expect(scriptUrls([a, b])).toEqual(["*://a.com/*", "*://b.com/*"]);
    });
});

describe("page shim (onDocument in the page)", () => {
    const shim = () => makePageShim({ params: { host: "a.com", n: 3 }, log: () => {}, storage: { get: () => undefined, set: () => undefined } });

    it("collects several onDocument handlers with routes; network handlers are inert", () => {
        const { wt, dom } = shim();
        wt.onRequest({ url: "*", strategy: "helper" }, () => {});
        wt.onDocument({ url: "*://a.com/*", when: "document_idle" }, () => 1);
        wt.onDocument("*://b.com/*", () => 2);
        expect(dom.map((d) => [d.when, d.route.index])).toEqual([
            ["document_idle", 0],
            ["document_end", 1],
        ]);
        expect(domHandlersFor(dom, "https://a.com/x").map((d) => d.fn({}))).toEqual([1]);
        expect(domHandlersFor(dom, "https://c.com/")).toEqual([]);
    });

    it("params resolve from the bundle", () => {
        const { wt } = shim();
        expect(wt.params({ host: { type: "string" } })).toEqual({ host: "a.com" });
        expect(wt.defineParam("n", { type: "number" })).toBe(3);
        expect(() => wt.onDocument("*")).toThrow(/second argument/);
    });
});

describe("sampleUrl (the Editor preview's default page URL)", () => {
    const r = (url: string[], exclude: string[] = []) => normalizeRoute("onOverlay", { url, exclude }, 0);
    it("makes the first pattern concrete, one its route matches", () => {
        expect(sampleUrl([r(["https://app.example.com/dash/*"])])).toBe("https://app.example.com/dash/");
        expect(sampleUrl([r(["*://*.example.com/*"])])).toBe("https://example.com/");
        expect(sampleUrl([r(["*://*/*"])])).toBe("https://example.com/");
        expect(sampleUrl([r(["https://a.example/x"]), r(["https://b.example/"])])).toBe("https://a.example/x");
    });
    it("skips what the route excludes or what doesn't parse, and falls back to example.com", () => {
        expect(sampleUrl([r(["https://a.example/*"], ["https://a.example/*"]), r(["https://b.example/y"])])).toBe("https://b.example/y");
        expect(sampleUrl([r(["https://a.example/*"], ["https://a.example/*"])])).toBe("https://a.example/");
        expect(sampleUrl([r(["*"])])).toBe("https://example.com/");
        expect(sampleUrl([])).toBe("https://example.com/");
    });
});
