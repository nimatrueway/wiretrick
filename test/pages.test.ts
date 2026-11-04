import { describe, it, expect } from "vitest";
import { PageRegistry } from "../src/background/engine/pages";

describe("page registry", () => {
    it("a navigation request belongs to the page it leaves", () => {
        const r = new PageRegistry();
        const first = r.current(7)!;
        r.navStart(7, "n1");
        const next = r.committed(7, "docB");
        expect(next).not.toBe(first);
        // the old page ended when the new document committed
        expect(r.forRequest({ tabId: 7, type: "main_frame", requestId: "n1" })).toBeNull();
        r.navEnd("n1");
        expect(r.forRequest({ tabId: 7, type: "main_frame", requestId: "n2" })).toBe(next);
    });

    it("a navigation request still in flight keeps its page while the page lives", () => {
        const r = new PageRegistry();
        const first = r.current(3)!;
        r.navStart(3, "n1");
        expect(r.forRequest({ tabId: 3, type: "main_frame", requestId: "n1" })).toBe(first);
    });

    it("commits once per document (bridge first, then onCommitted)", () => {
        const r = new PageRegistry();
        const ended: string[] = [];
        r.onEnd((k) => ended.push(k));
        r.bridgeConnected(1, "docA");
        const a = r.current(1)!;
        expect(r.committed(1, "docA")).toBe(a);
        expect(r.forRequest({ tabId: 1, frameId: 0, documentId: "docA" })).toBe(a);
        expect(ended).toEqual([]);
        const b = r.committed(1, "docB");
        expect(ended).toEqual([a]);
        expect(r.isAlive(a)).toBe(false);
        expect(r.isAlive(b)).toBe(true);
    });

    it("an old document's request (an unload beacon) has no page; an unseen active one starts its page", () => {
        const r = new PageRegistry();
        const b = r.committed(1, "docB");
        expect(r.forRequest({ tabId: 1, frameId: 0, documentId: "docA", documentLifecycle: "pending_deletion" })).toBeNull();
        expect(r.current(1)).toBe(b);
        const c = r.forRequest({ tabId: 1, frameId: 0, documentId: "docC", documentLifecycle: "active" });
        expect(c).not.toBe(b);
        expect(r.current(1)).toBe(c);
    });

    it("tabs are separate; closing one ends its page", () => {
        const r = new PageRegistry();
        const ended: [string, number][] = [];
        r.onEnd((k, t) => ended.push([k, t]));
        const a = r.current(1)!;
        const b = r.current(2)!;
        expect(a).not.toBe(b);
        expect(r.tabOf(b)).toBe(2);
        r.tabClosed(2);
        expect(ended).toEqual([[b, 2]]);
        expect(r.tabs()).toEqual(new Map([[1, a]]));
        expect(r.forRequest({ tabId: -1 })).toBeNull();
    });

    it("MV2: a top-frame response starts a page", () => {
        const r = new PageRegistry();
        const a = r.current(4)!;
        r.responseStarted(4);
        expect(r.current(4)).not.toBe(a);
        expect(r.isAlive(a)).toBe(false);
    });

    it("virtual pages (the Editor preview) live until ended; restore keeps saved tabs", () => {
        let saved: any;
        const r = new PageRegistry({ save: (m) => (saved = m) });
        const v = r.openVirtual();
        expect(r.isAlive(v)).toBe(true);
        r.endVirtual(v);
        expect(r.isAlive(v)).toBe(false);
        const a = r.committed(5, "d5");
        const again = new PageRegistry();
        again.restore(saved);
        expect(again.isAlive(a)).toBe(true);
        expect(again.committed(5, "d5")).toBe(a);
    });
});
