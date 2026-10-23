/** Per-handler routes: normalization, matching, default strategy, and the page-side shim. */
import { afterEach, describe, expect, it } from "vitest";
import { builtinStrategy, effectiveStrategy, getDefaultStrategy, hookCanSee, normalizeRoute, routeGroups, routeLabel, routeMatches, scriptUrls, setDefaultStrategy } from "../src/shared/route";
import { domHandlersFor, makePageShim } from "../src/shared/pageShim";

afterEach(() => setDefaultStrategy(null));

describe("normalizeRoute", () => {
    it("accepts a string, a list, or { url, … }", () => {
        expect(normalizeRoute("onRequest", "*://a.com/*", 0)).toEqual({ kind: "onRequest", index: 0, url: ["*://a.com/*"], exclude: [] });
        expect(normalizeRoute("onRequest", ["*://a.com/*", "*://b.com/*"], 1).url).toEqual(["*://a.com/*", "*://b.com/*"]);
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

    it("onDocument: when defaults to DOMContentLoaded; request-only options are rejected", () => {
        expect(normalizeRoute("onDocument", "*", 0).when).toBe("DOMContentLoaded");
        expect(normalizeRoute("onDocument", { url: "*", when: "document_idle" }, 0).when).toBe("document_idle");
        expect(() => normalizeRoute("onDocument", { url: "*", when: "later" }, 0)).toThrow(/when must be one of/);
        expect(() => normalizeRoute("onDocument", { url: "*", methods: ["GET"] }, 0)).toThrow(/doesn't apply to onDocument/);
        expect(() => normalizeRoute("onRequest", { url: "*", when: "document_idle" }, 0)).toThrow(/onDocument only/);
    });

    it("rejects missing / malformed routes", () => {
        expect(() => normalizeRoute("onRequest", () => {}, 0)).toThrow(/first argument must be a URL pattern/);
        expect(() => normalizeRoute("onRequest", 42, 0)).toThrow(/first argument/);
        expect(() => normalizeRoute("onRequest", {}, 0)).toThrow(/missing "url"/);
        expect(() => normalizeRoute("onRequest", { url: [1] }, 0)).toThrow(/must be strings/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: "auto" }, 0)).toThrow(/unknown strategy/);
        expect(() => normalizeRoute("onRequest", { url: "*", strategy: ["page"] }, 0)).toThrow(/single value/);
    });
});

describe("routeMatches", () => {
    const r = (raw: unknown) => normalizeRoute("onRequest", raw, 0);

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
    it("route.strategy wins; otherwise settings.defaultStrategy; built-in default per browser", () => {
        expect(builtinStrategy(false)).toBe("helper");
        expect(builtinStrategy(true)).toBe("extension");
        expect(getDefaultStrategy()).toBe("helper");
        setDefaultStrategy("page");
        expect(effectiveStrategy({})).toBe("page");
        expect(effectiveStrategy({ strategy: "debugger" })).toBe("debugger");
        setDefaultStrategy(null);
        expect(effectiveStrategy({})).toBe("helper");
    });

    it("hookCanSee: only fetch/XHR", () => {
        expect(hookCanSee(normalizeRoute("onRequest", "*", 0))).toBe(true);
        expect(hookCanSee(normalizeRoute("onRequest", { url: "*", resourceTypes: ["script"] }, 0))).toBe(false);
    });

    it("labels and url union", () => {
        const a = normalizeRoute("onResponseBody", ["*://a.com/*", "*://b.com/*"], 1);
        const b = normalizeRoute("onDocument", "*://a.com/*", 0);
        expect(routeLabel(a)).toBe("onResponseBody #2");
        expect(scriptUrls([a, b])).toEqual(["*://a.com/*", "*://b.com/*"]);
    });
});

describe("page shim (onDocument in the page)", () => {
    const shim = () => makePageShim({ params: { host: "a.com", n: 3 }, log: () => {}, storage: { get: () => undefined, set: () => undefined } });

    it("collects several onDocument handlers with routes; network handlers are inert", () => {
        const { wt, dom } = shim();
        wt.onRequest("*", () => {});
        wt.onDocument({ url: "*://a.com/*", when: "document_idle" }, () => 1);
        wt.onDocument("*://b.com/*", () => 2);
        expect(dom.map((d) => [d.when, d.route.index])).toEqual([
            ["document_idle", 0],
            ["DOMContentLoaded", 1],
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
