import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessStrategy, applyHeaderMods, base64ToBytes, bytesToBase64, filterUrlsFor, ownedOf, pairsToObject } from "../src/background/engine/strategies/processStrategy";
import { isProcessOwned, listsProcess, processActive, setProcessActive } from "../src/background/engine/strategies/processState";
import { CdpStrategy } from "../src/background/engine/strategies/cdpStrategy";
import { compileScript } from "../src/shared/compile";
import type { Script } from "../src/background/engine/scriptStore";

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

async function ready(p: ProcessStrategy, scripts: Script[]): Promise<void> {
    p.reload(scripts);
    await settle();
    fake.deliver({ t: "ready", port: 41234, version: "0.1.0", caPem: "", caFingerprint: "AA", caPath: "/tmp/ca.pem" });
    await settle();
}

const enc = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const dec = (b: string) => new TextDecoder().decode(base64ToBytes(b));

beforeEach(() => {
    installChrome();
    setProcessActive(false);
});
afterEach(() => setProcessActive(false));

describe("listsProcess / ownership", () => {
    it("process first, or after hook only", () => {
        expect(listsProcess("process")).toBe(true);
        expect(listsProcess("hook,process,cdp")).toBe(true);
        expect(listsProcess(["process", "cdp"])).toBe(true);
        expect(listsProcess("cdp,process")).toBe(false);
        expect(listsProcess("webrequest,process")).toBe(false);
        expect(listsProcess("hook")).toBe(false);
        expect(listsProcess(undefined)).toBe(false);
    });
    it("owned only while active", () => {
        expect(isProcessOwned("process")).toBe(false);
        setProcessActive(true);
        expect(isProcessOwned("process")).toBe(true);
        expect(isProcessOwned("cdp")).toBe(false);
    });
    it("cdp tier yields process-owned scripts only while active (fallback otherwise)", () => {
        const s = makeScript("a", `res.declareScript({ match: ["*"], strategy: ["process", "cdp"] });\nres.modifyResponse((c, b) => b);`);
        const c = new CdpStrategy();
        c.reload([s]);
        expect(c.cdpRelevantScripts("https://x.com/").length).toBe(1);
        setProcessActive(true);
        c.reload([s]);
        expect(c.cdpRelevantScripts("https://x.com/")).toEqual([]);
    });
});

