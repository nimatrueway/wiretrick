import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { probeScriptRules } from "../src/shared/rulesProbe";
import { substitute } from "../src/shared/dnrRules";
import { scriptHealth } from "../src/shared/scriptHealth";
import { missedReason } from "../src/shared/missedTap";
import { strategyUnsupported } from "../src/shared/strategyInfo";

async function rulesOf(code: string, defaultStrategy: any = "helper") {
    const c = compileScript(code);
    expect(c.error).toBeNull();
    return probeScriptRules(c.handlers, defaultStrategy);
}

describe("rules probe (tripwire ctx)", () => {
    it("turns fixed handlers into rules and skips other strategies", async () => {
        const r = await rulesOf(`
            wt.onRequest({ url: "*://ads.example.com/*", strategy: "rules" }, () => ({ block: true }));
            wt.onRequest({ url: "*://example.com/*", strategy: "page" }, (ctx) => ({ redirect: ctx.method }));
            wt.onResponseHeaders({ url: "*://example.com/*", strategy: "rules" }, () => ({ headers: { set: { "x-wt": "1" }, remove: ["server"] } }));
        `);
        expect(r.errors).toEqual([]);
        expect(r.rules.map((x) => x.specs[0].action.type)).toEqual(["block", "modifyHeaders"]);
    });

    it("the default strategy can be rules", async () => {
        const r = await rulesOf(`wt.onRequest("*://a.com/*", async () => ({ headers: { set: { a: 1 } } }));`, "rules");
        expect(r.rules[0].specs[0].action.requestHeaders).toEqual([{ header: "a", operation: "set", value: "1" }]);
    });

    it("captures and ctx.url as-is in a redirect → regexSubstitution", async () => {
        const r = await rulesOf(`
            wt.onRequest({ url: "http://127.0.0.1:8907/rr{/v:ver}?/:name", strategy: "rules" },
                (ctx) => ({ redirect: \`http://127.0.0.1:8907/echo?name=\${ctx.groups.name}&ver=\${ctx.groups.ver ?? ""}\` }));
        `);
        expect(r.errors).toEqual([]);
        const spec = r.rules[0].specs[0];
        const to = (u: string) => substitute(spec.condition.regexFilter, spec.action.redirect.regexSubstitution, u);
        expect(to("http://127.0.0.1:8907/rr/v2/abc")).toBe("http://127.0.0.1:8907/echo?name=abc&ver=2");
        expect(to("http://127.0.0.1:8907/rr/abc")).toBe("http://127.0.0.1:8907/echo?name=abc&ver=");
    });

    it("the docs' optional-group redirect example works; another fallback is an error", async () => {
        const r = await rulesOf(`
            wt.onRequest({ url: "https://example.com/api{/v:ver}?/users/:id(\\\\d+)", strategy: "rules" },
                (ctx) => ({ redirect: \`https://staging.example.com/users/\${ctx.groups.id}?v=\${ctx.groups.ver ?? ""}\` }));
            wt.onRequest({ url: "https://example.com/b{/v:ver}?", strategy: "rules" },
                (ctx) => ({ redirect: \`https://x.com/\${ctx.groups.ver ?? "1"}\` }));
        `);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^onRequest #2: ctx\.groups\.ver can be missing/);
        const spec = r.rules[0].specs[0];
        const to = (u: string) => substitute(spec.condition.regexFilter, spec.action.redirect.regexSubstitution, u);
        expect(to("https://example.com/api/users/7")).toBe("https://staging.example.com/users/7?v=");
        expect(to("https://example.com/api/v2/users/7")).toBe("https://staging.example.com/users/7?v=2");
        expect(new RegExp(spec.condition.regexFilter).test("https://example.com/api/users/x")).toBe(false);
    });

    it("errors name the handler; the script's other handlers still become rules", async () => {
        const r = await rulesOf(`
            wt.onRequest({ url: "*://a.com/*", strategy: "rules" }, () => ({ block: true }));
            wt.onRequest({ url: "*://b.com/*", strategy: "rules" }, (ctx) => ctx.method === "POST" ? { block: true } : undefined);
            wt.onRequest({ url: "*://c.com/:id", strategy: "rules" }, (ctx) => ({ redirect: "https://x.com/" + ctx.groups.id.toUpperCase() }));
            wt.onRequest({ url: "*://d.com/:id", strategy: "rules" }, (ctx) => ({ headers: { set: { id: ctx.groups.id } } }));
            wt.onRequest({ url: "*://e.com/*", strategy: "rules" }, () => ({ respond: { body: "x" } }));
            wt.onRequest({ url: "*://f.com/*", strategy: "rules" }, () => { throw new Error("nope"); });
            wt.onRequest({ url: "*://g.com/*", strategy: "rules" }, () => {});
            wt.onRequest({ url: "*://h.com/*", strategy: "rules" }, ({ requestHeaders }) => ({ block: !!requestHeaders.cookie }));
            wt.onRequest({ url: "*://i.com/x{/:v}?", strategy: "rules" }, (ctx) => ({ redirect: "https://x.com/" + (ctx.groups.v || "none") }));
            wt.onResponseBody({ url: "*://j.com/*", strategy: "rules" }, (ctx, body) => body);
            wt.replaceResponse({ url: "*://k.com/*", strategy: "rules" }, () => "x");
        `);
        expect(r.rules.map((x) => x.route.url[0])).toEqual(["*://a.com/*"]);
        const e = r.errors.join("\n");
        expect(r.errors[0]).toMatch(/^onRequest #2: rules are fixed: .*it reads ctx\.method/);
        expect(r.errors[1]).toMatch(/^onRequest #3: on `rules`, captures can only be inserted into the redirect URL as-is/);
        expect(r.errors[2]).toMatch(/^onRequest #4: on `rules`, captures/);
        expect(r.errors[3]).toMatch(/^onRequest #5: `respond` is not supported on rules/);
        expect(r.errors[4]).toMatch(/^onRequest #6: threw during its one-time run: nope/);
        expect(r.errors[5]).toMatch(/^onRequest #7: does nothing on `rules`/);
        expect(r.errors[6]).toMatch(/^onRequest #8: rules are fixed: .*ctx\.requestHeaders/);
        expect(r.errors[7]).toMatch(/^onRequest #9: ctx\.groups\.v can be missing/);
        expect(e).toMatch(/replaceResponse #1: replaceResponse is not supported on rules/);
        expect(e).toMatch(/onResponseBody #1: onResponseBody is not supported on rules/);
    });

    it("times out a handler that never settles", async () => {
        const r = await rulesOf(`wt.onRequest({ url: "*://a.com/*", strategy: "rules" }, () => new Promise(() => {}));`);
        expect(r.errors[0]).toMatch(/onRequest #1: threw during its one-time run: timed out/);
    }, 5000);
});

describe("rules in health / missed / availability", () => {
    it("a rules error is a red ⚠ that names the handler", () => {
        const h = scriptHealth({ error: null, runtimeError: { message: "x", at: 0, count: 1 }, ruleErrors: ["onRequest #2: rules are fixed: … (it reads ctx.method)"] });
        expect(h?.kind).toBe("rules");
        expect(h?.tooltip).toContain("onRequest #2: rules are fixed");
        expect(scriptHealth({ error: "boom", ruleErrors: ["x"] })?.kind).toBe("compile");
    });

    it("no Missed warning for rules handlers", () => {
        expect(missedReason({ strategy: "rules", type: "script", firefox: false, mv3: true, fromCache: false, helperActive: false, cdpWarned: false })).toBeNull();
    });

    it("unsupported only without declarativeNetRequest", () => {
        expect(strategyUnsupported("rules", { firefox: false, mv3: true, dnr: true })).toBeNull();
        expect(strategyUnsupported("rules", { firefox: true, mv3: false, dnr: true })).toBeNull();
        expect(strategyUnsupported("rules", { firefox: false, mv3: false, dnr: false })).toMatch(/declarativeNetRequest/);
    });
});
