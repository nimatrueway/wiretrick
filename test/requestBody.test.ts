import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFetchBody, REQUEST_BODY_CAP, requestBodyCtx, requestBodyFrom, requestBodyFromText, requestBodyFromWebRequest } from "../src/shared/requestBody";
import { setTextTypes } from "../src/shared/bodyKind";
import { runOp } from "../src/shared/bodyOps";
import { normalizeRoute, NET_KINDS, setDefaultStrategy } from "../src/shared/route";
import { compileScript } from "../src/shared/compile";
import { probeScriptRules } from "../src/shared/rulesProbe";
import { PageStrategy } from "../src/background/engine/strategies/pageStrategy";
import { DebuggerStrategy } from "../src/background/engine/strategies/debuggerStrategy";
import { ExtensionStrategy } from "../src/background/engine/strategies/extensionStrategy";
import { HelperStrategy } from "../src/background/engine/strategies/helperStrategy";
import { setHelperActive } from "../src/background/engine/strategies/helperState";
import { base64ToBytes, bytesToBase64 } from "../src/shared/bytesPack";
import type { Script } from "../src/background/engine/scriptStore";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => bytesToBase64(enc(s));

function makeScript(id: string, code: string): Script {
    return { id, code, enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: compileScript(code).meta };
}

/** a handler body that reports what it saw as a redirect URL */
const SEEN = `({ redirect: "https://seen.test/?" + encodeURIComponent(JSON.stringify({ kind: typeof c.requestBody === "string" ? "text" : c.requestBody ? "bytes" : "none", body: typeof c.requestBody === "string" ? c.requestBody : c.requestBody ? Array.from(c.requestBody) : null, json: (() => { try { return c.json() ?? null; } catch (e) { return "error"; } })() })) })`;
const seen = (url: string) => JSON.parse(decodeURIComponent(url.split("?")[1]));

afterEach(() => setTextTypes(null));

describe("kind decision", () => {
    it("text Content-Types → string, others → bytes, none → sniffed", () => {
        expect(requestBodyFrom(enc('{"a":1}'), "application/json; charset=utf-8")).toBe('{"a":1}');
        expect(requestBodyFrom(enc("a=1&b=2"), "application/x-www-form-urlencoded")).toBe("a=1&b=2");
        expect(requestBodyFrom(enc("plain"), "image/png")).toEqual(enc("plain"));
        expect(requestBodyFrom(enc("no type"), undefined)).toBe("no type");
        expect(requestBodyFrom(new Uint8Array([1, 0, 2]), undefined)).toEqual(new Uint8Array([1, 0, 2]));
    });

    it("honors settings.textTypes, like response bodies", () => {
        setTextTypes(["application/octet-stream"]);
        expect(requestBodyFrom(enc("x"), "application/octet-stream")).toBe("x");
        expect(requestBodyFrom(enc("{}"), "application/json")).toEqual(enc("{}"));
    });

    it("empty and over-cap bodies → undefined; UTF-8 decoded", () => {
        expect(requestBodyFrom(new Uint8Array(0), "text/plain")).toBeUndefined();
        expect(requestBodyFrom(null, "text/plain")).toBeUndefined();
        expect(requestBodyFrom(new Uint8Array(REQUEST_BODY_CAP + 1), "text/plain")).toBeUndefined();
        expect(requestBodyFrom(enc("héllo ✓"), "text/plain")).toBe("héllo ✓");
    });

    it("a string body stays a string unless its Content-Type is binary", () => {
        expect(requestBodyFromText("hi", null)).toBe("hi");
        expect(requestBodyFromText("hi", "text/plain")).toBe("hi");
        expect(requestBodyFromText("hi", "application/octet-stream")).toEqual(enc("hi"));
        expect(requestBodyFromText("", "text/plain")).toBeUndefined();
    });
});