describe("helpers", () => {
    it("ownedOf respects handlers and phase", () => {
        const h = { onRequest: 1, modifyResponse: 0, replaceResponse: 0, onResponseHeaders: 0 };
        expect(ownedOf("a", "A", ["*"], undefined, h)).toMatchObject({ req: true, resHeaders: false, body: false });
        expect(ownedOf("a", "A", ["*"], ["response"], h)).toBeNull();
        expect(ownedOf("a", "A", ["*"], ["response"], { ...h, onRequest: 0, replaceResponse: 1 })).toMatchObject({ req: true });
        expect(ownedOf("a", "A", ["*"], undefined, { ...h, onRequest: 0, modifyResponse: 1 })).toMatchObject({ req: false, body: true });
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

describe("ProcessStrategy ⇄ helper protocol", () => {
    it("no process scripts → never connects", async () => {
        const p = new ProcessStrategy();
        p.reload([makeScript("a", `res.declareScript({ match: ["*"], strategy: ["cdp"] });\nres.modifyResponse((c, b) => b);`)]);
        await settle();
        expect(fake.connects).toBe(0);
        expect(p.status().state).toBe("idle");
    });

    it("ready → config, PAC install, active; user proxy captured & respected", async () => {
        fake.proxyValue = { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "corp", port: 3128 } } };
        const p = new ProcessStrategy();
        await ready(p, [makeScript("a", `res.declareScript({ match: ["https://api.x.com/*"], strategy: ["process"] });\nres.modifyResponse((c, b) => b + "!");`)]);
        const cfg = fake.sent.find((m) => m.t === "config");
        expect(cfg.routes).toEqual([{ match: ["https://api.x.com/*"], req: false, resHeaders: false, body: true }]);
        expect(cfg.upstream).toBe("ask");
        expect(fake.proxyValue.mode).toBe("pac_script");
        expect(fake.proxyValue.pacScript.data).toContain("127.0.0.1:41234");
        expect(processActive()).toBe(true);
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
        const p = new ProcessStrategy();
        await ready(p, [makeScript("a", `res.declareScript({ match: ["*"], strategy: ["process", "cdp"] });\nres.onRequest(() => {});`)]);
        expect(processActive()).toBe(false);
        expect(p.status().routing?.active).toBe(false);
        expect(fake.sent.find((m) => m.t === "config").routes).toEqual([]);
    });

    it("request stage: redirect / respond / cancel / headers / replaceResponse / claimed", async () => {
        const p = new ProcessStrategy();
        await ready(p, [
            makeScript(
                "a",
                `res.declareScript({ match: ["https://x.com/*"], strategy: ["process"] });
res.onRequest((c) => {
    if (c.url.endsWith("/r")) return { redirect: "https://x.com/target" };
    if (c.url.endsWith("/j")) return { respond: { status: 201, body: { ok: 1 }, mime: "application/json" } };
    if (c.url.endsWith("/c")) return { cancel: true };
    if (c.url.endsWith("/h")) return { headers: { set: { "X-Added": "1" }, remove: ["cookie"] } };
});
res.replaceResponse((c) => (c.url.endsWith("/rep") ? "replaced" : undefined));`
            ),
        ]);
        const H: [string, string][] = [
            ["Host", "x.com"],
            ["Cookie", "s=1"],
        ];
        const ids = { r: 1, j: 2, c: 3, h: 4, rep: 5, none: 6, claimed: 7 };
        for (const [k, id] of Object.entries(ids)) fake.deliver({ t: "req", id, url: `https://x.com/${k}`, method: "GET", headers: H });
        p.isClaimed = (u) => u.endsWith("/claimed");
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
        expect(reply(7)).toEqual({ t: "continue", id: 7 });
    });

    it("response stage: chunks reassembled, transform → fulfill; headers-only → continue{headers}", async () => {
        const p = new ProcessStrategy();
        await ready(p, [
            makeScript(
                "a",
                `res.declareScript({ match: ["https://x.com/*"], strategy: ["process"] });
res.onResponseHeaders((c) => ({ headers: { set: { "x-seen": c.statusLine.split(" ")[1] } } }));
res.modifyResponse((c, body) => (c.url.endsWith("/t") ? body.toUpperCase() : undefined));`
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

    it("binary bodies reach modifyResponse as bytes (MV2)", async () => {
        const p = new ProcessStrategy();
        await ready(p, [makeScript("a", `res.declareScript({ match: ["https://x.com/*"], strategy: ["process"] });\nres.modifyResponse((c, body) => typeof body === "string" ? "text" : "bytes:" + body.length);`)]);
        fake.deliver({ t: "chunk", id: 1, data: bytesToBase64(new Uint8Array([0, 1, 2, 3])) });
        fake.deliver({ t: "res", id: 1, url: "https://x.com/b.png", method: "GET", status: 200, headers: [["content-type", "image/png"]], body: "chunks" });
        await settle(40);
        expect(dec(reply(1).body)).toBe("bytes:4");
    });

    it("helper missing → state missing, no retry loop; Retry reconnects", async () => {
        const p = new ProcessStrategy();
        p.reload([makeScript("a", `res.declareScript({ match: ["*"], strategy: ["process", "cdp"] });\nres.onRequest(() => {});`)]);
        await settle();
        fake.disconnect("Specified native messaging host not found.");
        expect(p.status().state).toBe("missing");
        expect(processActive()).toBe(false);
        expect(fake.connects).toBe(1);
        p.reconnect();
        expect(fake.connects).toBe(2);
    });

    it("helper crash → inactive and PAC removed (browser proxy restored)", async () => {
        fake.proxyValue = { mode: "direct" };
        const p = new ProcessStrategy();
        await ready(p, [makeScript("a", `res.declareScript({ match: ["*"], strategy: ["process"] });\nres.onRequest(() => {});`)]);
        expect(processActive()).toBe(true);
        fake.disconnect("Native host has exited.");
        await settle();
        expect(processActive()).toBe(false);
        expect(fake.proxyValue.mode).toBe("system"); // cleared → browser default
        expect(p.status().state).toBe("error");
    });
});
