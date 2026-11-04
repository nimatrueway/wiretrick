import { describe, it, expect, vi, afterEach } from "vitest";
import "../src/shared/transpile";
import { compileScript } from "../src/shared/compile";
import { splitFetchInit, toWireRequest, fromWireRequest, toWireResponse, fromWireResponse } from "../src/shared/wtFetch";
import { FETCH_MAX_BYTES } from "../src/shared/wire";

afterEach(() => vi.unstubAllGlobals());

describe("wt.fetch wire helpers", () => {
    it("splitFetchInit strips from/bypass and checks them", () => {
        expect(splitFetchInit({ method: "POST", from: "background", bypass: true })).toEqual({ init: { method: "POST" }, from: "background", bypass: true });
        expect(splitFetchInit(undefined)).toEqual({ init: {}, from: undefined, bypass: false });
        expect(() => splitFetchInit({ from: "tab" as any })).toThrow(/from/);
    });

    it("a request round-trips with its body and only the options that were set", async () => {
        const w = await toWireRequest("https://a.com/p", { method: "post", headers: { "x-a": "1" }, body: "hello", credentials: "omit", signal: new AbortController().signal });
        expect(w).toMatchObject({ url: "https://a.com/p", method: "POST", credentials: "omit" });
        expect(w.headers).toContainEqual(["x-a", "1"]);
        expect(new TextDecoder().decode(w.body)).toBe("hello");
        expect("redirect" in w).toBe(false);
        const [url, init] = fromWireRequest(w, { credentials: "include" });
        expect(url).toBe("https://a.com/p");
        expect(init.credentials).toBe("omit");
        expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("hello");
        expect(fromWireRequest({ url: "https://a.com/", method: "GET", headers: [] }, { credentials: "include" })[1].credentials).toBe("include");
    });

    it("GET has no body; a relative URL is refused", async () => {
        expect((await toWireRequest(new URL("https://a.com/"), {})).body).toBeUndefined();
        await expect(toWireRequest("/rel", {})).rejects.toThrow(TypeError);
    });

    it("a response round-trips; 204 has no body; the size cap holds", async () => {
        const w = await toWireResponse(new Response(JSON.stringify({ a: 1 }), { status: 201, statusText: "Created", headers: { "content-type": "application/json" } }));
        const r = fromWireResponse({ ...w, url: "https://a.com/x" });
        expect(r.status).toBe(201);
        expect(r.statusText).toBe("Created");
        expect(r.url).toBe("https://a.com/x");
        expect(r.headers.get("content-type")).toBe("application/json");
        expect(await r.json()).toEqual({ a: 1 });
        const empty = fromWireResponse({ status: 204, statusText: "", url: "", headers: [], body: new Uint8Array() });
        expect(empty.status).toBe(204);
        expect(await empty.text()).toBe("");
        await expect(toWireResponse(new Response(new Uint8Array(11)), 10)).rejects.toThrow(RangeError);
        expect(FETCH_MAX_BYTES).toBe(10 * 1024 * 1024);
    });
});

describe("wt.globalStore / wt.fetch in the background shim", () => {
    it("a store without an owner is a local valtio proxy; options are checked", () => {
        const c = compileScript(`export const s = wt.globalStore("ui", { n: 1 }); s.n++;`);
        expect(c.error).toBeNull();
        expect(c.exports.s.n).toBe(2);
        expect(compileScript(`wt.globalStore("ui", { n: 1 }, { persist: ["n"] });`).error).toBeNull();
        expect(compileScript(`wt.globalStore("ui", { n: 1 }, { persist: 3 });`).error).toMatch(/persist must be/);
        expect(compileScript(`wt.globalStore("", {});`).error).toMatch(/name/);
        expect(compileScript(`wt.globalStore("a", [1]);`).error).toMatch(/initial must be an object/);
    });

    it("a name may be used once per script", () => {
        expect(compileScript(`wt.globalStore("a", {}); wt.globalStore("a", {});`).error).toMatch(/already has a store named "a"/);
        expect(compileScript(`wt.globalStore("a", {}); wt.globalStore("b", {});`).error).toBeNull();
    });

    it("the store override gets name, initial and persist", () => {
        const seen: any[] = [];
        const c = compileScript(`export const s = wt.globalStore("ui", { n: 1 }, { persist: false });`, {
            store: (name, initial, persist) => (seen.push([name, initial, persist]), { from: "owner" }),
        });
        expect(c.error).toBeNull();
        expect(seen).toEqual([["ui", { n: 1 }, false]]);
        expect(c.exports.s).toEqual({ from: "owner" });
    });

    it("wt.storage.set on a store's key warns", () => {
        const seen: string[] = [];
        compileScript(`wt.storage.set("$store:ui", 1);`, { logSink: (_l, _s, text) => seen.push(text) });
        expect(seen.join("\n")).toMatch(/persisted copy of wt\.globalStore\("ui"\)/);
    });

    it('from: "page" rejects in background code', async () => {
        const c = compileScript(`export const go = () => wt.fetch("https://a.com/", { from: "page" });`);
        await expect(c.exports.go()).rejects.toThrow(/only an overlay/);
    });

    it("fetch goes through the override with the bypass flag and comes back a Response", async () => {
        const seen: any[] = [];
        const c = compileScript(`export const go = () => wt.fetch("https://a.com/x", { method: "PUT", body: "b", bypass: true });`, {
            fetch: async (request, bypass) => {
                seen.push({ url: request.url, method: request.method, body: new TextDecoder().decode(request.body), bypass });
                return { status: 200, statusText: "OK", url: request.url, headers: [["x-y", "z"]], body: new TextEncoder().encode("done") };
            },
        });
        const r: Response = await c.exports.go();
        expect(seen).toEqual([{ url: "https://a.com/x", method: "PUT", body: "b", bypass: true }]);
        expect(r).toBeInstanceOf(Response);
        expect(r.headers.get("x-y")).toBe("z");
        expect(await r.text()).toBe("done");
    });

    it("without an override, fetch is the plain fetch with cookies", async () => {
        const fetchMock = vi.fn(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);
        const c = compileScript(`export const go = () => wt.fetch("https://a.com/");`);
        expect(await (await c.exports.go()).text()).toBe("ok");
        expect((fetchMock.mock.calls[0] as any[])[1]).toMatchObject({ credentials: "include" });
    });
});
