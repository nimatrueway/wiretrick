import { describe, it, expect, beforeEach } from "vitest";
import { CdpStrategy } from "../src/background/engine/strategies/cdpStrategy";
import { setDefaultStrategy } from "../src/shared/route";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

beforeEach(() => {
    (globalThis as any).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://t/${p}` },
        storage: {
            local: {
                get: async () => ({}),
                set: async () => {},
            },
        },
    };
});

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

describe("tier C participation gate (route ownership)", () => {
    const needsAny = (c: CdpStrategy) => c.needs({ url: "https://x.com/anything", method: "GET", type: "script" });

    it("a hook route is NOT loaded into CdpStrategy", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.modifyResponse({ url: "*", strategy: "hook" }, (c, b) => b);`)]);
        expect(c.hasOwners()).toBe(false);
        expect(needsAny(c)).toBe(false);
    });

    it("a cdp route IS loaded", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.modifyResponse({ url: "*", strategy: "cdp" }, (c, b) => b);`)]);
        expect(c.hasOwners()).toBe(true);
        expect(needsAny(c)).toBe(true);
    });

    it("routes without a strategy follow settings.strategy", () => {
        const c = new CdpStrategy();
        const scripts = [makeScript("a", `wt.modifyResponse("*", (c, b) => b);`)];
        try {
            setDefaultStrategy("cdp");
            c.reload(scripts);
            expect(needsAny(c)).toBe(true);
            setDefaultStrategy("process");
            c.reload(scripts);
            expect(needsAny(c)).toBe(false);
        } finally {
            setDefaultStrategy(null);
        }
    });

    it("only matching url / method / type are needed", () => {
        const c = new CdpStrategy();
        c.reload([makeScript("a", `wt.onRequest({ url: "https://x.com/api/*", exclude: "https://x.com/api/health", methods: ["POST"], types: ["xmlhttprequest"], strategy: "cdp" }, () => ({ cancel: true }));`)]);
        const req = (url: string, method = "POST", type = "xmlhttprequest") => c.needs({ url, method, type });
        expect(req("https://x.com/api/users")).toBe(true);
        expect(req("https://x.com/api/users", "post")).toBe(true);
        expect(req("https://x.com/api/users", "GET")).toBe(false);
        expect(req("https://x.com/api/users", "POST", "script")).toBe(false);
        expect(req("https://x.com/api/health")).toBe(false);
        expect(req("https://x.com/other")).toBe(false);
    });

    it("disabled scripts never load", () => {
        const s = makeScript("a", `wt.modifyResponse({ url: "*", strategy: "cdp" }, (c, b) => b);`);
        s.enabled = false;
        const c = new CdpStrategy();
        c.reload([s]);
        expect(c.hasOwners()).toBe(false);
    });
});