describe("ctx.json()", () => {
    it("parses the request body: string or UTF-8 bytes", () => {
        expect(requestBodyCtx('{"a":[1,2]}').json()).toEqual({ a: [1, 2] });
        expect(requestBodyCtx(enc('{"é":true}')).json()).toEqual({ é: true });
    });

    it("no body → undefined; invalid JSON throws a clear error", () => {
        expect(requestBodyCtx(undefined).json()).toBeUndefined();
        expect(requestBodyCtx(undefined).requestBody).toBeUndefined();
        expect(() => requestBodyCtx("a=1").json()).toThrow(/^ctx\.json\(\): the request body is not valid JSON/);
    });

    it("every op's ctx carries requestBody + json()", async () => {
        const got: Record<string, any> = {};
        const spy = (k: string) => (c: any) => void (got[k] = { body: c.requestBody, json: c.json() });
        const handlers: any = Object.fromEntries(
            [...NET_KINDS, "onDocument"].map((k) => [k, k === "onDocument" ? [] : [{ fn: spy(k), route: normalizeRoute(k as any, "*://x.test/*", 0) }]])
        );
        const scripts = [{ id: "s", name: "S", handlers }];
        const args = { url: "https://x.test/a", method: "POST", requestBody: '{"n":1}' };
        const env = { log: () => {} } as any;
        await runOp(scripts as any, "requestDecision", args, env);
        await runOp(scripts as any, "replace", args, env);
        await runOp(scripts as any, "responseHeaders", { ...args, status: 200, responseHeaders: [] }, env);
        await runOp(scripts as any, "transform", { ...args, body: "resp", status: 200, contentType: "text/plain" }, env);
        for (const k of ["onRequest", "replaceResponse", "onResponseHeaders", "onResponseBody"]) expect(got[k], k).toEqual({ body: '{"n":1}', json: { n: 1 } });
    });
});

describe("page strategy: fetch / XHR bodies", () => {
    const url = "https://x.test/api";
    it("string, URLSearchParams, Blob, ArrayBuffer, typed array", async () => {
        expect(await readFetchBody(url, { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } }, url, "POST")).toBe('{"a":1}');
        expect(await readFetchBody(url, { method: "POST", body: new URLSearchParams({ q: "a b", n: "1" }) }, url, "POST")).toBe("q=a+b&n=1");
        expect(await readFetchBody(url, { method: "PUT", body: new Blob(["<x/>"], { type: "application/xml" }) }, url, "PUT")).toBe("<x/>");
        expect(await readFetchBody(url, { method: "POST", body: new Uint8Array([0, 1, 2]).buffer }, url, "POST")).toEqual(new Uint8Array([0, 1, 2]));
        expect(await readFetchBody(url, { method: "POST", body: new Uint8Array([0, 9]), headers: { "content-type": "image/png" } }, url, "POST")).toEqual(new Uint8Array([0, 9]));
    });

    it("FormData is multipart: bytes unless textTypes says otherwise", async () => {
        const fd = new FormData();
        fd.set("name", "ada");
        const b = await readFetchBody(url, { method: "POST", body: fd }, url, "POST");
        expect(b).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(b as Uint8Array)).toContain('name="name"');
    });

    it("a Request input is cloned, never consumed", async () => {
        const req = new Request(url, { method: "POST", body: '{"r":true}', headers: { "content-type": "application/json" } });
        expect(await readFetchBody(req, undefined, url, "POST")).toBe('{"r":true}');
        expect(req.bodyUsed).toBe(false);
        expect(await req.json()).toEqual({ r: true });
    });

    it("streams, GET/HEAD and over-cap bodies → undefined", async () => {
        const stream = new ReadableStream({ start: (c) => c.enqueue(enc("x")) });
        expect(await readFetchBody(url, { method: "POST", body: stream, duplex: "half" } as any, url, "POST")).toBeUndefined();
        expect(await readFetchBody(url, { method: "GET" }, url, "GET")).toBeUndefined();
        expect(await readFetchBody(url, { method: "POST", body: new Uint8Array(REQUEST_BODY_CAP + 1) }, url, "POST")).toBeUndefined();
        expect(await readFetchBody(url, { method: "POST" }, url, "POST")).toBeUndefined();
    });

    it("the page strategy hands it to onRequest, replaceResponse and onResponseBody", async () => {
        setDefaultStrategy("page");
        try {
            const s = new PageStrategy();
            s.reload([
                makeScript(
                    "a",
                    `wt.onRequest("*://x.test/*", (c) => ${SEEN});
wt.onResponseBody("*://x.test/*", (c, body) => body + ":" + c.json().n);`
                ),
                makeScript("b", `wt.replaceResponse("*://x.test/*", (c) => "replaced " + c.requestBody);`),
            ]);
            const d: any = await s.runRequestDecision(url, "POST", -1, '{"n":7}');
            expect(seen(d.url)).toEqual({ kind: "text", body: '{"n":7}', json: { n: 7 } });
            expect((await s.runReplace(url, "POST", -1, "abc"))?.content).toBe("replaced abc");
            expect(await s.runTransform(url, "POST", "resp", { requestBody: '{"n":3}' })).toBe("resp:3");
        } finally {
            setDefaultStrategy(null);
        }
    });
});

