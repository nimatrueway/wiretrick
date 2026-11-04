import { describe, it, expect, vi, beforeEach } from "vitest";
import { addBridgePort, bridgeLinks, pushBundleUpdate, onBridgeConnect } from "../src/background/engine/bridgePorts";
import { packBytes } from "../src/shared/bytesPack";

function fakePort(name: string, sender: any) {
    const msgL: ((m: any) => void)[] = [];
    const discL: (() => void)[] = [];
    const port: any = {
        name,
        sender,
        sent: [] as any[],
        disconnected: false,
        postMessage: (m: any) => port.sent.push(m),
        disconnect: () => (port.disconnected = true),
        onMessage: { addListener: (f: any) => msgL.push(f) },
        onDisconnect: { addListener: (f: any) => discL.push(f) },
        drop: () => discL.forEach((f) => f()),
    };
    return port;
}

describe("L2 wt-bridge ports", () => {
    beforeEach(() => {
        vi.stubGlobal("chrome", { runtime: { id: "ext" } });
        for (const l of bridgeLinks()) l.ep.close();
    });

    it("ignores other ports and refuses a sender without a tab", () => {
        expect(addBridgePort(fakePort("logs", {}))).toBe(false);
        const p = fakePort("wt-bridge", { id: "ext", frameId: 0 });
        expect(addBridgePort(p)).toBe(true);
        expect(p.disconnected).toBe(true);
        expect(bridgeLinks()).toHaveLength(0);
    });

    it("registers by tab and frame, replaces a frame's old port, forgets a dropped one", () => {
        const seen: number[] = [];
        onBridgeConnect((l) => seen.push(l.tabId));
        const a = fakePort("wt-bridge", { id: "ext", tab: { id: 5 }, frameId: 0 });
        const b = fakePort("wt-bridge", { id: "ext", tab: { id: 5 }, frameId: 3 });
        addBridgePort(a);
        addBridgePort(b);
        expect(bridgeLinks(5).map((l) => l.frameId).sort()).toEqual([0, 3]);
        const a2 = fakePort("wt-bridge", { id: "ext", tab: { id: 5 }, frameId: 0 });
        addBridgePort(a2);
        expect(a.disconnected).toBe(true);
        expect(bridgeLinks(5)).toHaveLength(2);
        b.drop();
        expect(bridgeLinks(5).map((l) => l.frameId)).toEqual([0]);
        expect(seen).toEqual([5, 5, 5]);
    });

    it("pushes bundle.update to every open bridge", () => {
        vi.useFakeTimers();
        const p = fakePort("wt-bridge", { id: "ext", tab: { id: 9 }, frameId: 0 });
        addBridgePort(p);
        expect(pushBundleUpdate([{ s: "s1", codeHash: "h" }])).toBe(1);
        vi.advanceTimersByTime(20); // pushes are batched
        vi.useRealTimers();
        expect(p.sent).toEqual([packBytes({ v: 1, t: "push", op: "bundle.update", a: { scripts: [{ s: "s1", codeHash: "h" }] } })]);
    });
});
