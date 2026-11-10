// happy-dom (.tsx): onPage code calls its script's onSite handles through the page hook
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const w = window as any;

async function loadHook() {
    vi.resetModules();
    delete w.__resOverrideHooked;
    await import("../src/hook/hook");
}

describe("page hook: calls into a script it doesn't run yet", () => {
    const post = (data: any) => window.dispatchEvent(new MessageEvent("message", { data: { source: "res-override-bridge", ...data } }));
    // the hooks earlier tests loaded still listen: each test uses its own script ids
    let n = 0;
    let s1 = "";
    let s2 = "";
    let script: { scriptId: string; name: string; src: string };
    let results: any[];
    // replies as they're posted (happy-dom delivers messages on a real timer); each test
    // loads another hook and the earlier ones still listen: keep each call's first answer
    const record = (data: any) => data?.kind === "rpc.result" && !results.some((r) => r.cid === data.result.cid) && results.push(data.result);
    beforeEach(() => {
        w.happyDOM.setURL("https://x.test/");
        results = [];
        n++;
        s1 = `s1-${n}`;
        s2 = `s2-${n}`;
        script = { scriptId: s1, name: "one", src: `wt.onSite("*://*/*", () => ({ ping: () => "pong" }));` };
        const postMessage = window.postMessage.bind(window);
        vi.spyOn(window, "postMessage").mockImplementation((data: any, ...rest: any[]) => {
            record(data);
            postMessage(data, ...(rest as [string]));
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    const callV = (s: string, cid: string, v?: string, fn = "ping") => post({ kind: "rpc.call", s, v, call: { cid, h: "onSite:~0", fn, args: [] } });
    const NOT_RUNNING = { name: "WtCallError", message: "not running on this page" };

    it("a call for a version the hook hasn't compiled waits for the hot update that brings it", async () => {
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [{ ...script, v: "v1" }] });
        callV(s1, "c1", "v2");
        await new Promise((r) => setTimeout(r, 20));
        expect(results).toEqual([]);
        post({ kind: "status", active: true, domHandlers: [{ ...script, v: "v2" }], hot: true });
        await vi.waitFor(() => expect(results).toEqual([{ cid: "c1", ok: true, value: "pong" }]));
    });

    it("waits when the script isn't here at all yet (a save made this page match)", async () => {
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [] });
        callV(s1, "c1", "v1");
        await new Promise((r) => setTimeout(r, 20));
        expect(results).toEqual([]);
        post({ kind: "status", active: true, domHandlers: [{ ...script, v: "v1" }], hot: true });
        await vi.waitFor(() => expect(results).toEqual([{ cid: "c1", ok: true, value: "pong" }]));
    });

    it("a call without a version (its onSite route doesn't match here) fails at once", async () => {
        vi.useFakeTimers();
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [] });
        callV(s2, "c1");
        await vi.advanceTimersByTimeAsync(0);
        expect(results).toEqual([{ cid: "c1", ok: false, error: NOT_RUNNING }]);
    });

    it("a version the hook already compiled answers from what it has, at once", async () => {
        vi.useFakeTimers();
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [{ ...script, src: "/* no onSite registered */", v: "v1" }] });
        await vi.advanceTimersByTimeAsync(0);
        callV(s1, "c1", "v1");
        await vi.advanceTimersByTimeAsync(0);
        expect(results).toEqual([{ cid: "c1", ok: false, error: NOT_RUNNING }]);
    });

    it("gives up after 5s when that version never arrives; a status without it doesn't answer early", async () => {
        vi.useFakeTimers();
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [] });
        callV(s2, "c1", "v9");
        await vi.advanceTimersByTimeAsync(100);
        post({ kind: "status", active: true, domHandlers: [] });
        await vi.advanceTimersByTimeAsync(4800);
        expect(results).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        expect(results).toEqual([{ cid: "c1", ok: false, error: NOT_RUNNING }]);
    });

    it("the caller giving up ends a waiting call", async () => {
        vi.useFakeTimers();
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [] });
        callV(s2, "c1", "v9");
        callV(s2, "c1", "v9", "\u0000cancel");
        await vi.advanceTimersByTimeAsync(0);
        expect(results).toEqual([{ cid: "c1", ok: false, error: { name: "AbortError", message: "the caller gave up" } }]);
        await vi.advanceTimersByTimeAsync(6000);
        expect(results).toHaveLength(1);
    });
});
