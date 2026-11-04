import { describe, it, expect, vi } from "vitest";
import { subscribe } from "valtio/vanilla";
import { Endpoint, endpointPair } from "../src/shared/wire";
import { ReplicaHub } from "../src/shared/storeReplica";
import { StoreOwner, type StoreOwnerDeps } from "../src/background/engine/storeOwner";
import { applyOps, missingOps } from "../src/shared/storeOps";
import "../src/shared/transpile";
import { compileScript } from "../src/shared/compile";

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function memDeps(over: Partial<StoreOwnerDeps> = {}) {
    const storage = new Map<string, Record<string, any>>();
    const session = new Map<string, any>();
    const deps: StoreOwnerDeps = {
        storageAll: async (s) => structuredClone(storage.get(s) ?? {}),
        storageSet: async (s, k, v) => {
            const o = storage.get(s) ?? {};
            if (v === undefined) delete o[k];
            else o[k] = structuredClone(v);
            storage.set(s, o);
        },
        sessionGet: async (k) => structuredClone(session.get(k)),
        sessionSet: async (k, v) => void session.set(k, structuredClone(v)),
        persistDelayMs: 1,
        sessionDelayMs: 1,
        ...over,
    };
    return { deps, storage, session };
}

function setup(over: Partial<StoreOwnerDeps> = {}) {
    const mem = memDeps(over);
    const owner = new StoreOwner(mem.deps);
    const logs: string[] = [];
    const hub = (ctx: string, all = true) => {
        const [a, b] = endpointPair();
        owner.attach(a, { all });
        const h = new ReplicaHub({ ctx, log: (_s, m) => logs.push(m) });
        h.attach(b);
        return { hub: h, ep: b, ownerEp: a };
    };
    return { ...mem, owner, hub, logs };
}

describe("store ops", () => {
    it("drops an op whose parent is gone", () => {
        const d: any = { a: { b: 1 } };
        expect(applyOps(d, [["set", ["x", "y"], 1], ["set", ["a", "c"], 2]])).toHaveLength(1);
        expect(d).toEqual({ a: { b: 1, c: 2 } });
    });
    it("never writes through __proto__", () => {
        const d: any = {};
        applyOps(d, [["set", ["__proto__", "polluted"], 1]]);
        expect(({} as any).polluted).toBeUndefined();
    });
    it("lists initial's missing keys, recursing into objects", () => {
        expect(missingOps({ a: { x: 1 }, b: [1] }, { a: { x: 2, y: 3 }, b: [9, 9], c: true })).toEqual([
            ["set", ["a", "y"], 3],
            ["set", ["c"], true],
        ]);
    });
});

