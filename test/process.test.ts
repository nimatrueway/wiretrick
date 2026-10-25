import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HelperStrategy, applyHeaderMods, base64ToBytes, bytesToBase64, filterUrlsFor, helperRouteOf, pairsToObject } from "../src/background/engine/strategies/helperStrategy";
import { helperActive, setHelperActive, strategyUnavailable } from "../src/background/engine/strategies/helperState";
import { ownedRoutes } from "../src/background/engine/strategies/strategyScripts";
import { normalizeRoute, setDefaultStrategy } from "../src/shared/route";
import { DebuggerStrategy } from "../src/background/engine/strategies/debuggerStrategy";
import { compileScript } from "../src/shared/compile";
import { isHelperOutdated, MIN_HELPER_VERSION } from "../src/shared/helperInstall";
import { clearDebugBuffer, getDebugBuffer } from "../src/shared/debugLog";
import type { Script } from "../src/background/engine/scriptStore";
import { DEFAULT_TEXT_TYPES } from "../src/shared/bodyKind";
import { __resetTaps, helperSkipSince } from "../src/background/engine/logs";

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

interface Fake {
    sent: any[];
    proxyValue: any;
    levelOfControl: string;
    deliver(m: any): void;
    disconnect(err?: string): void;
    connects: number;
}

let fake: Fake;

function installChrome(): void {
    const msgL: ((m: any) => void)[] = [];
    const discL: (() => void)[] = [];
    const storage: Record<string, any> = {};
    fake = {
        sent: [],
        proxyValue: { mode: "system" },
        levelOfControl: "controllable_by_this_extension",
        connects: 0,
        deliver: (m) => msgL.forEach((f) => f(m)),
        disconnect: (err) => {
            (globalThis as any).chrome.runtime.lastError = { message: err || "Native host has exited." };
            discL.forEach((f) => f());
            (globalThis as any).chrome.runtime.lastError = undefined;
        },
    };
    (globalThis as any).chrome = {
        runtime: {
            id: "abcdefghijklmnopabcdefghijklmnop",
            getURL: (p: string) => `chrome-extension://t/${p}`,
            lastError: undefined,
            connectNative: () => {
                fake.connects++;
                msgL.length = 0;
                discL.length = 0;
                return {
                    postMessage: (m: any) => fake.sent.push(m),
                    disconnect: () => {},
                    onMessage: { addListener: (f: any) => msgL.push(f) },
                    onDisconnect: { addListener: (f: any) => discL.push(f) },
                };
            },
        },
        storage: {
            local: {
                get: async (k: string) => (k in storage ? { [k]: storage[k] } : {}),
                set: async (o: any) => Object.assign(storage, o),
            },
        },
        proxy: {
            settings: {
                get: (_d: any, cb: any) => cb({ value: fake.proxyValue, levelOfControl: fake.levelOfControl }),
                set: (d: any, cb: any) => {
                    fake.proxyValue = d.value;
                    fake.levelOfControl = "controlled_by_this_extension";
                    cb();
                },
                clear: (_d: any, cb: any) => {
                    fake.proxyValue = { mode: "system" };
                    fake.levelOfControl = "controllable_by_this_extension";
                    cb();
                },
                onChange: { addListener: () => {} },
            },
        },
        webRequest: { onBeforeRequest: { addListener: () => {}, removeListener: () => {} } },
        browsingData: { removeCache: (_o: any, cb: any) => cb() },
    };
    // the CA probe: pretend Chrome trusts it
    (globalThis as any).fetch = async () => ({ ok: true, text: async () => "ok" });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20): Promise<void> {
    for (let i = 0; i < n; i++) await tick();
}

function reply(id: number): any {
    return fake.sent.find((m) => m.id === id && m.t !== "upstream");
}

async function ready(p: HelperStrategy, scripts: Script[], version = "0.1.0"): Promise<void> {
    p.reload(scripts);
    await settle();
    fake.deliver({ t: "ready", port: 41234, version, caPem: "", caFingerprint: "AA", caPath: "/tmp/ca.pem" });
    await settle();
}

const enc = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const dec = (b: string) => new TextDecoder().decode(base64ToBytes(b));

beforeEach(() => {
    installChrome();
    setHelperActive(false);
});
afterEach(() => setHelperActive(false));

