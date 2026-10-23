import { describe, it, expect } from "vitest";
import { AS_IS, URL_TOKEN, captureToken, patternGroups, patternToRegex, rulesForProbe, substitute, type RuleProbe } from "../src/shared/dnrRules";
import { matchAny, matchGroups } from "../src/shared/matcher";
import { normalizeRoute, type NetKind } from "../src/shared/route";

const PATTERNS = [
    "*://example.com/*",
    "<all_urls>",
    "*",
    "https://*.example.com/*",
    "*://*.example.com/*",
    "*://:sub.example.com/*",
    "http://127.0.0.1:8907/rr{/v:ver}?/:name",
    "https://a.com/api{/v:ver}?/users/:id(\\d+)",
    "https://a.com/files/:path+",
    "https://a.com/files/:path*",
    "https://a.com/x/*.js",
    "https://a.com/(foo|bar)/*",
    "https://a.com/x?q=1",
    "https://a.com/x?*",
    "https://a.com/x?q=:q",
    "https://a.com",
    "https://a.com:8443/*",
    "https://a.com:443/*",
    "http://a.com:*/*",
    "https://a.com/:a-:b",
    "https://a.com/x{-:b}+/y",
    "https://a.com/{:a}?x",
    "https://a.com/a b",
    "https://a.com/:id(.*)/end",
    "http{s}?://a.com/*",
    "https://a.com/x#*",
    "https://a.com/:p([^/]+)/z",
    "https://user:pw@a.com/*",
    "https://a.com/x/:rest(.*)?",
    "https://a.com/*/:last",
    "https://a.com/:d(\\D+)",
    "https://a.com/:w(\\w+).:ext",
    "https://a.com/*.(png|jpg)",
    "https://a.com/foo.bar",
    "https://a.com/\\:literal",
    "https://:host(a|b).com/*",
    "*://example.com:*/*",
    "https://u{:p}?@a.com/*",
    "https://*:*@a.com/*",
    "https://a.com/x#frag",
    "https://a.com/x?*#*",
    "https://a.com/x?:q#*",
];

const URLS = [
    "https://example.com/", "https://example.com/a/b?x=1", "http://example.com:8080/x", "https://sub.example.com/a",
    "https://a.b.example.com/", "https://example.com.evil.com/", "https://evil.com/?https://example.com/",
    "http://127.0.0.1:8907/rr/v2/abc", "http://127.0.0.1:8907/rr/abc", "http://127.0.0.1:8907/rr/v/abc", "http://127.0.0.1:8907/rr/v2/abc?q=1",
    "http://127.0.0.1:8907/rr/v2/abc/def",
    "https://a.com/api/v1/users/5", "https://a.com/api/users/5", "https://a.com/api/users/x", "https://a.com/api/v1/users/55",
    "https://a.com/files/a/b/c", "https://a.com/files/", "https://a.com/files", "https://a.com/files/a",
    "https://a.com/x/y.js", "https://a.com/x/y/z.js", "https://a.com/foo/1", "https://a.com/baz/1",
    "https://a.com/x?q=1", "https://a.com/x?q=2", "https://a.com/x", "https://a.com/", "https://a.com/x?",
    "https://a.com:8443/z", "https://a.com/z", "http://a.com:81/z", "https://foo.example.com/q",
    "https://a.com/1-2", "https://a.com/x-1-2/y", "https://a.com/x-1/y", "https://a.com/x/y", "https://a.com/5x",
    "https://a.com/a%20b", "https://a.com/p/q/end", "https://a.com/end", "http://a.com/1", "https://a.com/x#frag",
    "https://user:pw@a.com/x", "https://u@a.com/x", "https://a.com/x/", "https://a.com/x/r/s",
    "https://a.com/1/2/3", "wss://example.com/ws", "https://a.com/x?y#z", "https://a.com/abc", "https://a.com/a1",
    "https://a.com/file.png", "https://a.com/d/file.jpg", "https://a.com/foo.bar", "https://a.com/fooxbar",
    "https://a.com/:literal", "https://a.com/literal", "https://a.com/v.txt", "https://b.com/z", "https://c.com/z",
    "https://A.com/Path", "https://a.com/X", "file:///etc/hosts", "https://a.com/%E2%9C%93",
    "https://u:pw@a.com/z", "https://v@a.com/z", "https://u:@a.com/z",
].map((u) => {
    // the browser hands rules normalized URLs (lowercase host, …) without a fragment
    const url = new URL(u);
    url.hash = "";
    return url.href;
});

