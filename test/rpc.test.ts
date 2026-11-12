import { describe, it, expect, vi, afterEach } from "vitest";
import { AbortError, CANCEL_FN, DisconnectedError, Exposer, NOT_RUNNING, RPC_QUEUE_MAX, ReloadedError, RpcClient, WtCallError, callSignal, isRpcCall, isRpcResult, type RpcCall, type RpcResult } from "../src/shared/rpc";
import { makePageShim, domHandlersFor, firePageHandler } from "../src/shared/pageShim";
import { inertRemote, SiteCannotCallError } from "../src/shared/remote";
import { compileScript, keyPlaceCalls } from "../src/shared/compile";
import type { PlaceApi } from "../src/shared/route";
import { formatScriptError, scriptUrl } from "../src/shared/scriptError";

const tick = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** a client wired straight to an exposer (as the bridge does for the isolated world) */
function link(exposer: Exposer) {
    const sent: RpcCall[] = [];
    const replies: RpcResult[] = [];
    const client: RpcClient = new RpcClient((call) => {
        sent.push(call);
        exposer.answer(call, (r) =>
            queueMicrotask(() => {
                replies.push(r);
                client.receive(r);
            })
        );
    });
    return { client, sent, replies };
}

/** run a script's onSite / onPage code like a page runtime does, answering its handles */
function runPage(src: string, opts: { world?: "page" | "isolated"; url?: string; call?: (api: PlaceApi, key: string) => any } = {}) {
    const exposer = new Exposer();
    const shim = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: opts.world ?? "isolated", exposer, call: opts.call });
    const moduleObj = { exports: {} as any };
    new Function("tt", "module", "exports", keyPlaceCalls(src))(shim.tt, moduleObj, moduleObj.exports);
    const dom = domHandlersFor(shim.dom, opts.url ?? "https://x.com/a", exposer);
    exposer.done();
    const fire = () => {
        for (const d of dom)
            try {
                firePageHandler(d, { url: opts.url ?? "https://x.com/a" }, exposer);
            } catch {}
    };
    return { exposer, fire, exports: moduleObj.exports };
}

afterEach(() => vi.useRealTimers());