describe("process ownership (single strategy, no fallback)", () => {
    it("a process route belongs to the process tier only — helper up or down", () => {
        const scripts = [makeScript("a", `wt.onResponseBody({ url: "*", strategy: "helper" }, (c, b) => b);`)];
        expect(ownedRoutes(scripts, "helper")).toHaveLength(1);
        expect(ownedRoutes(scripts, "debugger")).toEqual([]);
        expect(ownedRoutes(scripts, "page")).toEqual([]);
        setHelperActive(true);
        expect(ownedRoutes(scripts, "helper")).toHaveLength(1);
        const c = new DebuggerStrategy();
        c.reload(scripts);
        expect(c.hasOwners()).toBe(false);
    });
    it("routes without a strategy follow settings.defaultStrategy", () => {
        const scripts = [makeScript("a", `wt.onRequest("*", () => {});`)];
        try {
            setDefaultStrategy("helper");
            expect(ownedRoutes(scripts, "helper")).toHaveLength(1);
            setDefaultStrategy("page");
            expect(ownedRoutes(scripts, "helper")).toEqual([]);
            expect(ownedRoutes(scripts, "page")).toHaveLength(1);
        } finally {
            setDefaultStrategy(null);
        }
    });
    it("strategyUnavailable: process needs a connected helper", () => {
        expect(strategyUnavailable("helper")).toMatch(/helper/);
        setHelperActive(true);
        expect(strategyUnavailable("helper")).toBeNull();
    });
});

describe("helpers", () => {
    it("helperRouteOf: pause flags follow the handler kind; exclude/methods go to the helper", () => {
        const r = (kind: any, raw: unknown) => helperRouteOf(normalizeRoute(kind, raw, 0));
        expect(r("onRequest", "*")).toMatchObject({ match: ["*"], req: true, resHeaders: false, body: false });
        expect(r("replaceResponse", "*")).toMatchObject({ req: true, body: false });
        expect(r("onResponseHeaders", "*")).toMatchObject({ req: false, resHeaders: true });
        expect(r("onResponseBody", "*")).toMatchObject({ req: false, body: true, binary: false });
        expect(r("onResponseBody", { url: "*", binary: true })).toMatchObject({ body: true, binary: true });
        expect(r("onRequest", { url: "https://x.com/*", exclude: "https://x.com/a", methods: ["post"] })).toEqual({
            match: ["https://x.com/*"],
            exclude: ["https://x.com/a"],
            methods: ["POST"],
            req: true,
            resHeaders: false,
            body: false,
            binary: false,
        });
    });
    it("header mods are case-insensitive and support multi-values", () => {
        const out = applyHeaderMods(
            [
                ["Content-Type", "text/html"],
                ["X-A", "1"],
                ["Set-Cookie", "a=1"],
            ],
            { set: { "x-a": "2", "set-cookie": ["b=2", "c=3"] }, remove: ["content-type"] }
        );
        expect(out).toEqual([
            ["x-a", "2"],
            ["set-cookie", "b=2"],
            ["set-cookie", "c=3"],
        ]);
        expect(pairsToObject([["A", "1"], ["a", "2"]])).toEqual({ a: "1, 2" });
    });
    it("filter urls: plain hosts kept, odd hosts widen to <all_urls>", () => {
        expect(filterUrlsFor(["https://*.x.com/*", "*://y.io:8080/a"])).toEqual(["*://*.x.com/*", "*://y.io/*"]);
        expect(filterUrlsFor(["*"])).toEqual(["<all_urls>"]);
        expect(filterUrlsFor(["https://a*b.com/*"])).toEqual(["<all_urls>"]);
    });
    it("base64 round-trips binary", () => {
        const b = new Uint8Array(70000).map((_, i) => i % 256);
        expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    });
});