describe("debugger strategy: Fetch.requestPaused post data", () => {
    let calls: { command: string; params: any }[];
    let replies: Record<string, any>;
    beforeEach(() => {
        calls = [];
        replies = {};
        (globalThis as any).chrome = {
            runtime: { getURL: (p: string) => `chrome-extension://t/${p}`, sendMessage: vi.fn(async () => ({})), lastError: undefined },
            storage: { local: { get: async () => ({}), set: async () => {} } },
            debugger: {
                attach: (_d: any, _v: any, cb: () => void) => cb(),
                detach: (_d: any, cb: () => void) => cb(),
                sendCommand: (_d: any, command: string, params: any, cb: (r?: any) => void) => {
                    calls.push({ command, params });
                    cb(replies[command] ?? {});
                },
                getTargets: (cb: (t: any[]) => void) => cb([]),
            },
        };
    });
    const strategy = () => {
        const c = new DebuggerStrategy();
        c.reload([
            makeScript(
                "a",
                `wt.onRequest({ url: "*://x.test/*", strategy: "debugger" }, (c) => ${SEEN});
wt.onResponseBody({ url: "*://x.test/*", strategy: "debugger" }, (c, body) => body + "|" + c.requestBody);`
            ),
        ]);
        return c;
    };
    const paused = (request: any, over: any = {}) => ({ requestId: "f1", networkId: "n1", resourceType: "XHR", request: { url: "https://x.test/a", method: "POST", headers: {}, ...request }, ...over });
    const redirected = () => seen(calls.find((x) => x.command === "Fetch.continueRequest")!.params.url);

    it("postDataEntries (base64 bytes) are joined; the Content-Type decides the kind", async () => {
        await strategy().handlePaused("tab:1", paused({ headers: { "Content-Type": "application/json" }, hasPostData: true, postDataEntries: [{ bytes: b64('{"a":') }, { bytes: b64("1}") }] }));
        expect(redirected()).toEqual({ kind: "text", body: '{"a":1}', json: { a: 1 } });
    });

    it("binary entries arrive as bytes", async () => {
        await strategy().handlePaused("tab:1", paused({ headers: { "content-type": "application/octet-stream" }, hasPostData: true, postDataEntries: [{ bytes: bytesToBase64(new Uint8Array([0, 255])) }] }));
        expect(redirected()).toMatchObject({ kind: "bytes", body: [0, 255] });
    });

    it("postData string; a file part (no bytes) → undefined", async () => {
        await strategy().handlePaused("tab:1", paused({ hasPostData: true, postData: "x=1" }));
        expect(redirected()).toMatchObject({ kind: "text", body: "x=1" });
        calls.length = 0;
        await strategy().handlePaused("tab:1", paused({ hasPostData: true, postDataEntries: [{ bytes: b64("a") }, {}] }));
        expect(redirected()).toMatchObject({ kind: "none" });
    });

    it("hasPostData without data → Network.getRequestPostData", async () => {
        replies["Network.getRequestPostData"] = { postData: '{"late":1}' };
        await strategy().handlePaused("tab:1", paused({ headers: { "content-type": "application/json" }, hasPostData: true }));
        expect(calls.find((x) => x.command === "Network.getRequestPostData")!.params).toEqual({ requestId: "n1" });
        expect(redirected()).toMatchObject({ json: { late: 1 } });
    });

    it("the response stage has it too", async () => {
        replies["Fetch.getResponseBody"] = { body: "resp", base64Encoded: false };
        await strategy().handlePaused("tab:1", paused({ hasPostData: true, postData: "req" }, { responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "text/plain" }] }));
        const f = calls.find((x) => x.command === "Fetch.fulfillRequest")!;
        expect(new TextDecoder().decode(base64ToBytes(f.params.body))).toBe("resp|req");
    });
});

