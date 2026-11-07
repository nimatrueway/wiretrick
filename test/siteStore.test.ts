import { describe, it, expect, vi } from "vitest";
import { subscribe } from "valtio/vanilla";
import { SiteStoreHost, type SiteDown, type SiteUp } from "../src/shared/siteStoreHost";
import { SiteMirrors, SITE_CONNECT_WARN_MS } from "../src/shared/siteStoreMirror";

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** a host and mirrors over an async "window": every message is seen by every side, like postMessage */
function world(opts: { hostUp?: boolean } = {}) {
    const ups: SiteUp[] = [];
    const downs: SiteDown[] = [];
    const listeners: ((m: SiteDown) => void)[] = [];
    let host: SiteStoreHost | null = null;
    const toHost = (m: SiteUp) => {
        ups.push(m);
        setTimeout(() => host?.receive(structuredClone(m)), 0);
    };
    const toMirrors = (m: SiteDown) => {
        downs.push(m);
        const c = structuredClone(m);
        setTimeout(() => listeners.forEach((l) => l(c)), 0);
    };
    const start = () => {
        host = new SiteStoreHost({ post: toMirrors, log: vi.fn() });
        host.ready();
        return host;
    };
    if (opts.hostUp !== false) start();
    const mirrors = (ctx = "iso") => {
        const log = vi.fn();
        const m = new SiteMirrors({ ctx, post: toHost, log });
        listeners.push((d) => m.receive(d));
        return Object.assign(m, { log });
    };
    return { ups, downs, mirrors, start, host: () => host!, forge: (m: SiteDown) => toMirrors(m) };
}

describe("wt.siteStore: host and mirrors", () => {
    it("seeds from initial, then takes the site's snapshot", async () => {
        const w = world();
        const site = w.host().store("s1", "login", { user: "ann", n: 1 }) as any;
        site.n = 2;
        const m = w.mirrors();
        const view = m.store("s1", "login", { user: "", n: 0, extra: true }) as any;
        expect(view).toMatchObject({ user: "", n: 0, extra: true });
        await settle();
        expect({ ...view }).toEqual({ user: "ann", n: 2, extra: true });
        // the newer initial's field was added in the site's world too
        expect(site.extra).toBe(true);
    });

    it("site writes reach mirrors; mirror writes reach the site and every mirror, without bouncing", async () => {
        const w = world();
        const site = w.host().store("s1", "st", { on: false, list: [] as number[] }) as any;
        const a = w.mirrors("a");
        const b = w.mirrors("b");
        const va = a.store("s1", "st", { on: false, list: [] }) as any;
        const vb = b.store("s1", "st", { on: false, list: [] }) as any;
        await settle();
        site.list.push(1, 2);
        await settle();
        expect(va.list).toEqual([1, 2]);
        const seen: any[] = [];
        subscribe(va, () => seen.push(va.on));
        va.on = true;
        expect(va.on).toBe(true); // optimistic
        await settle();
        expect(site.on).toBe(true);
        expect(vb.on).toBe(true);
        expect(va.on).toBe(true);
        expect(w.ups.filter((u) => u.kind === "site.set")).toHaveLength(1);
        va.list.length = 0;
        await settle();
        expect(site.list).toEqual([]);
        expect(vb.list).toEqual([]);
    });

    it("connects late (the site's world started after the mirror) and resends pending writes", async () => {
        const w = world({ hostUp: false });
        const m = w.mirrors();
        const view = m.store("s1", "st", { a: 1 }) as any;
        view.a = 5;
        await settle();
        expect(view.a).toBe(5);
        const host = w.start();
        await settle();
        expect((host.store("s1", "st", { a: 0 }) as any).a).toBe(5);
        expect(view.a).toBe(5);
    });

    it("a save reuses the mirror: one subscription per store", async () => {
        const w = world();
        const m = w.mirrors();
        const v1 = m.store("s1", "st", { a: 1 }) as any;
        await settle();
        v1.a = 7;
        await settle();
        for (let i = 0; i < 10; i++) expect(m.store("s1", "st", { a: 1, b: 2 })).toBe(v1);
        await settle();
        expect({ ...v1 }).toEqual({ a: 7, b: 2 });
        expect(new Set(w.ups.filter((u) => u.kind === "site.connect").map((u: any) => u.sub)).size).toBe(1);
    });

    it("ignores forged messages for unknown subscriptions and non-JSON values", async () => {
        const w = world();
        const m = w.mirrors();
        const view = m.store("s1", "st", { a: 1 }) as any;
        await settle();
        w.forge({ kind: "site.ops", sub: "page.1", ops: [["set", ["a"], 666]], acks: [] });
        w.forge({ kind: "site.snapshot", sub: "page.1", value: { a: 666 } });
        await settle();
        expect(view.a).toBe(1);
        const sub = (w.ups.find((u) => u.kind === "site.connect") as any).sub;
        m.receive({ kind: "site.ops", sub, ops: [["set", ["__proto__", "x"], 1], ["set", ["a"], { toJSON: () => 1, f: () => 1 } as any]], acks: [] });
        expect(view.a).toBe(1);
        expect(({} as any).x).toBeUndefined();
    });

    it("the host drops bad ops from a mirror (or the page)", async () => {
        const w = world();
        const site = w.host().store("s1", "st", { a: 1 }) as any;
        w.host().receive({ kind: "site.set", s: "s1", name: "st", op: "x:1", ops: [["set", ["__proto__", "p"], 1], ["set", ["b"], 2], ["set", ["c"], NaN]] });
        expect(site.b).toBe(2);
        expect("c" in site).toBe(false);
        expect(({} as any).p).toBeUndefined();
        // a resent op applies once
        site.b = 3;
        w.host().receive({ kind: "site.set", s: "s1", name: "st", op: "x:1", ops: [["set", ["b"], 2]] });
        expect(site.b).toBe(3);
    });

    it("onSite's local fields (methods) stay local; non-JSON site values warn once", async () => {
        const w = world();
        const log = vi.fn();
        const host = new SiteStoreHost({ post: () => {}, log });
        const site = host.store("s1", "st", { n: 1, inc(this: any) { this.n++; } }) as any;
        site.inc();
        expect(site.n).toBe(2);
        site.when = new Date();
        site.other = new Map();
        await settle();
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][1]).toMatch(/wt\.siteStore\("st"\): when: a Date isn't JSON/);
        void w;
    });

    it("says once when the site's world never answers", async () => {
        vi.useFakeTimers();
        try {
            const w = world({ hostUp: false });
            const m = w.mirrors();
            m.store("s1", "st", { a: 1 });
            vi.advanceTimersByTime(SITE_CONNECT_WARN_MS + 10);
            m.store("s1", "st", { a: 1 });
            vi.advanceTimersByTime(SITE_CONNECT_WARN_MS + 10);
            expect(m.log).toHaveBeenCalledTimes(1);
            expect(m.log.mock.calls[0][1]).toMatch(/hasn't answered/);
        } finally {
            vi.useRealTimers();
        }
    });

    it("retain disconnects mirrors of scripts that are gone", async () => {
        const w = world();
        const site = w.host().store("s1", "st", { a: 1 }) as any;
        const m = w.mirrors();
        const view = m.store("s1", "st", { a: 1 }) as any;
        await settle();
        m.retain([]);
        await settle();
        site.a = 9;
        await settle();
        expect(view.a).toBe(1);
        expect(w.downs.filter((d) => d.kind === "site.ops")).toHaveLength(0);
    });
});
