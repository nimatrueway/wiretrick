// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { ScriptLife, type RunCtx, type ReactDomClient } from "../src/shared/runLifecycle";
import { Exposer, RpcClient, ReloadedError } from "../src/shared/rpc";
import { firePageHandler, type PageDocumentHandler } from "../src/shared/pageShim";

/** a react-dom/client stand-in: records what each root renders */
function fakeReact() {
    const roots: { el: Element; rendered: unknown[]; unmounted: boolean }[] = [];
    const client: ReactDomClient = {
        createRoot(el) {
            const r = { el, rendered: [] as unknown[], unmounted: false };
            roots.push(r);
            return {
                render: (n) => {
                    r.rendered.push(n);
                    el.textContent = String(n);
                },
                unmount: () => void (r.unmounted = true),
            };
        },
    };
    return { roots, client };
}

const noReport = (e: unknown) => {
    throw e;
};

describe("ScriptLife", () => {
    let errors: unknown[];
    let react: ReturnType<typeof fakeReact>;
    let life: ScriptLife;
    beforeEach(() => {
        document.head.innerHTML = "";
        document.body.innerHTML = `<div id="slot"></div>`;
        errors = [];
        react = fakeReact();
        life = new ScriptLife({ doc: document, react: () => react.client, onError: (e) => errors.push(e) });
    });
    /** compile + run handler "onPage:0" with `fn`; returns its ctx */
    const reload = (fn: (ctx: RunCtx) => unknown, h = "onPage:0") => {
        const gen = life.begin();
        let ctx!: RunCtx;
        life.fire(gen, h, noReport, (c) => fn((ctx = c)));
        life.commit(gen);
        return { ctx, gen };
    };

    it("a reload aborts the old run's signal once the new run returned", () => {
        let seenOld: boolean | undefined;
        const a = reload(() => {});
        const b = reload(() => void (seenOld = a.ctx.signal.aborted));
        expect(seenOld).toBe(false);
        expect(a.ctx.signal.aborted).toBe(true);
        expect(b.ctx.signal.aborted).toBe(false);
        expect(a.ctx.signal.reason.name).toBe("AbortError");
    });

    it("a new run that throws ends alone: the old run and its claims stay", () => {
        const a = reload((ctx) => ctx.style("a{}"));
        const gen = life.begin();
        let mine!: RunCtx;
        expect(() =>
            life.fire(gen, "onPage:0", noReport, (ctx) => {
                mine = ctx;
                ctx.style("b{}");
                throw new Error("boom");
            })
        ).toThrow("boom");
        life.commit(gen);
        expect(mine.signal.aborted).toBe(true);
        expect(a.ctx.signal.aborted).toBe(false);
        expect([...document.head.querySelectorAll("style")].map((s) => s.textContent)).toEqual(["a{}"]);
    });

    it("ctx.style: one element per CSS, kept while claimed, removed when a reload drops it", () => {
        reload((ctx) => {
            ctx.style("a{}");
            ctx.style("a{}");
            ctx.style("b{}");
        });
        expect(document.head.querySelectorAll("style").length).toBe(2);
        const first = document.head.querySelector("style");
        reload((ctx) => ctx.style("a{}"));
        expect([...document.head.querySelectorAll("style")].map((s) => s.textContent)).toEqual(["a{}"]);
        expect(document.head.querySelector("style")).toBe(first);
    });

    it("ctx.once: the value survives reloads that ask for it, and is dropped when one doesn't", () => {
        let made = 0;
        const make = () => ({ n: ++made });
        let v1: any, v2: any, v3: any;
        reload((ctx) => (v1 = ctx.once("k", make)));
        reload((ctx) => (v2 = ctx.once("k", make)));
        expect(v2).toBe(v1);
        reload(() => {});
        reload((ctx) => (v3 = ctx.once("k", make)));
        expect(v3).not.toBe(v1);
        expect(made).toBe(2);
    });

    it("ctx.patch: one trampoline; reloads swap what it does; unclaimed it passes through", () => {
        const obj = { greet: (n: string) => `hi ${n}` };
        reload((ctx) => ctx.patch(obj, "greet", (orig) => (n: string) => orig(n) + "!"));
        const t = obj.greet;
        expect(obj.greet("a")).toBe("hi a!");
        reload((ctx) => ctx.patch(obj, "greet", (orig) => (n: string) => orig(n) + "?"));
        expect(obj.greet).toBe(t);
        expect(obj.greet("a")).toBe("hi a?");
        reload(() => {});
        expect(obj.greet).toBe(t);
        expect(obj.greet("a")).toBe("hi a");
        // `new` and `this` go through
        class K {
            v = 1;
        }
        const ns = { K };
        reload((ctx) => ctx.patch(ns, "K", (orig) => orig));
        expect(new ns.K()).toBeInstanceOf(K);
        const o = { v: 5, get(this: { v: number }) { return this.v; } };
        reload((ctx) => ctx.patch(o, "get", (orig) => function (this: any) { return orig.call(this) * 2; }));
        expect(o.get()).toBe(10);
    });

    it("ctx.patch: two handlers each get a layer", () => {
        const obj = { f: () => "x" };
        const gen = life.begin();
        life.fire(gen, "onPage:0", noReport, (ctx) => ctx.patch(obj, "f", (o) => () => o() + "a"));
        life.fire(gen, "onPage:1", noReport, (ctx) => ctx.patch(obj, "f", (o) => () => o() + "b"));
        life.commit(gen);
        expect(obj.f()).toBe("xab");
        expect(() => reload((ctx) => ctx.patch({ x: 1 } as any, "x", (o) => o))).toThrow(/isn't a function/);
    });

    it("ctx.mount: one root per target, re-rendered on reload, unmounted when dropped", () => {
        reload((ctx) => {
            (ctx as any).mount("#slot", "v1");
            (ctx as any).mount("floating");
        });
        expect(react.roots.length).toBe(2);
        const slotHost = document.querySelector("#slot > wiretrick-mount");
        expect(slotHost).not.toBeNull();
        reload((ctx) => (ctx as any).mount("#slot", "v2"));
        expect(react.roots.length).toBe(2);
        expect(react.roots[0].rendered).toEqual(["v1", "v2"]);
        expect(react.roots[0].unmounted).toBe(false);
        expect(react.roots[1].unmounted).toBe(true);
        expect(document.querySelectorAll("wiretrick-mount").length).toBe(1);
        // the page replaced the target: the host moves to the new one
        document.body.innerHTML = `<div id="slot"></div>`;
        reload((ctx) => (ctx as any).mount("#slot", "v3"));
        expect(document.querySelector("#slot > wiretrick-mount")).toBe(slotHost);
        expect(() => reload((ctx) => (ctx as any).mount("#nope", "x"))).toThrow(/nothing on the page matches "#nope"/);
    });

    it("ctx.mount: needs React; there's no mount without it", () => {
        const noReact = new ScriptLife({
            doc: document,
            react: () => {
                throw new Error("no React");
            },
        });
        const gen = noReact.begin();
        expect(() => noReact.fire(gen, "h", noReport, (ctx) => (ctx as any).mount("x"))).toThrow(/needs React/);
        const site = new ScriptLife({ doc: document });
        site.fire(site.begin(), "h", noReport, (ctx) => expect(ctx.mount).toBeUndefined());
    });

    it("claims made after an await survive: the old run's claims go once the new run settles", async () => {
        reload((ctx) => ctx.style("a{}"));
        let go!: () => void;
        const gate = new Promise<void>((r) => (go = r));
        reload(async (ctx) => {
            await gate;
            ctx.style("a{}");
        });
        // the old run ended, but its style stays while the new run starts
        expect(document.head.querySelectorAll("style").length).toBe(1);
        const el = document.head.querySelector("style");
        go();
        await gate;
        await new Promise((r) => setTimeout(r, 0));
        expect(document.head.querySelector("style")).toBe(el);
    });

    it("an ended run can't claim, and its AbortError isn't reported", async () => {
        const reported: unknown[] = [];
        let go!: () => void;
        const gate = new Promise<void>((r) => (go = r));
        const g = life.begin();
        life.fire(g, "onPage:0", (e) => reported.push(e), (ctx, report) => {
            const p = (async () => {
                await gate;
                ctx.style("late{}");
            })();
            p.then(undefined, report);
            return p;
        });
        reload(() => {});
        go();
        await new Promise((r) => setTimeout(r, 0));
        expect(reported).toEqual([]);
        expect(document.head.querySelectorAll("style").length).toBe(0);
    });

    it("commit ends the runs of handlers the new compile no longer has", () => {
        const a = reload((ctx) => ctx.style("a{}"), "onPage:0");
        reload(() => {}, "onPage:1");
        expect(a.ctx.signal.aborted).toBe(true);
        expect(document.head.querySelectorAll("style").length).toBe(0);
    });

    it("a discarded compile keeps the previous one; stop() tears everything down", () => {
        const a = reload((ctx) => {
            ctx.style("a{}");
            (ctx as any).mount("#slot", "x");
        });
        const g = life.begin();
        life.discard(g);
        expect(g.signal.aborted).toBe(true);
        expect(a.gen.signal.aborted).toBe(false);
        expect(a.ctx.signal.aborted).toBe(false);
        life.stop();
        expect(a.ctx.signal.aborted).toBe(true);
        expect(a.gen.signal.aborted).toBe(true);
        expect(document.head.querySelectorAll("style").length).toBe(0);
        expect(document.querySelectorAll("wiretrick-mount").length).toBe(0);
        expect(react.roots[0].unmounted).toBe(true);
    });

    it("a generation's signal aborts once it's replaced and none of its runs is alive", () => {
        const a = reload(() => {});
        expect(a.gen.signal.aborted).toBe(false);
        // the new compile's handler throws: the old run (and its generation) stay
        const g = life.begin();
        expect(() => life.fire(g, "onPage:0", noReport, () => { throw new Error("x"); })).toThrow();
        life.commit(g);
        expect(a.gen.signal.aborted).toBe(false);
        reload(() => {});
        expect(a.gen.signal.aborted).toBe(true);
    });

    it("a handler scheduled by a replaced generation doesn't run", () => {
        const g1 = life.begin();
        reload(() => {});
        let ran = false;
        life.fire(g1, "onPage:2", noReport, () => void (ran = true));
        expect(ran).toBe(false);
    });

    it("styles are mirrored into shadow mounts", () => {
        let host!: Element;
        const origAttach = Element.prototype.attachShadow;
        let shadow!: ShadowRoot;
        Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
            host = this;
            return (shadow = origAttach.call(this, init));
        };
        try {
            reload((ctx) => {
                ctx.style("a{}");
                (ctx as any).mount("ui");
            });
            reload((ctx) => {
                ctx.style("a{}");
                ctx.style("b{}");
                (ctx as any).mount("ui");
            });
        } finally {
            Element.prototype.attachShadow = origAttach;
        }
        expect(host.tagName.toLowerCase()).toBe("wiretrick-mount");
        expect([...shadow.querySelectorAll("style")].map((s) => s.textContent)).toEqual(["a{}", "b{}"]);
        reload((ctx) => {
            ctx.style("b{}");
            (ctx as any).mount("ui");
        });
        expect([...shadow.querySelectorAll("style")].map((s) => s.textContent)).toEqual(["b{}"]);
    });

    it("ctx.each: yields each answer, retries a ReloadedError, ends with the run", async () => {
        const { ctx } = reload(() => {});
        let n = 0;
        const next = async () => {
            n++;
            if (n === 2) throw new ReloadedError("reloaded");
            if (n === 4) return new Promise<number>(() => {});
            return n;
        };
        const got: number[] = [];
        const done = (async () => {
            for await (const v of ctx.each(next)) got.push(v);
        })();
        await new Promise((r) => setTimeout(r, 0));
        expect(got).toEqual([1, 3]);
        reload(() => {});
        await done;
        expect(got).toEqual([1, 3]);
    });

    it("ctx.each: other errors end the loop with the error", async () => {
        const { ctx } = reload(() => {});
        const it = ctx.each(async () => {
            throw new Error("nope");
        });
        await expect(it.next()).rejects.toThrow("nope");
    });
});