describe("extension strategy: webRequest requestBody", () => {
    beforeEach(() => {
        setDefaultStrategy("extension");
        (globalThis as any).chrome = {
            runtime: { getURL: (p: string) => `chrome-extension://t/${p}`, sendMessage: async () => ({}) },
            storage: { local: { get: async () => ({}), set: async () => {} } },
            tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
        };
        delete (globalThis as any).browser;
        new ExtensionStrategy().pruneRequest("r1");
    });
    afterEach(() => setDefaultStrategy(null));

    it("formData → urlencoded; raw → bytes (sniffed); files / errors → undefined", () => {
        expect(requestBodyFromWebRequest({ formData: { q: ["a b"], tag: ["x", "y"] } })).toBe("q=a%20b&tag=x&tag=y");
        expect(requestBodyFromWebRequest({ raw: [{ bytes: enc('{"a":').buffer }, { bytes: enc("1}").buffer }] })).toBe('{"a":1}');
        expect(requestBodyFromWebRequest({ raw: [{ bytes: new Uint8Array([0, 1]).buffer }] })).toEqual(new Uint8Array([0, 1]));
        expect(requestBodyFromWebRequest({ raw: [{ file: "/x.bin" }] })).toBeUndefined();
        expect(requestBodyFromWebRequest({ error: "too big" })).toBeUndefined();
        expect(requestBodyFromWebRequest(undefined)).toBeUndefined();
    });

    it("onRequest sees it; onResponseHeaders gets it from onBeforeRequest; pruned after", () => {
        const s = new ExtensionStrategy();
        s.reload([
            makeScript(
                "a",
                `wt.onRequest("*://x.test/*", (c) => (c.json() ? ${SEEN} : undefined));
wt.onResponseHeaders("*://x.test/*", (c) => ({ headers: { set: { "x-req": c.requestBody ?? "none" } } }));`
            ),
        ]);
        const details = { url: "https://x.test/a", method: "POST", tabId: 1, type: "xmlhttprequest", requestId: "r1", requestHeaders: [], responseHeaders: [], statusCode: 200, statusLine: "HTTP/1.1 200 OK" };
        const d: any = s.handleBeforeRequest({ ...details, requestBody: { raw: [{ bytes: enc('{"k":2}').buffer }] } }, null);
        expect(seen(d.url)).toEqual({ kind: "text", body: '{"k":2}', json: { k: 2 } });
        expect((s.handleHeadersReceived(details, null) as any).set["x-req"]).toBe('{"k":2}');
        s.pruneRequest("r1");
        expect((s.handleHeadersReceived(details, null) as any).set["x-req"]).toBe("none");
    });
});