describe("HelperStrategy ⇄ helper protocol", () => {
    it("no process scripts → never connects", async () => {
        const p = new HelperStrategy();
        p.reload([makeScript("a", `wt.onResponseBody({ url: "*", strategy: "debugger" }, (c, b) => b);`)]);
        await settle();
        expect(fake.connects).toBe(0);
        expect(p.status().state).toBe("idle");
    });

    it("ready → config, PAC install, active; user proxy captured & respected", async () => {
        fake.proxyValue = { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "corp", port: 3128 } } };
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onResponseBody({ url: "https://api.x.com/*", strategy: "helper" }, (c, b) => b + "!");`)]);
        const cfg = fake.sent.find((m) => m.t === "config");
        expect(cfg.routes).toEqual([{ match: ["https://api.x.com/*"], exclude: [], methods: [], req: false, resHeaders: false, body: true, binary: false }]);
        expect(cfg.textTypes).toEqual([...DEFAULT_TEXT_TYPES]);
        expect(cfg.upstream).toBe("ask");
        expect(fake.proxyValue.mode).toBe("pac_script");
        expect(fake.proxyValue.pacScript.data).toContain("127.0.0.1:41234");
        expect(helperActive()).toBe(true);
        const st = p.status();
        expect(st.state).toBe("ready");
        expect(st.routing?.mode).toBe("fixed_servers");

        // upstream questions are answered from the user's setting
        fake.deliver({ t: "needUpstream", id: 9, url: "https://api.x.com/a", host: "api.x.com" });
        await settle();
        expect(fake.sent.find((m) => m.t === "upstream" && m.id === 9).proxy).toBe("PROXY corp:3128; DIRECT");
    });

    it("blocked proxy control → inactive, fall through", async () => {
        fake.levelOfControl = "controlled_by_other_extensions";
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onRequest({ url: "*", strategy: "helper" }, () => {});`)]);
        expect(helperActive()).toBe(false);
        expect(p.status().routing?.active).toBe(false);
        expect(fake.sent.find((m) => m.t === "config").routes).toEqual([]);
    });

    it("request stage: redirect / respond / cancel / headers / replaceResponse", async () => {
        const p = new HelperStrategy();
        await ready(p, [
            makeScript(
                "a",
                `wt.onRequest({ url: "https://x.com/*", strategy: "helper" }, (c) => {
    if (c.url.endsWith("/r")) return { redirect: "https://x.com/target" };
    if (c.url.endsWith("/j")) return { replaceResponse: { status: 201, body: { ok: 1 }, mime: "application/json" } };
    if (c.url.endsWith("/c")) return { block: true };
    if (c.url.endsWith("/h")) return { headers: { set: { "X-Added": "1" }, remove: ["cookie"] } };
});
wt.replaceResponse({ url: "https://x.com/*", strategy: "helper" }, (c) => (c.url.endsWith("/rep") ? "replaced" : undefined));`
            ),
        ]);
        const H: [string, string][] = [
            ["Host", "x.com"],
            ["Cookie", "s=1"],
        ];
        const ids = { r: 1, j: 2, c: 3, h: 4, rep: 5, none: 6 };
        for (const [k, id] of Object.entries(ids)) fake.deliver({ t: "req", id, url: `https://x.com/${k}`, method: "GET", headers: H });
        await settle(60);
        expect(reply(1)).toEqual({ t: "redirect", id: 1, url: "https://x.com/target" });
        expect(reply(2).t).toBe("fulfill");
        expect(reply(2).status).toBe(201);
        expect(JSON.parse(dec(reply(2).body))).toEqual({ ok: 1 });
        expect(reply(2).headers).toContainEqual(["cache-control", "no-store"]);
        expect(reply(3)).toEqual({ t: "fail", id: 3 });
        expect(reply(4).t).toBe("continue");
        expect(reply(4).headers).toEqual([
            ["Host", "x.com"],
            ["X-Added", "1"],
        ]);
        expect(reply(5).t).toBe("fulfill");
        expect(dec(reply(5).body)).toBe("replaced");
        expect(reply(6)).toEqual({ t: "continue", id: 6 });
    });

    it("response stage: chunks reassembled, transform → fulfill; headers-only → continue{headers}", async () => {
        const p = new HelperStrategy();
        await ready(p, [
            makeScript(
                "a",
                `wt.onResponseHeaders({ url: "https://x.com/*", strategy: "helper" }, (c) => ({ headers: { set: { "x-seen": c.statusLine.split(" ")[1] } } }));
wt.onResponseBody({ url: "https://x.com/*", strategy: "helper" }, (c, body) => (c.url.endsWith("/t") ? body.toUpperCase() : undefined));`
            ),
        ]);
        const headers: [string, string][] = [
            ["content-type", "text/plain"],
            ["etag", "abc"],
        ];
        fake.deliver({ t: "chunk", id: 1, data: enc("hello ") });
        fake.deliver({ t: "chunk", id: 1, data: enc("world") });
        fake.deliver({ t: "res", id: 1, url: "https://x.com/t", method: "GET", status: 200, headers, body: "chunks" });
        fake.deliver({ t: "chunk", id: 2, data: enc("keep") });
        fake.deliver({ t: "res", id: 2, url: "https://x.com/k", method: "GET", status: 404, headers, body: "chunks" });
        await settle(60);
        const r1 = reply(1);
        expect(r1.t).toBe("fulfill");
        expect(dec(r1.body)).toBe("HELLO WORLD");
        expect(r1.headers).toContainEqual(["x-seen", "200"]);
        expect(r1.headers).toContainEqual(["cache-control", "no-store"]);
        expect(r1.headers.find(([k]: string[]) => k === "etag")).toBeUndefined();
        const r2 = reply(2);
        expect(r2.t).toBe("continue");
        expect(r2.headers).toContainEqual(["x-seen", "404"]);
    });

    it("binary bodies reach binary: true onResponseBody routes as bytes", async () => {
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onResponseBody({ url: "https://x.com/*", strategy: "helper", binary: true }, (c, body) => typeof body === "string" ? "text:" + body : "bytes:" + body.length);`)]);
        expect(fake.sent.find((m) => m.t === "config").routes[0].binary).toBe(true);
        fake.deliver({ t: "chunk", id: 1, data: bytesToBase64(new Uint8Array([0, 1, 2, 3])) });
        fake.deliver({ t: "res", id: 1, url: "https://x.com/b.png", method: "GET", status: 200, headers: [["content-type", "image/png"]], body: "chunks" });
        // text still arrives as a string on a binary route
        fake.deliver({ t: "chunk", id: 2, data: bytesToBase64(new TextEncoder().encode("hi")) });
        fake.deliver({ t: "res", id: 2, url: "https://x.com/a.svg", method: "GET", status: 200, headers: [["content-type", "image/svg+xml"]], body: "chunks" });
        await settle(40);
        expect(dec(reply(1).body)).toBe("bytes:4");
        expect(dec(reply(2).body)).toBe("text:hi");
    });

    it("binary bodies skip routes without binary: true (and say why)", async () => {
        __resetTaps();
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onResponseBody({ url: "https://x.com/*", strategy: "helper" }, (c, body) => "changed");`)]);
        fake.deliver({ t: "chunk", id: 1, data: bytesToBase64(new Uint8Array([0, 1, 2, 3])) });
        fake.deliver({ t: "res", id: 1, url: "https://x.com/b.png", method: "GET", status: 200, headers: [["content-type", "image/png"]], body: "chunks" });
        await settle(40);
        expect(reply(1).t).toBe("continue");
        expect(helperSkipSince("https://x.com/b.png", 0)).toMatchObject({ why: "binary", contentType: "image/png" });
    });

    it("helper missing → state missing, no retry loop; Retry reconnects", async () => {
        const p = new HelperStrategy();
        p.reload([makeScript("a", `wt.onRequest({ url: "*", strategy: "helper" }, () => {});`)]);
        await settle();
        fake.disconnect("Specified native messaging host not found.");
        expect(p.status().state).toBe("missing");
        expect(helperActive()).toBe(false);
        expect(fake.connects).toBe(1);
        p.reconnect();
        expect(fake.connects).toBe(2);
    });

    it("helper crash → inactive and PAC removed (browser proxy restored)", async () => {
        fake.proxyValue = { mode: "direct" };
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onRequest({ url: "*", strategy: "helper" }, () => {});`)]);
        expect(helperActive()).toBe(true);
        fake.disconnect("Native host has exited.");
        await settle();
        expect(helperActive()).toBe(false);
        expect(fake.proxyValue.mode).toBe("system"); // cleared → browser default
        expect(p.status().state).toBe("error");
    });
});

describe("helper version check", () => {
    it("isHelperOutdated compares x.y.z numerically", () => {
        expect(isHelperOutdated("0.0.1", "0.1.0")).toBe(true);
        expect(isHelperOutdated("0.9.0", "0.10.0")).toBe(true);
        expect(isHelperOutdated("0.1.0", "0.1.0")).toBe(false);
        expect(isHelperOutdated("0.2.0", "0.1.0")).toBe(false);
        expect(isHelperOutdated("v1.0.0", "1.0.1")).toBe(true);
        expect(isHelperOutdated(undefined, "0.1.0")).toBe(false);
        expect(isHelperOutdated(MIN_HELPER_VERSION)).toBe(false);
        expect(isHelperOutdated("0.2.0")).toBe(true); // pre-URLPattern helper
        expect(isHelperOutdated("garbage", "0.1.0")).toBe(false);
    });

    it("helper below the minimum → one error with the upgrade command; Retry restarts it", async () => {
        clearDebugBuffer();
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onRequest({ url: "*://x.com/*", strategy: "helper" }, () => {});`)], "0.0.0");
        expect(p.status().outdated).toBe(true);
        const errs = getDebugBuffer().filter((e) => e.level === "error" && /older than this extension needs/.test(e.msg));
        expect(errs.length).toBe(1);
        expect(errs[0].msg).toContain("v0.0.0");
        expect(errs[0].msg).toContain("install.sh");
        const before = fake.connects;
        p.reconnect();
        await settle();
        expect(fake.connects).toBe(before + 1);
        fake.deliver({ t: "ready", port: 41235, version: MIN_HELPER_VERSION, caPem: "", caFingerprint: "AA", caPath: "/tmp/ca.pem" });
        await settle();
        expect(p.status().outdated).toBe(false);
        p.reconnect(); // up to date → no restart
        expect(fake.connects).toBe(before + 1);
    });

    it("helper older than the extension but ≥ minimum → no error", async () => {
        (globalThis as any).chrome.runtime.getManifest = () => ({ version: "9.9.9" });
        clearDebugBuffer();
        const p = new HelperStrategy();
        await ready(p, [makeScript("a", `wt.onRequest({ url: "*://x.com/*", strategy: "helper" }, () => {});`)], MIN_HELPER_VERSION);
        expect(p.status().outdated).toBe(false);
        expect(getDebugBuffer().some((e) => /older than this extension needs/.test(e.msg))).toBe(false);
    });
});
