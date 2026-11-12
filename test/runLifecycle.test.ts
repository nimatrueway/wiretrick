// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ScriptLife, type RunCtx, type ReactDomClient } from "../src/shared/runLifecycle";
import { Exposer, RpcClient, ReloadedError } from "../src/shared/rpc";
import { firePageHandler, type PageDocumentHandler } from "../src/shared/pageShim";

/** a react-dom/client stand-in: records what each root renders */
function fakeReact() {
    const roots: { el: Element; rendered: unknown[]; keys: unknown[]; unmounted: boolean }[] = [];
    const client: ReactDomClient = {
        createRoot(el) {
            const r = { el, rendered: [] as unknown[], keys: [] as unknown[], unmounted: false };
            roots.push(r);
            return {
                render: (n: any) => {
                    // an element of a function component: what it renders (no hooks here)
                    const v = n && typeof n === "object" && typeof n.type === "function" ? n.type(n.props) : n;
                    r.rendered.push(v);
                    r.keys.push(n?.props?.key);
                    el.textContent = String(v);
                },
                unmount: () => void (r.unmounted = true),
            };
        },
        createElement: (type: unknown, props: unknown) => ({ type, props }),
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
        for (const m of document.querySelectorAll("tangitweak-mount")) m.remove();
        errors = [];
        react = fakeReact();
        life = new ScriptLife({ doc: document, react: () => react.client, onError: (e) => errors.push(e) });
    });
    // a live ScriptLife keeps watching the page: end it so it can't mount into the next test
    afterEach(() => life.stop());
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

        // constructor static constants (like WebSocket.OPEN / CLOSED) survive ctx.patch
        class FakeWS {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            static readonly CLOSING = 2;
            static readonly CLOSED = 3;
            readyState = FakeWS.OPEN;
            constructor(public url: string, public protocols?: string | string[]) {}
        }
        const win = { WebSocket: FakeWS };
        reload((ctx) =>
            ctx.patch(win, "WebSocket", (Native) =>
                new Proxy(Native, {
                    construct(target, [url, protocols]) {
                        return new target(url === "wss://webpack/ws" ? "ws://localhost:8081/ws" : url, protocols);
                    },
                })
            )
        );
        expect(win.WebSocket.OPEN).toBe(1);
        expect(win.WebSocket.CLOSED).toBe(3);
        const userWs = new win.WebSocket("wss://app.example.com/live");
        expect(userWs.url).toBe("wss://app.example.com/live");
        expect(userWs.readyState === win.WebSocket.OPEN).toBe(true);
        expect(userWs instanceof win.WebSocket).toBe(true);
        expect(userWs instanceof FakeWS).toBe(true);
        expect(new win.WebSocket("wss://webpack/ws").url).toBe("ws://localhost:8081/ws");
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
        const first = { first: true };
        reload((ctx) => {
            (ctx as any).mount("#slot", "v1", first);
            (ctx as any).mount("floating");
        });
        expect(react.roots.length).toBe(2);
        const slotHost = document.querySelector("#slot > tangitweak-mount");
        expect(slotHost).not.toBeNull();
        reload((ctx) => (ctx as any).mount("#slot", "v2", first));
        expect(react.roots.length).toBe(2);
        expect(react.roots[0].rendered).toEqual(["v1", "v2"]);
        expect(react.roots[0].unmounted).toBe(false);
        expect(react.roots[1].unmounted).toBe(true);
        expect(document.querySelectorAll("tangitweak-mount").length).toBe(1);
        // the page replaced the target: a first-match host moves to the new one
        document.body.innerHTML = `<div id="slot"></div>`;
        reload((ctx) => (ctx as any).mount("#slot", "v3", first));
        expect(document.querySelector("#slot > tangitweak-mount")).toBe(slotHost);
    });

    it("ctx.mount waits for a target that isn't on the page yet (the latest UI); the run ending stops the wait", async () => {
        const tick = () => new Promise((r) => setTimeout(r, 0));
        const { ctx } = reload((ctx) => (ctx as any).mount("#later", "a"));
        (ctx as any).mount("#later", "b");
        expect(react.roots.length).toBe(0);
        document.body.appendChild(Object.assign(document.createElement("div"), { id: "later" }));
        await tick();
        expect(react.roots.length).toBe(1);
        expect(react.roots[0].rendered).toEqual(["b"]);
        expect(document.querySelector("#later > tangitweak-mount")).not.toBeNull();
        // a reload whose target is gone: the old mount goes, and nothing mounts once the run ends
        document.body.innerHTML = "";
        reload((ctx) => (ctx as any).mount("#gone", "c"));
        expect(react.roots[0].unmounted).toBe(true);
        reload(() => {});
        document.body.appendChild(Object.assign(document.createElement("div"), { id: "gone" }));
        await tick();
        expect(react.roots.length).toBe(1);
        expect(errors).toEqual([]);
        expect(() => reload((ctx) => (ctx as any).mount("#bad[", "x"))).toThrow();
    });

    it("ctx.mount again in the same run (no target, or the same element) re-renders that mount", () => {
        const slot = document.querySelector("#slot")!;
        const { ctx } = reload((ctx) => {
            (ctx as any).mount("a");
            (ctx as any).mount(slot, "x");
        });
        (ctx as any).mount("b");
        (ctx as any).mount(slot, "y");
        expect(react.roots.length).toBe(2);
        expect(react.roots.map((r) => r.rendered)).toEqual([["a", "b"], ["x", "y"]]);
        reload((ctx) => {
            (ctx as any).mount("c");
            (ctx as any).mount(slot, "z");
        });
        expect(react.roots.length).toBe(2);
        expect(document.querySelectorAll("tangitweak-mount").length).toBe(2);
    });

    it("ctx.mount(selector): a root on every match, now and later; a gone match unmounts", async () => {
        const tick = () => new Promise((r) => setTimeout(r, 0));
        document.body.innerHTML = `<i class="a">1</i><i class="a">2</i>`;
        reload((ctx) => (ctx as any).mount(".a", (el: Element) => "on " + el.firstChild!.textContent));
        expect([...document.querySelectorAll(".a > tangitweak-mount")].map((h) => h.previousSibling!.textContent)).toEqual(["1", "2"]);
        expect(react.roots.map((r) => r.rendered)).toEqual([["on 1"], ["on 2"]]);
        const third = Object.assign(document.createElement("i"), { className: "a", textContent: "3" });
        document.body.appendChild(third);
        await tick();
        expect(react.roots.length).toBe(3);
        expect(react.roots[2].rendered).toEqual(["on 3"]);
        document.querySelector(".a")!.remove();
        await tick();
        expect(react.roots.map((r) => r.unmounted)).toEqual([true, false, false]);
        // a match inside our own UI isn't one
        reload((ctx) => (ctx as any).mount(".a", "<i class=a>"));
        expect(react.roots.length).toBe(3);
        expect(errors).toEqual([]);
    });

    it("ctx.mount positions: inside-first, before, after; overlay makes a static anchor relative until it's gone", () => {
        document.body.innerHTML = `<p id="t"><b>x</b></p>`;
        const t = document.querySelector("#t") as HTMLElement;
        reload((ctx) => {
            (ctx as any).mount("#t", "f", { position: "inside-first" });
            (ctx as any).mount("#t", "b", { position: "before" });
            (ctx as any).mount("#t", "a", { position: "after" });
            (ctx as any).mount("#t", "o", { position: "overlay" });
        });
        const names = (n: Node) => [...n.childNodes].map((c) => (c.nodeName === "TANGITWEAK-MOUNT" ? "mount" : c.nodeName.toLowerCase()));
        expect(names(document.body)).toEqual(["mount", "p", "mount"]);
        expect(names(t)).toEqual(["mount", "b", "mount"]);
        expect(t.style.position).toBe("relative");
        expect((t.lastChild as HTMLElement).style.position).toBe("absolute");
        reload((ctx) => (ctx as any).mount("#t", "f", { position: "inside-first" }));
        expect(names(document.body)).toEqual(["p"]);
        expect(names(t)).toEqual(["mount", "b"]);
        expect(t.style.position).toBe("");
        expect(() => reload((ctx) => (ctx as any).mount("#t", "x", { position: "beside" }))).toThrow(/position must be one of/);
        expect(() => reload((ctx) => (ctx as any).mount("#t", "x", { key: 1 }))).toThrow(/key must be a string/);
        expect(() => reload((ctx) => (ctx as any).mount(5, "x"))).toThrow(/selector or an element/);
    });

    it("ctx.mount: a key makes a second mount on the same anchor; dispose drops it", () => {
        let off!: () => void;
        reload((ctx) => {
            (ctx as any).mount("#slot", "one");
            off = (ctx as any).mount("#slot", "two", { key: "b" });
        });
        expect(document.querySelectorAll("#slot > tangitweak-mount").length).toBe(2);
        off();
        expect(document.querySelectorAll("#slot > tangitweak-mount").length).toBe(1);
        expect(react.roots[1].unmounted).toBe(true);
        off();
        expect(react.roots[0].unmounted).toBe(false);
    });

    it("ctx.mount: a render function re-renders with the latest code; a hook change remounts it", () => {
        const useState = (v: unknown) => [v];
        reload((ctx) => (ctx as any).mount("#slot", () => "v1"));
        reload((ctx) => (ctx as any).mount("#slot", () => "v2"));
        reload((ctx) => (ctx as any).mount("#slot", () => (useState(0), "v3")));
        expect(react.roots.length).toBe(1);
        expect(react.roots[0].rendered).toEqual(["v1", "v2", "v3"]);
        const [k1, k2, k3] = react.roots[0].keys;
        expect(k2).toBe(k1);
        expect(k3).not.toBe(k1);
        expect(react.roots[0].unmounted).toBe(false);
    });

    it("ctx.mount autoRestore: the page removing the UI puts it back; a fight with the page stops it", async () => {
        const tick = () => new Promise((r) => setTimeout(r, 0));
        const slot = document.querySelector("#slot")!;
        reload((ctx) => (ctx as any).mount("#slot", "x", { autoRestore: true }));
        const host = slot.firstChild!;
        slot.textContent = "";
        await tick();
        expect(slot.firstChild).toBe(host);
        expect(react.roots.length).toBe(1);
        for (let i = 0; i < 25; i++) {
            slot.textContent = "";
            await tick();
        }
        expect(slot.firstChild).toBeNull();
        expect(String(errors[0])).toMatch(/keeps removing the UI, so autoRestore stopped/);
        // without autoRestore the page's removal stands
        errors.length = 0;
        reload((ctx) => (ctx as any).mount(slot, "y"));
        slot.textContent = "";
        await tick();
        expect(slot.firstChild).toBeNull();
        expect(errors).toEqual([]);
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

    it("a handler that ends in a ctx.each loop: starting the loop releases what the old run claimed alone", async () => {
        const forever = async () => new Promise<number>(() => {});
        const run = (css: string) =>
            reload(async (ctx) => {
                ctx.style(css);
                for await (const _ of ctx.each(forever));
            });
        run("a{}");
        run("b{}");
        await new Promise((r) => setTimeout(r, 0));
        expect([...document.head.querySelectorAll("style")].map((s) => s.textContent)).toEqual(["b{}"]);
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
        expect(document.querySelectorAll("tangitweak-mount").length).toBe(0);
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
        expect(host.tagName.toLowerCase()).toBe("tangitweak-mount");
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