describe("helper strategy: reqBody chunks", () => {
    let sent: any[];
    let deliver: (m: any) => void;
    beforeEach(() => {
        sent = [];
        const listeners: ((m: any) => void)[] = [];
        deliver = (m) => listeners.forEach((f) => f(m));
        (globalThis as any).chrome = {
            runtime: {
                id: "abcdefghijklmnopabcdefghijklmnop",
                getURL: (p: string) => `chrome-extension://t/${p}`,
                lastError: undefined,
                connectNative: () => ({
                    postMessage: (m: any) => sent.push(m),
                    disconnect: () => {},
                    onMessage: { addListener: (f: any) => listeners.push(f) },
                    onDisconnect: { addListener: () => {} },
                }),
            },
            storage: { local: { get: async () => ({}), set: async () => {} } },
            proxy: {
                settings: {
                    get: (_d: any, cb: any) => cb({ value: { mode: "system" }, levelOfControl: "controllable_by_this_extension" }),
                    set: (_d: any, cb: any) => cb(),
                    clear: (_d: any, cb: any) => cb(),
                },
                onProxyError: { addListener: () => {} },
            },
            webRequest: { onBeforeRequest: { addListener: () => {}, removeListener: () => {} } },
            browsingData: { removeCache: (_o: any, cb: any) => cb() },
        };
        (globalThis as any).fetch = async () => ({ ok: true, text: async () => "ok" });
        setHelperActive(false);
    });
    afterEach(() => setHelperActive(false));
    const settle = async () => {
        for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
    };

    it("config opts in; request and response stages get the body; chunks are freed", async () => {
        const p = new HelperStrategy();
        p.reload([
            makeScript(
                "a",
                `wt.onRequest({ url: "https://x.test/*", strategy: "helper" }, (c) => ${SEEN});
wt.onResponseBody({ url: "https://x.test/*", strategy: "helper" }, (c, body) => body + "|" + c.json().n);`
            ),
        ]);
        await settle();
        deliver({ t: "ready", port: 41234, version: "0.4.1", caPem: "", caFingerprint: "AA", caPath: "/x/ca.pem" });
        await settle();
        expect(sent.find((m) => m.t === "config").reqBody).toBe(true);

        deliver({ t: "chunk", id: 10, data: b64('{"n":') });
        deliver({ t: "chunk", id: 10, data: b64("5}") });
        deliver({ t: "req", id: 11, url: "https://x.test/a", method: "POST", headers: [["Content-Type", "application/json"]], reqBody: 10 });
        deliver({ t: "chunk", id: 20, data: b64('{"n":6}') });
        deliver({ t: "chunk", id: 21, data: b64("resp") });
        deliver({ t: "res", id: 21, url: "https://x.test/a", method: "POST", status: 200, headers: [["content-type", "text/plain"]], body: "chunks", reqBody: 20, reqType: "application/json" });
        // an older helper: no reqBody
        deliver({ t: "req", id: 30, url: "https://x.test/b", method: "POST", headers: [] });
        await settle();
        const r = (id: number) => sent.find((m) => m.id === id);
        expect(seen(r(11).url)).toEqual({ kind: "text", body: '{"n":5}', json: { n: 5 } });
        expect(new TextDecoder().decode(base64ToBytes(r(21).body))).toBe("resp|6");
        expect(seen(r(30).url)).toMatchObject({ kind: "none" });
        expect((p as any).chunks.size).toBe(0);
    });
});

describe("rules strategy", () => {
    it("reading ctx.requestBody / ctx.json() is an error (no real request)", async () => {
        const c = compileScript(`wt.onRequest({ url: "*://a.test/*", strategy: "rules" }, (ctx) => (ctx.json()?.x ? { block: true } : undefined));`);
        const r = await probeScriptRules(c.handlers, "helper");
        expect(r.errors[0]).toMatch(/ctx\.json/);
    });
});
