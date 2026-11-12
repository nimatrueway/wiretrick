import { describe, it, expect, vi } from "vitest";
import { Endpoint, endpointPair, portEndpoint, type WireMessage } from "../src/shared/wire";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("wire Endpoint", () => {
    it("answers requests and delivers pushes", async () => {
        const [a, b] = endpointPair();
        b.handle("bypass.add", (x) => {
            expect(x).toEqual({ tabId: 1, method: "GET", url: "https://x/" });
            return {};
        });
        const seen: any[] = [];
        b.on("bundle.update", (x, s) => seen.push([x, s]));
        await expect(a.call("bypass.add", { tabId: 1, method: "GET", url: "https://x/" })).resolves.toEqual({});
        a.push("bundle.update", { scripts: [{ s: "s1", codeHash: "h" }] }, "s1");
        await tick();
        expect(seen).toEqual([[{ scripts: [{ s: "s1", codeHash: "h" }] }, "s1"]]);
    });

    it("passes a handler's error back to the caller", async () => {
        const [a, b] = endpointPair();
        b.handle("store.init", () => {
            const e = new Error("nope");
            e.name = "QuotaError";
            throw e;
        });
        await expect(a.call("store.init", { scripts: [] })).rejects.toMatchObject({ name: "QuotaError", message: "nope" });
        b.handle("store.init", async () => Promise.reject(new Error("async nope")));
        await expect(a.call("store.init", { scripts: [] })).rejects.toThrow("async nope");
    });

    it("answers an unknown op with an error, ignores an unknown push", async () => {
        const [a, b] = endpointPair();
        const debug = vi.fn();
        (b as any).opts.debug = debug;
        await expect(a.call("store.init", { scripts: [] })).rejects.toMatchObject({ name: "UnknownOpError" });
        a.push("bundle.update", { scripts: [] });
        await tick();
        expect(debug).toHaveBeenCalledWith(expect.stringContaining("bundle.update"));
    });

    it("times out a call", async () => {
        vi.useFakeTimers();
        try {
            const ep = new Endpoint(() => {}, { timeoutMs: 1000 });
            const p = ep.call("store.init", { scripts: [] });
            vi.advanceTimersByTime(1001);
            await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects pending calls when closed, and closes the pair", async () => {
        const [a, b] = endpointPair();
        b.handle("store.init", () => new Promise(() => {}));
        const p = a.call("store.init", { scripts: [] });
        await tick();
        b.close("gone");
        await expect(p).rejects.toMatchObject({ name: "DisconnectedError", message: "gone" });
        expect(a.closed).toBe(true);
        await expect(a.call("store.init", { scripts: [] })).rejects.toMatchObject({ name: "DisconnectedError" });
    });

    it("refuses a newer protocol version", async () => {
        const sent: WireMessage[] = [];
        const ep = new Endpoint((m) => sent.push(m));
        ep.handle("store.init", () => ({}));
        ep.receive({ v: 2, t: "req", id: 7, op: "store.init", a: {} });
        expect(sent).toEqual([{ v: 1, t: "res", id: 7, ok: false, e: { name: "VersionError", message: "unsupported protocol version 2" } }]);
    });

    it("batches pushes and receives batches", async () => {
        vi.useFakeTimers();
        try {
            const sent: WireMessage[] = [];
            const ep = new Endpoint((m) => sent.push(m), { batchMs: 16 });
            ep.push("bundle.update", { scripts: [] });
            ep.push("bundle.update", { scripts: [] });
            expect(sent).toEqual([]);
            vi.advanceTimersByTime(16);
            expect(sent).toHaveLength(1);
            expect(Array.isArray(sent[0])).toBe(true);
            const got: unknown[] = [];
            const rx = new Endpoint(() => {});
            rx.on("bundle.update", (a) => got.push(a));
            rx.receive(sent[0]);
            expect(got).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("packs bytes over a chrome.runtime port", async () => {
        const listeners: ((m: any) => void)[] = [];
        const posted: any[] = [];
        const port: any = {
            postMessage: (m: any) => posted.push(m),
            onMessage: { addListener: (f: any) => listeners.push(f) },
            onDisconnect: { addListener: () => {} },
        };
        const ep = portEndpoint(port);
        ep.handle("fetch", (a) => ({ status: 200, statusText: "OK", url: a.request.url, headers: [], body: new Uint8Array([1, 2, 3]) }));
        listeners[0]({ v: 1, t: "req", id: 1, op: "fetch", a: { request: { url: "u", method: "GET", headers: [], body: { __ttBytes: "AQI=" } }, bypass: false } });
        await tick();
        expect(posted[0].r.body).toEqual({ __ttBytes: "AQID" });
    });
});
