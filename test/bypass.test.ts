import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logged: any[][] = [];
vi.mock("../src/background/engine/logs", () => ({ log: (...a: any[]) => logged.push(a) }));

import { addBypass, bypassed, bypassRule, resetBypass, withBypassRule, BYPASS_RULE_BASE } from "../src/background/engine/bypass";
import { backgroundFetch } from "../src/background/engine/wtFetch";

const req = { method: "GET", url: "https://api.example.com/x?a=1", scriptId: "s1", scriptName: "One" };

describe("bypass registry", () => {
    beforeEach(() => {
        resetBypass();
        logged.length = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("a matching request is taken once and logged as a bypass", () => {
        addBypass(req);
        expect(bypassed({ method: "get", url: "https://api.example.com/x?a=1#frag" })).toBe(true);
        expect(bypassed({ method: "GET", url: "https://api.example.com/x?a=1" })).toBe(false);
        expect(logged).toHaveLength(1);
        expect(logged[0][1]).toMatch(/\[One\] wt\.fetch bypass: GET/);
        expect(logged[0][3]).toBe("s1");
    });

    it("method, URL and tab must match", () => {
        addBypass({ ...req, tabId: 7 });
        expect(bypassed({ method: "POST", url: req.url, tabId: 7 })).toBe(false);
        expect(bypassed({ method: "GET", url: "https://api.example.com/x?a=2", tabId: 7 })).toBe(false);
        expect(bypassed({ method: "GET", url: req.url, tabId: 8 })).toBe(false);
        expect(bypassed({ method: "GET", url: req.url, tabId: 7 })).toBe(true);
        // a background entry (tab -1) matches any tab
        addBypass(req);
        expect(bypassed({ method: "GET", url: req.url, tabId: 3 })).toBe(true);
    });

    it("the request id keeps later stages bypassed", () => {
        addBypass(req);
        expect(bypassed({ method: "GET", url: req.url }, "wr:1")).toBe(true);
        expect(bypassed({ method: "GET", url: req.url }, "wr:1")).toBe(true);
        expect(bypassed({ method: "GET", url: req.url }, "wr:2")).toBe(false);
    });

    it("entries expire, and removal forgets them", () => {
        vi.useFakeTimers();
        addBypass(req, 1000);
        vi.advanceTimersByTime(1001);
        expect(bypassed({ method: "GET", url: req.url })).toBe(false);
        const remove = addBypass(req);
        remove();
        expect(bypassed({ method: "GET", url: req.url })).toBe(false);
    });

    it("the DNR allow rule covers exactly that URL and method", () => {
        const r = bypassRule(BYPASS_RULE_BASE, "POST", "https://a.com/p?x=1.2#h");
        expect(r).toMatchObject({ id: BYPASS_RULE_BASE, action: { type: "allow" }, condition: { requestMethods: ["post"], tabIds: [-1] } });
        expect(r.priority).toBe(2 ** 31 - 1);
        const re = new RegExp(r.condition.regexFilter);
        expect(re.test("https://a.com/p?x=1.2")).toBe(true);
        expect(re.test("https://a.com/p?x=1.2#other")).toBe(true);
        expect(re.test("https://a.com/p?x=152")).toBe(false);
        expect(re.test("https://a.com/p?x=1.2&y")).toBe(false);
    });

    it("withBypassRule adds a session rule for the run and removes it after", async () => {
        const calls: any[] = [];
        vi.stubGlobal("chrome", {
            runtime: { lastError: undefined },
            declarativeNetRequest: { updateSessionRules: (o: any, cb: () => void) => (calls.push(o), cb()) },
        });
        await expect(withBypassRule("GET", req.url, async () => "ok")).resolves.toBe("ok");
        await expect(withBypassRule("GET", req.url, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
        expect(calls.filter((c) => c.addRules)).toHaveLength(2);
        expect(calls.filter((c) => !c.addRules).map((c) => c.removeRuleIds[0])).toEqual(calls.filter((c) => c.addRules).map((c) => c.addRules[0].id));
    });

    it("a bypass background fetch is registered while it runs, then forgotten", async () => {
        let seen = false;
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            expect(init.credentials).toBe("include");
            seen = bypassed({ method: "GET", url, tabId: 12 });
            return new Response("hi", { status: 200 });
        });
        const w = await backgroundFetch({ url: req.url, method: "GET", headers: [] }, { bypass: true, scriptId: "s1", scriptName: "One" });
        expect(seen).toBe(true);
        expect(new TextDecoder().decode(w.body)).toBe("hi");
        // a plain fetch registers nothing
        await backgroundFetch({ url: req.url, method: "GET", headers: [] }, { bypass: false, scriptId: "s1", scriptName: "One" });
        expect(seen).toBe(false);
    });
});