describe("rpc: calls between the overlay and onPage code", () => {
    it("a failed call's error has the stack of the script line that made the call", async () => {
        const p = runPage(`tt.onPage("*://x.com/*", () => ({ when: () => new Date(0) }));`);
        p.fire();
        const { client } = link(p.exposer);
        const page = client.remote("onPage:0");
        const caller = new Function("page", `"use strict";\nreturn async function load() {\n  return await page.when();\n};\n//# sourceURL=${scriptUrl("main.ts")}`)(page);
        const err = await caller().catch((e: any) => e);
        expect(err).toBeInstanceOf(WtCallError);
        expect(formatScriptError("main.ts", err)).toBe("[main.ts] WtCallError: when(): the result must be JSON — a Date isn't JSON\n    at load (main.ts:2:21)");
    });

    it("round-trips results and thrown errors (message only)", async () => {
        const p = runPage(`tt.onPage("*://x.com/*", () => ({ add: (a, b) => a + b, slow: async (x) => ({ x }), boom: () => { const e = new TypeError("nope"); e.secret = 1; throw e; }, later: async () => { throw new Error("async nope"); } }));`);
        p.fire();
        const { client } = link(p.exposer);
        const page = client.remote("onPage:0");
        expect(await page.add(2, 3)).toBe(5);
        expect(await page.slow([1, "a"])).toEqual({ x: [1, "a"] });
        const err = await page.boom().catch((e: any) => e);
        expect(err).toBeInstanceOf(WtCallError);
        expect(err.message).toBe("nope");
        expect(err.secret).toBeUndefined();
        await expect(page.later()).rejects.toThrow("async nope");
    });

    it("queues calls made before the handler returned, then answers them in order", async () => {
        const p = runPage(`tt.onPage({ url: "*://x.com/*", when: "document_idle" }, () => ({ echo: (x) => x }));`);
        const { client } = link(p.exposer);
        const page = client.remote("onPage:0");
        const got: any[] = [];
        const calls = [1, 2, 3].map((n) => page.echo(n).then((v: any) => got.push(v)));
        await tick();
        expect(got).toEqual([]);
        p.fire();
        await Promise.all(calls);
        expect(got).toEqual([1, 2, 3]);
    });

    it("waits for a handler that returns a Promise", async () => {
        const p = runPage(`tt.onPage("*", async () => { await null; return { v: () => 7 }; });`);
        const { client } = link(p.exposer);
        const call = client.remote("onPage:0").v();
        p.fire();
        expect(await call).toBe(7);
    });

    it("bounds the queue", async () => {
        const p = runPage(`tt.onPage("*", () => ({ f: () => 1 }));`);
        const { client } = link(p.exposer);
        const page = client.remote("onPage:0");
        const calls = Array.from({ length: RPC_QUEUE_MAX + 1 }, () => page.f().then(() => "ok", (e: any) => e.message));
        await tick();
        p.fire();
        const out = await Promise.all(calls);
        expect(out.filter((x) => x === "ok")).toHaveLength(RPC_QUEUE_MAX);
        expect(out[RPC_QUEUE_MAX]).toMatch(/too many calls/);
    });

    it("answers `not running on this page` for a route that didn't match, a handler that threw, or no such handle", async () => {
        const p = runPage(`tt.onPage("*://other.com/*", () => ({ f: () => 1 }));\ntt.onPage("*", () => { throw new Error("x"); });`);
        p.fire();
        const { client } = link(p.exposer);
        await expect(client.remote("onPage:0").f()).rejects.toThrow(NOT_RUNNING);
        await expect(client.remote("onPage:1").f()).rejects.toThrow(NOT_RUNNING);
        await expect(client.remote("onPage:7").f()).rejects.toThrow(NOT_RUNNING);
    });

    it("answers `not running` for the other world's handles", async () => {
        const p = runPage(`tt.onPage("*", () => ({ f: () => 1 }));`, { world: "page" });
        p.fire();
        const { client } = link(p.exposer);
        await expect(client.remote("onPage:0").f()).rejects.toThrow(NOT_RUNNING);
    });

    it("rejects `no such function`, and doesn't reach inherited or non-function members", async () => {
        const p = runPage(`tt.onPage("*", () => ({ f: () => 1, v: 3 }));`);
        p.fire();
        const page = link(p.exposer).client.remote("onPage:0");
        await expect(page.g()).rejects.toThrow(/no such function: g/);
        await expect(page.v()).rejects.toThrow(/no such function: v/);
        await expect(page.toString()).rejects.toThrow(/no such function: toString/);
        await expect(page.constructor()).rejects.toThrow(/no such function/);
    });

    it("a non-plain return value (a string, an Element-like object, a class instance) exposes nothing", async () => {
        for (const ret of [`"hello"`, `new (class El { f() { return 1 } })()`, `null`, `[() => 1]`]) {
            const p = runPage(`tt.onPage("*", () => ${ret});`);
            p.fire();
            await expect(link(p.exposer).client.remote("onPage:0").f()).rejects.toThrow(/no such function/);
        }
    });

    it("has no time limit: a call waits as long as the function does", async () => {
        vi.useFakeTimers();
        const client = new RpcClient(() => {});
        let settled = false;
        void client.remote("onPage:0").f().finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(settled).toBe(false);
    });

    it("the caller's run ending rejects its calls with AbortError and cancels them at the callee", async () => {
        const p = runPage(`let release; tt.onPage("*", () => ({ wait: () => new Promise((r) => (release = r)), quick: () => 1 }));`);
        p.fire();
        const { client, sent, replies } = link(p.exposer);
        const run = new AbortController();
        const page = client.remote("onPage:0", () => run.signal);
        const waiting = page.wait().catch((e: any) => e);
        await tick();
        run.abort("the script reloaded");
        const e = await waiting;
        expect(e).toBeInstanceOf(AbortError);
        expect(e.message).toBe("wait(): the script reloaded");
        expect(sent.map((c) => c.fn)).toEqual(["wait", CANCEL_FN]);
        expect(sent[1].cid).toBe(sent[0].cid);
        await tick();
        // the callee answers the cancel (which clears relays on the way)
        expect(replies.map((r) => r.error?.name)).toEqual(["AbortError"]);
        // an aborted run's later calls reject without being sent
        await expect(page.quick()).rejects.toBeInstanceOf(AbortError);
        expect(sent).toHaveLength(2);
    });

    it("abort() ends the pending calls of some handles; a cancel drops a call still waiting for its handler", async () => {
        const ex = new Exposer();
        ex.register("onPage:0");
        ex.register("onOverlay:0");
        ex.done();
        const { client, sent, replies } = link(ex);
        const a = client.remote("onPage:0").f().catch((e: any) => e);
        const b = client.remote("onOverlay:0").f().catch((e: any) => e);
        client.abort("the script stopped", (h) => h === "onPage:0");
        expect(await a).toBeInstanceOf(AbortError);
        await tick();
        expect(sent.map((c) => c.fn)).toEqual(["f", "f", CANCEL_FN]);
        // the queued call is gone: exposing doesn't run it
        let ran = 0;
        ex.expose("onPage:0", { f: () => ran++ });
        await tick();
        expect(ran).toBe(0);
        expect(replies.filter((r) => r.cid === sent[0].cid).map((r) => r.error?.name)).toEqual(["AbortError"]);
        client.abort("bye");
        expect((await b).name).toBe("AbortError");
    });

    it("callSignal(): an exposed function sees its call's signal, aborted when the caller cancels", async () => {
        const ex = new Exposer();
        ex.register("onPage:0");
        let seen: AbortSignal | undefined;
        ex.expose("onPage:0", { wait: () => ((seen = callSignal()), new Promise(() => {})) });
        ex.done();
        expect(callSignal()).toBeUndefined();
        const run = new AbortController();
        const call = link(ex).client.remote("onPage:0", () => run.signal).wait().catch(() => {});
        await tick();
        expect(seen?.aborted).toBe(false);
        run.abort();
        await call;
        await tick();
        expect(seen?.aborted).toBe(true);
    });

    it("a reload: running calls reject with ReloadedError; calls waiting for the handler wait for the new run", async () => {
        const ex = new Exposer();
        ex.register("onSite:0");
        let seen: AbortSignal | undefined;
        ex.expose("onSite:0", { next: () => ((seen = callSignal()), new Promise(() => {})) });
        ex.register("onSite:1");
        ex.done();
        const { client } = link(ex);
        const running = client.remote("onSite:0").next().catch((e: any) => e);
        const queued = client.remote("onSite:1").v();
        await tick();
        ex.reset();
        const e = await running;
        expect(e).toBeInstanceOf(ReloadedError);
        expect(seen?.aborted).toBe(true);
        // the new run: the queued call is answered by it
        ex.register("onSite:0");
        ex.register("onSite:1");
        ex.done();
        ex.expose("onSite:1", { v: () => "new" });
        expect(await queued).toBe("new");
    });

    it("close(): the script stopped here — waiting calls answer `not running`", async () => {
        const ex = new Exposer();
        ex.register("onPage:0");
        const { client } = link(ex);
        const a = client.remote("onPage:0").f();
        const b = client.remote("onPage:9").f();
        ex.close();
        await expect(a).rejects.toThrow(NOT_RUNNING);
        await expect(b).rejects.toThrow(NOT_RUNNING);
    });

    it("rejects pending calls with DisconnectedError when the other side closes; later calls still work", async () => {
        let answer: ((r: RpcResult) => void) | null = null;
        const client: RpcClient = new RpcClient((call) => {
            answer = (r) => client.receive(r);
            void call;
        });
        const a = client.remote("onOverlay:0").f().catch((e: any) => e);
        const b = client.remote("onPage:0").f().catch((e: any) => e);
        client.disconnect("the overlay closed", (h) => h.startsWith("onOverlay:"));
        expect(await a).toBeInstanceOf(DisconnectedError);
        client.disconnect("gone");
        expect((await b).message).toBe("gone");
        const sent: RpcCall[] = [];
        const c2: RpcClient = new RpcClient((call) => sent.push(call));
        const c = c2.remote("onPage:0").f(1);
        c2.receive({ cid: sent[0].cid, ok: true, value: 2 });
        expect(await c).toBe(2);
        expect(answer).not.toBeNull();
    });

    it("matches out-of-order results by cid and drops unknown or repeated ones", async () => {
        const sent: RpcCall[] = [];
        const client = new RpcClient((c) => sent.push(c));
        const page = client.remote("onPage:0");
        const a = page.f("a");
        const b = page.f("b");
        expect(sent[0].cid).not.toBe(sent[1].cid);
        expect(client.receive({ cid: "nope", ok: true, value: 0 })).toBe(false);
        expect(client.receive({ cid: sent[1].cid, ok: true, value: "B" })).toBe(true);
        expect(client.receive({ cid: sent[0].cid, ok: true, value: "A" })).toBe(true);
        expect(client.receive({ cid: sent[0].cid, ok: true, value: "again" })).toBe(false);
        expect(await a).toBe("A");
        expect(await b).toBe("B");
    });

    it("non-JSON arguments throw at the caller; non-JSON results reject", async () => {
        const sent: RpcCall[] = [];
        const page = new RpcClient((c) => sent.push(c)).remote("onPage:0");
        expect(() => page.f(() => 1)).toThrow(TypeError);
        expect(() => page.f(new Map())).toThrow(/JSON/);
        expect(() => page.f(1n)).toThrow(/JSON/);
        expect(() => page.f("x".repeat(1024 * 1024 + 1))).toThrow(/1 MB/);
        expect(sent).toHaveLength(0);
        // undefined arguments travel as null
        void page.f(undefined, 1);
        expect(sent[0].args).toEqual([null, 1]);
        const p = runPage(`tt.onPage("*", () => ({ el: () => ({ fn() {} }), big: () => "x".repeat(1024 * 1024 + 1), none: () => undefined }));`);
        p.fire();
        const h = link(p.exposer).client.remote("onPage:0");
        await expect(h.el()).rejects.toThrow(/must be JSON/);
        await expect(h.big()).rejects.toThrow(/1 MB/);
        expect(await h.none()).toBeUndefined();
    });

    it("handles aren't thenables and can't be written", async () => {
        const h = new RpcClient(() => {}).remote("onPage:0");
        expect(h.then).toBeUndefined();
        expect(await Promise.resolve(h)).toBe(h);
        expect(Reflect.set(h, "x", 1)).toBe(false);
    });

    it("validates what crosses (anything can arrive over postMessage)", () => {
        expect(isRpcCall({ cid: "1", h: "onPage:0", fn: "f", args: [] })).toBe(true);
        expect(isRpcCall({ cid: "1", h: "onPage:0", fn: "f", args: "x" })).toBe(false);
        expect(isRpcResult({ cid: "1", ok: false })).toBe(false);
        expect(isRpcResult({ cid: "1", ok: false, error: { message: "m" } })).toBe(true);
        expect(isRpcResult({ cid: "1", ok: true, value: "x".repeat(2 * 1024 * 1024) })).toBe(false);
    });

    it("a reloaded script's queued calls wait for its handles to register again", async () => {
        const ex = new Exposer();
        ex.register("onPage:0");
        const replies: RpcResult[] = [];
        ex.answer({ cid: "1", h: "onPage:0", fn: "f", args: [] }, (r) => replies.push(r));
        ex.reset();
        expect(replies).toEqual([]);
        // before the recompiled script registered: this one waits too
        ex.answer({ cid: "2", h: "onPage:0", fn: "f", args: [] }, (r) => replies.push(r));
        ex.register("onPage:0");
        ex.done();
        ex.expose("onPage:0", { f: () => "new" });
        await tick();
        expect(replies).toEqual([
            { cid: "1", ok: true, value: "new" },
            { cid: "2", ok: true, value: "new" },
        ]);
    });
});