describe("patternToRegex agrees with URLPattern", () => {
    for (const p of PATTERNS) {
        it(p, () => {
            const names = patternGroups(p).map((g) => g.name);
            for (const capture of [[], names]) {
                const { regex, index } = patternToRegex(p, capture);
                const re = new RegExp(regex);
                for (const u of URLS) {
                    const want = matchAny([p], u);
                    const m = re.exec(u);
                    expect(!!m, `${u} (${regex})`).toBe(want);
                    if (!m) continue;
                    const g = matchGroups([p], u)!;
                    for (const n of capture) expect(m[index[n]] ?? "", `${u} groups.${n}`).toBe(g[n] ?? "");
                }
            }
        });
    }

    it("only the requested captures are numbered groups, in pattern order", () => {
        const { regex, index } = patternToRegex("https://a.com/api{/v:ver}?/users/:id(\\d+)", ["id", "ver"]);
        expect(index).toEqual({ ver: 1, id: 2 });
        expect(new RegExp(regex).exec("https://a.com/api/users/7")!.length).toBe(3);
        expect(patternToRegex("https://a.com/:a/:b", ["b"]).index).toEqual({ b: 1 });
    });

    it("reports optional groups", () => {
        const groups = patternGroups("https://a.com/rr{/v:ver}?/:name/:rest*");
        expect(groups).toEqual(expect.arrayContaining([{ name: "ver", optional: true }, { name: "name", optional: false }, { name: "rest", optional: true }]));
    });

    it("throws on a pattern URLPattern rejects", () => {
        expect(() => patternToRegex("https://a.com/:id(")).toThrow();
    });
});

function probe(kind: NetKind, route: unknown, result: RuleProbe["result"], extra: Partial<RuleProbe> = {}): RuleProbe {
    return { kind, route: normalizeRoute(kind, route, 0), captures: [], urlRead: false, result, ...extra };
}

function ok(p: RuleProbe) {
    const r = rulesForProbe(p);
    if ("error" in r) throw new Error(r.error);
    return r.rules;
}

function err(p: RuleProbe): string {
    const r = rulesForProbe(p);
    if (!("error" in r)) throw new Error("expected an error");
    return r.error;
}

