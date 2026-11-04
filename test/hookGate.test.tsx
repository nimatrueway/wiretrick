// happy-dom (.tsx): the page hook patches window.fetch/XMLHttpRequest
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const w = window as any;
const native = vi.fn(async () => new Response("REAL"));
const status = (active: boolean) =>
    window.dispatchEvent(new MessageEvent("message", { data: { source: "res-override-bridge", kind: "status", active, routes: active ? [{ kind: "onResponseBody", url: "*://*/*", index: 0 }] : [] } }));

async function loadHook() {
    vi.resetModules();
    delete w.__resOverrideHooked;
    w.fetch = native;
    await import("../src/hook/hook");
}

describe("page hook: the first status", () => {
    beforeEach(() => native.mockClear());
    afterEach(() => vi.useRealTimers());

    it("fetch is patched from the start and waits for the status", async () => {
        await loadHook();
        expect(window.fetch).not.toBe(native);
        let done = false;
        const p = window.fetch("http://x.test/a").then(() => (done = true));
        await new Promise((r) => setTimeout(r, 20));
        expect(done).toBe(false);
        expect(native).not.toHaveBeenCalled();
        status(false);
        await p;
        expect(native).toHaveBeenCalledTimes(1);
    });

    it("an inactive first status restores the page's own fetch/XHR", async () => {
        const send = XMLHttpRequest.prototype.send;
        await loadHook();
        expect(XMLHttpRequest.prototype.send).not.toBe(send);
        status(false);
        expect(window.fetch).toBe(native);
        expect(XMLHttpRequest.prototype.send).toBe(send);
    });

    it("an active first status keeps the patches", async () => {
        await loadHook();
        status(true);
        expect(window.fetch).not.toBe(native);
        status(false); // later: the scripts went away
    });

    it("no status within 3s: waiting requests go out unmodified", async () => {
        vi.useFakeTimers();
        await loadHook();
        const p = window.fetch("http://x.test/a");
        await vi.advanceTimersByTimeAsync(3000);
        await p;
        expect(native).toHaveBeenCalledTimes(1);
        status(false);
    });

    it("an XHR waits for the status; one aborted meanwhile is never sent", async () => {
        const orig = XMLHttpRequest.prototype.send;
        const sent = vi.fn();
        XMLHttpRequest.prototype.send = sent;
        try {
            await loadHook();
            const kept = new XMLHttpRequest();
            kept.open("GET", "http://x.test/kept");
            kept.send();
            const dropped = new XMLHttpRequest();
            dropped.open("GET", "http://x.test/dropped");
            dropped.send();
            dropped.abort();
            expect(sent).not.toHaveBeenCalled();
            status(false);
            await new Promise((r) => setTimeout(r, 0));
            expect(sent).toHaveBeenCalledTimes(1);
            expect(sent.mock.contexts[0]).toBe(kept);
        } finally {
            XMLHttpRequest.prototype.send = orig;
        }
    });
});