describe("rpc: which place may call which handle", () => {
    it("onSite code calling any handle throws SiteCannotCallError right there", () => {
        const p = runPage(`module.exports.overlay = tt.onOverlay("*", () => ({ picked() {} }));\nmodule.exports.page = tt.onPage("*", () => ({ f() {} }));`, { world: "page" });
        expect(() => p.exports.overlay.picked("a")).toThrow(SiteCannotCallError);
        expect(() => p.exports.page.f()).toThrow(SiteCannotCallError);
    });

    it("onPage code calls its onSite handlers' functions, even before they fired", async () => {
        const src = `tt.onPage("*", () => ({ own() {} }));\nmodule.exports.site = tt.onSite("*", async () => ({ flags: (x) => ({ x, ok: true }) }));`;
        const site = runPage(src, { world: "page" });
        const { client } = link(site.exposer);
        const asked: string[] = [];
        const iso = runPage(src, { world: "isolated", call: (api, key) => (asked.push(`${api}/${key}`), api === "onSite" ? client.remote(key) : inertRemote("elsewhere")) });
        // document_start: the call waits for the site handler's answer
        const early = iso.exports.site.flags(1);
        site.fire();
        expect(await early).toEqual({ x: 1, ok: true });
        expect(asked).toEqual(["onPage/onPage:0", "onSite/onSite:0"]);
    });

    it("arguments and results cross as plain JSON copies (a store's Proxy can be posted)", async () => {
        const ex = new Exposer();
        ex.register("onSite:0");
        ex.done();
        const store = new Proxy({ a: 1 }, {});
        ex.expose("onSite:0", { echo: (x: any) => ({ x, store }) });
        const calls: RpcCall[] = [];
        const results: RpcResult[] = [];
        const client: RpcClient = new RpcClient((call) => {
            calls.push(call);
            ex.answer(structuredClone(call), (r) => (results.push(r), client.receive(structuredClone(r))));
        });
        expect(await client.remote("onSite:0").echo(store)).toEqual({ x: { a: 1 }, store: { a: 1 } });
        expect(() => structuredClone(calls[0].args)).not.toThrow();
        expect(() => structuredClone(results[0])).not.toThrow();
    });

    it("onPage code calls its overlay's handles by key", async () => {
        const overlay = new Exposer();
        overlay.register("onOverlay:0");
        overlay.register("onOverlay:1");
        overlay.done();
        overlay.expose("onOverlay:0", { first: () => 0 });
        overlay.expose("onOverlay:1", { picked: (t: string) => `picked ${t}` });
        const { client } = link(overlay);
        const p = runPage(`tt.onOverlay("*", () => {});\ntt.onPage("*", () => {});\nmodule.exports.overlay = tt.onOverlay("*", () => {});`, { world: "isolated", call: (api, key) => (api === "onOverlay" ? client.remote(key) : inertRemote("elsewhere")) });
        expect(await p.exports.overlay.picked("DIV")).toBe("picked DIV");
    });

    it("the overlay names handles by their route keys", () => {
        const handles: string[] = [];
        const c = compileScript(`tt.onPage("*", () => {});\nconst page = tt.onPage("*", () => ({}));\ntt.onSite("*", () => {});\ntt.onOverlay("*", () => {});`, {
            remote: (r: any) => (handles.push(r.key), {}),
        } as any);
        expect(c.error).toBeNull();
        expect(handles).toEqual(["onPage:0", "onPage:1", "onSite:0", "onOverlay:0"]);
    });
});

describe("firePageHandler", () => {
    it("an async handler's rejection reaches onError (a sync throw is rethrown)", async () => {
        const exposer = new Exposer();
        const shim = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined }, world: "isolated", exposer });
        new Function("tt", `tt.onPage("*://x.com/*", async () => { throw new Error("later"); }); tt.onPage("*://x.com/*", () => { throw new Error("now"); });`)(shim.tt);
        const [later, now] = domHandlersFor(shim.dom, "https://x.com/a", exposer);
        exposer.done();
        const errors: string[] = [];
        firePageHandler(later, { url: "https://x.com/a" }, exposer, (e: any) => errors.push(e.message));
        expect(() => firePageHandler(now, { url: "https://x.com/a" }, exposer, (e: any) => errors.push(e.message))).toThrow("now");
        await tick();
        expect(errors).toEqual(["later"]);
    });
});