describe("rulesForProbe", () => {
    it("block", () => {
        const [r] = ok(probe("onRequest", { url: "*://example.com/ads/*", methods: ["get"], resourceTypes: ["script"] }, { block: true }));
        expect(r.final).toBe(true);
        expect(r.action).toEqual({ type: "block" });
        expect(r.condition).toMatchObject({ isUrlFilterCaseSensitive: true, requestMethods: ["get"], resourceTypes: ["script"] });
        expect(new RegExp(r.condition.regexFilter).test("https://example.com/ads/x.js")).toBe(true);
        expect(r.summary).toBe("block");
    });

    it("all resource types when none are given (DNR would skip main_frame)", () => {
        const [r] = ok(probe("onRequest", "*://example.com/*", { block: true }));
        expect(r.condition.resourceTypes).toContain("main_frame");
        expect(r.condition.requestMethods).toBeUndefined();
    });

    it("static redirect", () => {
        const [r] = ok(probe("onRequest", "*://example.com/old", { redirect: "https://example.com/new" }));
        expect(r.action).toEqual({ type: "redirect", redirect: { url: "https://example.com/new" } });
    });

    it("redirect with captures and ctx.url → regexSubstitution", () => {
        const pat = "http://127.0.0.1:8907/rr{/v:ver}?/:name";
        const [r] = ok(probe("onRequest", pat, { redirect: `http://127.0.0.1:8907/echo/${captureToken("name")}?v=${captureToken("ver")}&from=${URL_TOKEN}&q=\\` }, { captures: ["name", "ver"], urlRead: true }));
        const sub = r.action.redirect.regexSubstitution;
        expect(sub).toBe("http://127.0.0.1:8907/echo/\\2?v=\\1&from=\\0&q=\\\\");
        expect(substitute(r.condition.regexFilter, sub, "http://127.0.0.1:8907/rr/v3/abc")).toBe("http://127.0.0.1:8907/echo/abc?v=3&from=http://127.0.0.1:8907/rr/v3/abc&q=\\");
        expect(substitute(r.condition.regexFilter, sub, "http://127.0.0.1:8907/rr/abc")).toBe("http://127.0.0.1:8907/echo/abc?v=&from=http://127.0.0.1:8907/rr/abc&q=\\");
    });

    it("one rule per url pattern, captures numbered per pattern", () => {
        const rules = ok(probe("onRequest", ["https://a.com/:id", "https://b.com/x/:id"], { redirect: `https://c.com/${captureToken("id")}` }, { captures: ["id"] }));
        expect(rules.map((r) => r.pattern)).toEqual(["https://a.com/:id", "https://b.com/x/:id"]);
        expect(substitute(rules[1].condition.regexFilter, rules[1].action.redirect.regexSubstitution, "https://b.com/x/9")).toBe("https://c.com/9");
    });

    it("request and response headers", () => {
        const [q] = ok(probe("onRequest", "*://example.com/*", { headers: { set: { "x-a": "1" }, remove: ["cookie"] } }));
        expect(q.final).toBe(false);
        expect(q.action).toEqual({ type: "modifyHeaders", requestHeaders: [{ header: "x-a", operation: "set", value: "1" }, { header: "cookie", operation: "remove" }] });
        expect(q.summary).toBe("request headers (set x-a; remove cookie)");
        const [s] = ok(probe("onResponseHeaders", "*://example.com/*", { headers: { set: { "x-b": "2" } } }));
        expect(s.action).toEqual({ type: "modifyHeaders", responseHeaders: [{ header: "x-b", operation: "set", value: "2" }] });
    });

    it("a final action drops header edits, as at runtime", () => {
        const rules = ok(probe("onRequest", "*://example.com/*", { block: true, headers: { set: { a: "1" } } }));
        expect(rules).toHaveLength(1);
        expect(rules[0].action.type).toBe("block");
        expect(ok(probe("onRequest", "*://example.com/*", { redirect: "https://x.com/", block: true }))[0].action.type).toBe("redirect");
    });

    it("errors", () => {
        expect(err(probe("onRequest", "*://e.com/*", { block: true }, { forbidden: ["method"] }))).toContain("it reads ctx.method");
        expect(err(probe("onRequest", "*://e.com/*", { block: true }, { error: "boom" }))).toBe("boom");
        expect(err(probe("onResponseBody", "*://e.com/*", null))).toContain("not supported on rules");
        expect(err(probe("replaceResponse", "*://e.com/*", null))).toContain("not supported on rules");
        expect(err(probe("onRequest", "*://e.com/*", { replaceResponse: true }))).toContain("a `replaceResponse` result is not supported on rules");
        expect(err(probe("onRequest", { url: "*://e.com/*", exclude: "*://e.com/x" }, { block: true }))).toContain("`exclude`");
        expect(err(probe("onRequest", "*://e.com/*", null))).toContain("does nothing");
        expect(err(probe("onRequest", "*://e.com/*", {}))).toContain("does nothing");
        expect(err(probe("onRequest", "*://e.com/*", { headers: {} }))).toContain("does nothing");
        expect(err(probe("onResponseHeaders", "*://e.com/*", { block: true }))).toContain("does nothing");
        expect(err(probe("onRequest", "*://e.com/:id", { headers: { set: { a: captureToken("id") } } }, { captures: ["id"] }))).toContain(AS_IS);
        expect(err(probe("onRequest", "*://e.com/:id", { block: true }, { captures: ["id"] }))).toContain("ctx.groups.id used otherwise");
        expect(err(probe("onRequest", "*://e.com/:id", { redirect: "https://x.com/ID" }, { captures: ["id"] }))).toContain(AS_IS);
        expect(err(probe("onRequest", "*://e.com/*", { block: true }, { urlRead: true }))).toContain("ctx.url used otherwise");
        expect(err(probe("onRequest", "*://e.com/x{/:v}?", { redirect: `https://x.com/${captureToken("v")}` }, { captures: ["v"], optionalMismatch: ["v"] }))).toContain('ctx.groups.v ?? ""');
        expect(err(probe("onRequest", "*://e.com/*", { redirect: "/relative" }))).toContain("not an absolute URL");
        expect(err(probe("onRequest", { url: "*://e.com/*", methods: ["PROPFIND"] }, { block: true }))).toContain('"PROPFIND"');
        const ten = Array.from({ length: 10 }, (_, i) => `n${i}`);
        expect(err(probe("onRequest", `https://e.com/${ten.map((n) => `:${n}`).join("/")}`, { redirect: `https://x.com/${ten.map(captureToken).join("/")}` }, { captures: ten }))).toContain("at most 9");
    });
});