describe("wt.store replica + owner", () => {
    it("syncs a set, a nested set and a delete to another context", async () => {
        const t = setup();
        const A = t.hub("a");
        const B = t.hub("b");
        const a = A.hub.store("s1", "st", { n: 0, o: { x: 1 } as any, gone: 1 as any });
        const b = B.hub.store("s1", "st", { n: 0, o: { x: 1 } as any, gone: 1 as any });
        await settle();
        a.n = 5;
        a.o.y = { z: [1, 2] };
        delete a.gone;
        await settle();
        expect(b).toEqual({ n: 5, o: { x: 1, y: { z: [1, 2] } } });
        expect(t.owner.get("s1", "st")!.data).toEqual({ n: 5, o: { x: 1, y: { z: [1, 2] } } });
    });

    it("replicates push, shift and splice", async () => {
        const t = setup();
        const A = t.hub("a");
        const B = t.hub("b");
        const a = A.hub.store("s1", "list", { items: [1, 2, 3, 4] });
        const b = B.hub.store("s1", "list", { items: [1, 2, 3, 4] });
        await settle();
        a.items.push(5);
        a.items.shift();
        a.items.splice(1, 2, 9);
        await settle();
        expect(a.items).toEqual([2, 9, 5]);
        expect(b.items).toEqual([2, 9, 5]);
    });

    it("keeps functions and getters local", async () => {
        const t = setup();
        const A = t.hub("a");
        const a = A.hub.store("s1", "c", {
            n: 1,
            inc() {
                this.n++;
            },
            get double() {
                return this.n * 2;
            },
        });
        await settle();
        a.inc();
        await settle();
        expect(a.n).toBe(2);
        expect(a.double).toBe(4);
        expect(t.owner.get("s1", "c")!.data).toEqual({ n: 2 });
    });

    it("reverts and logs a non-JSON value", async () => {
        const t = setup();
        const A = t.hub("a");
        const a = A.hub.store("s1", "x", { when: null as any, m: 1 });
        await settle();
        a.when = new Date();
        a.m = 2;
        await settle();
        expect(a.when).toBe(null);
        expect(a.m).toBe(1);
        expect(t.logs.join("\n")).toMatch(/when: a Date isn't JSON — the change was reverted/);
        a.when = new Map() as any;
        await settle();
        expect(a.when).toBe(null);
    });

    it("throws for a non-JSON initial", () => {
        const t = setup();
        expect(() => t.hub("a").hub.store("s1", "x", { m: new Map() })).toThrow(/initial\.m: a Map isn't JSON/);
    });

    it("reverts a change that makes the store too large", async () => {
        const t = setup();
        const A = t.hub("a");
        const a = A.hub.store("s1", "big", { s: "" });
        await settle();
        a.s = "x".repeat(1024 * 1024 + 1);
        await settle();
        expect(a.s).toBe("");
        expect(t.logs.join()).toMatch(/over 1 MB/);
    });

    it("sends one store.set per microtask and doesn't echo patches", async () => {
        const t = setup();
        const A = t.hub("a");
        const sets: any[] = [];
        t.owner.attach(new Endpoint(() => {}), { all: true });
        const orig = A.ep.push.bind(A.ep);
        A.ep.push = ((op: any, a: any, s: any) => {
            if (op === "store.set") sets.push(a);
            return orig(op, a, s);
        }) as any;
        const a = A.hub.store("s1", "n", { a: 0, b: 0 });
        await settle();
        a.a = 1;
        a.b = 2;
        await settle();
        expect(sets).toHaveLength(1);
        expect(sets[0].ops).toEqual([
            ["set", ["a"], 1],
            ["set", ["b"], 2],
        ]);
        expect(a).toEqual({ a: 1, b: 2 });
        // the owner's patch for that change didn't come back as another set
        await settle();
        expect(sets).toHaveLength(1);
    });

    it("merges initial into persisted data and keeps existing values", async () => {
        const t = setup();
        await t.deps.storageSet("s1", "$store:cfg", { theme: "dark" });
        const A = t.hub("a");
        A.hub.prime(await t.owner.init(["s1"]));
        const a = A.hub.store("s1", "cfg", { theme: "light", size: 3 });
        expect(a).toEqual({ theme: "dark", size: 3 });
        await settle();
        expect(t.owner.get("s1", "cfg")!.data).toEqual({ theme: "dark", size: 3 });
    });

    it("returns the same proxy when the script recompiles, with new fields added", async () => {
        const t = setup();
        const A = t.hub("a");
        const a1 = A.hub.store("s1", "x", { n: 1 });
        await settle();
        a1.n = 7;
        await settle();
        const a2 = A.hub.store("s1", "x", { n: 1, added: "yes" });
        expect(a2).toBe(a1);
        expect(a2).toEqual({ n: 7, added: "yes" });
        await settle();
        expect(t.owner.get("s1", "x")!.data).toEqual({ n: 7, added: "yes" });
    });

    it("persists all, some or none of the fields", async () => {
        const t = setup();
        const A = t.hub("a");
        const all = A.hub.store("s1", "all", { a: 1, b: 2 });
        const some = A.hub.store("s1", "some", { a: 1, b: 2 }, ["b"]);
        const none = A.hub.store("s1", "none", { a: 1 }, false);
        await settle();
        all.a = 10;
        some.a = 10;
        some.b = 20;
        none.a = 10;
        await settle();
        await t.owner.flush();
        const saved = await t.deps.storageAll("s1");
        expect(saved["$store:all"]).toEqual({ a: 10, b: 2 });
        expect(saved["$store:some"]).toEqual({ b: 20 });
        expect("$store:none" in saved).toBe(false);
    });

    it("rehydrates from the session copy at the same rev (service-worker restart)", async () => {
        const t = setup();
        const A = t.hub("a");
        const a = A.hub.store("s1", "x", { n: 0 });
        await settle();
        a.n = 3;
        await settle();
        await t.owner.flush();
        const rev = t.owner.get("s1", "x")!.rev;
        // the service worker restarts: a fresh owner over the same storage
        const owner2 = new StoreOwner(t.deps);
        const snap = await owner2.init(["s1"]);
        expect(snap.s1.x).toEqual({ rev, data: { n: 3 } });
        // the sandbox survived: it reconnects and keeps its proxy
        const [o, r] = endpointPair();
        owner2.attach(o, { all: true });
        A.hub.attach(r);
        await settle();
        a.n = 4;
        await settle();
        expect(owner2.get("s1", "x")!.data).toEqual({ n: 4 });
    });

    it("re-sends changes the owner lost when it restarted", async () => {
        const t = setup({ sessionGet: undefined, sessionSet: undefined });
        const A = t.hub("a");
        const a = A.hub.store("s1", "x", { n: 0 });
        await settle();
        // the link drops: the change can't reach the owner
        A.ep.close();
        a.n = 9;
        await settle();
        const owner2 = new StoreOwner(t.deps);
        const [o, r] = endpointPair();
        owner2.attach(o, { all: true });
        A.hub.attach(r);
        await settle();
        expect(owner2.get("s1", "x")!.data).toEqual({ n: 9 });
        expect(a.n).toBe(9);
    });

    it("re-syncs after a missed patch", async () => {
        const t = setup();
        const A = t.hub("a");
        const B = t.hub("b");
        const a = A.hub.store("s1", "x", { n: 0 });
        const b = B.hub.store("s1", "x", { n: 0 });
        await settle();
        // drop B's next incoming patch
        const recv = B.ep.receive.bind(B.ep);
        let dropped = 0;
        B.ep.receive = ((m: any) => {
            if (!dropped && m?.op === "store.patch") return void dropped++;
            recv(m);
        }) as any;
        a.n = 1;
        await settle();
        expect(b.n).toBe(0);
        a.n = 2;
        await settle();
        expect(dropped).toBe(1);
        expect(b.n).toBe(2);
    });

    it("reverts a rejected change and logs it", async () => {
        const t = setup();
        const A = t.hub("a");
        const a = A.hub.store("s1", "x", { n: 0 });
        await settle();
        // the owner refuses everything for this test
        (t.owner as any).set = function (from: Endpoint, s: string, name: string, op: string) {
            from.push("store.reject", { name, op, reason: "quota" }, s);
        };
        a.n = 1;
        expect(a.n).toBe(1);
        await settle();
        expect(a.n).toBe(0);
        expect(t.logs.join()).toMatch(/rejected \(quota\)/);
    });

    it("rejects forbidden paths at the owner", async () => {
        const t = setup();
        const sent: any[] = [];
        const ep = new Endpoint((m) => sent.push(m));
        t.owner.attach(ep, { all: false });
        ep.receive({ v: 1, t: "push", op: "store.set", s: "s1", a: { name: "x", op: "o1", ops: [["set", ["__proto__", "p"], 1]] } });
        await settle();
        expect(sent.find((m) => m.op === "store.reject")?.a.reason).toMatch(/forbidden key/);
    });

    it("patches a subscribed non-broadcast peer only for stores it subscribed to", async () => {
        const t = setup();
        const A = t.hub("a");
        const L2 = t.hub("l2", false);
        const a = A.hub.store("s1", "x", { n: 0 });
        A.hub.store("s1", "y", { n: 0 });
        await settle();
        const got: string[] = [];
        L2.ep.on("store.patch", (p) => got.push(p.name));
        await L2.ep.call("store.sub", { name: "x" }, "s1");
        a.n = 1;
        await settle();
        expect(got).toEqual(["x"]);
    });

    it("tells onChange about owner changes", async () => {
        const t = setup();
        const fn = vi.fn();
        t.owner.onChange(fn);
        const a = t.hub("a").hub.store("s1", "x", { n: 0 });
        await settle();
        a.n = 1;
        await settle();
        expect(fn).toHaveBeenCalledWith("s1", "x");
    });
});

describe("wt.store across compiled instances", () => {
    it("two compiles of a script (MV2 strategy tiers) share one store object", async () => {
        const t = setup();
        const A = t.hub("bg");
        const code = `export const s = wt.store("ui", { hits: 0 }); export const hit = () => s.hits++;`;
        const compile = () => compileScript(code, { store: (name, initial, persist) => A.hub.store("s1", name, initial, persist) });
        const one = compile();
        const two = compile();
        expect(one.error).toBeNull();
        expect(one.exports.s).toBe(two.exports.s);
        one.exports.hit();
        two.exports.hit();
        expect(two.exports.s.hits).toBe(2);
        await settle();
        expect(t.owner.get("s1", "ui")!.data).toEqual({ hits: 2 });
    });
});

describe("wt.store convergence", () => {
    it("converges with concurrent nested edits on both sides", async () => {
        const t = setup();
        const A = t.hub("a");
        const B = t.hub("b");
        const init = () => ({ u: { name: "x", tags: [] as string[] }, c: 0 });
        const a = A.hub.store("s1", "x", init());
        const b = B.hub.store("s1", "x", init());
        await settle();
        a.u.name = "from-a";
        b.u.tags.push("from-b");
        a.c++;
        b.c++;
        await settle();
        expect(a).toEqual(b);
        expect(t.owner.get("s1", "x")!.data).toEqual(JSON.parse(JSON.stringify(a)));
        expect(a.u).toEqual({ name: "from-a", tags: ["from-b"] });
    });

    it("converges when one side replaces a parent another side writes into", async () => {
        const t = setup();
        const A = t.hub("a");
        const B = t.hub("b");
        const a = A.hub.store("s1", "x", { o: { k: 1 } as any });
        const b = B.hub.store("s1", "x", { o: { k: 1 } as any });
        await settle();
        a.o = { fresh: true };
        b.o.k = 2;
        await settle();
        expect(a).toEqual(b);
        expect(JSON.parse(JSON.stringify(a))).toEqual(t.owner.get("s1", "x")!.data);
        b.o = null;
        a.o.k = 3;
        await settle();
        expect(a).toEqual(b);
        expect(JSON.parse(JSON.stringify(b))).toEqual(t.owner.get("s1", "x")!.data);
    });

    it("converges under many random interleaved edits", async () => {
        const t = setup();
        const hubs = ["a", "b", "c"].map((c) => t.hub(c).hub.store("s1", "r", { list: [] as number[], m: {} as Record<string, number> }));
        await settle();
        let seed = 7;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let round = 0; round < 30; round++) {
            for (const s of hubs) {
                const r = rnd();
                if (r < 0.3) s.list.push(Math.floor(rnd() * 100));
                else if (r < 0.45) s.list.shift();
                else if (r < 0.6 && s.list.length) s.list.splice(Math.floor(rnd() * s.list.length), 1);
                else if (r < 0.85) s.m["k" + Math.floor(rnd() * 5)] = round;
                else delete s.m["k" + Math.floor(rnd() * 5)];
            }
            if (round % 3 === 0) await settle();
        }
        await settle();
        const want = t.owner.get("s1", "r")!.data;
        for (const s of hubs) expect(JSON.parse(JSON.stringify(s))).toEqual(want);
    });

    it("notifies valtio subscribers only for changed paths", async () => {
        const t = setup();
        const A = t.hub("a");
        const B = t.hub("b");
        const a = A.hub.store("s1", "x", { left: { n: 0 }, right: { n: 0 } });
        const b = B.hub.store("s1", "x", { left: { n: 0 }, right: { n: 0 } });
        await settle();
        const left = vi.fn();
        const right = vi.fn();
        subscribe(b.left, left);
        subscribe(b.right, right);
        a.left.n = 1;
        await settle();
        expect(left).toHaveBeenCalled();
        expect(right).not.toHaveBeenCalled();
    });
});