describe("Exposer.revert (a failed reload keeps the old run answering)", () => {
    const handler = (fn: (ctx: any) => any): PageDocumentHandler => ({ h: "onPage:0", route: { kind: "onDocument", index: 0, urls: ["*"] } as any, when: "document_end", fn });
    const callVia = (ex: Exposer) => {
        const c: RpcClient = new RpcClient((call) => ex.answer(call, (r) => c.receive(r)));
        return c.remote("onPage:0");
    };

    it("a handler that throws on reload: calls go to the previous run's functions", async () => {
        const ex = new Exposer();
        ex.register("onPage:0");
        firePageHandler(handler(() => ({ v: () => "old" })), {}, ex);
        ex.done();
        const h = callVia(ex);
        expect(await h.v()).toBe("old");
        ex.reset();
        ex.register("onPage:0");
        const pending = h.v();
        expect(() => firePageHandler(handler(() => { throw new Error("x"); }), {}, ex)).toThrow("x");
        ex.done();
        expect(await pending).toBe("old");
    });

    it("a compile error: every handle goes back; none before: `not running`", async () => {
        const ex = new Exposer();
        ex.register("onPage:0");
        firePageHandler(handler(() => ({ v: () => 1 })), {}, ex);
        ex.done();
        ex.reset();
        ex.register("onPage:0");
        ex.revert();
        ex.done();
        expect(await callVia(ex).v()).toBe(1);

        const fresh = new Exposer();
        fresh.register("onPage:0");
        fresh.revert();
        fresh.done();
        await expect(callVia(fresh).v()).rejects.toThrow(/not running/);
    });
});
