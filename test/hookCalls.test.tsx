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
    const call = (s: string, cid: string) => post({ kind: "rpc.call", s, call: { cid, h: "onSite:~0", fn: "ping", args: [] } });
    const script = { scriptId: "s1", name: "one", src: `wt.onSite("*://*/*", () => ({ ping: () => "pong" }));` };
    let results: any[];
    // replies as they're posted (happy-dom delivers messages on a real timer); each test
    // loads another hook and the earlier ones still listen: keep each call's first answer
    const record = (data: any) => data?.kind === "rpc.result" && !results.some((r) => r.cid === data.result.cid) && results.push(data.result);
    beforeEach(() => {
        w.happyDOM.setURL("https://x.test/");
        results = [];
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

    it("waits for the hot update that adds it (its onPage code can run first)", async () => {
        await loadHook();
        post({ kind: "status", active: false, domHandlers: [] });
        call("s1", "c1");
        await new Promise((r) => setTimeout(r, 20));
        expect(results).toEqual([]);
        post({ kind: "status", active: true, domHandlers: [script], hot: true });
        await vi.waitFor(() => expect(results).toEqual([{ cid: "c1", ok: true, value: "pong" }]));
    });

    it("answers `not running` after 3s without it; later calls fail at once until the next status", async () => {
        vi.useFakeTimers();
        await loadHook();
        post({ kind: "status", active: true, domHandlers: [] });
        call("s2", "c1");
        await vi.advanceTimersByTimeAsync(2900);
        expect(results).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        expect(results).toEqual([{ cid: "c1", ok: false, error: { name: "WtCallError", message: "not running on this page" } }]);
        call("s2", "c2");
        await vi.advanceTimersByTimeAsync(0);
        expect(results.map((r) => r.cid)).toEqual(["c1", "c2"]);
        // a status that still lacks it doesn't answer a waiting call early
        post({ kind: "status", active: true, domHandlers: [] });
        call("s2", "c3");
        post({ kind: "status", active: true, domHandlers: [] });
        await vi.advanceTimersByTimeAsync(100);
        expect(results.map((r) => r.cid)).toEqual(["c1", "c2"]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(results.map((r) => r.cid)).toEqual(["c1", "c2", "c3"]);
    });
});
