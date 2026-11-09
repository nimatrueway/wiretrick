// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import * as J from "react/jsx-runtime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HotRegistry, hookSignature } from "../src/shared/hotRefresh";
import { makePackageLoader } from "../src/shared/packageImports";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** a compile of module `path` whose code is `code`: its hot React and jsx */
function compile(reg: HotRegistry, path = "a.tsx", code = "v1") {
    const c = reg.begin();
    return { R: c.wrap("react", React, path, code, React), jsx: c.wrap("react/jsx-runtime", J, path, code, React).jsx as (t: any, p: any) => any, c };
}

let root: Root | null = null;
let host: HTMLElement;
function mount(node: unknown) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node as any));
}
const render = (node: unknown) => act(() => root!.render(node as any));
const flush = () => act(async () => {});

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
});

/** v1 of a `Counter` (state) inside an `App`, clicking it bumps */
function counterModule(reg: HotRegistry, label: string, code = label) {
    const { R, jsx } = compile(reg, "a.tsx", code);
    function Counter() {
        const [n, setN] = R.useState(0);
        return jsx("button", { onClick: () => setN(n + 1), children: `${label}:${n}` });
    }
    function App() {
        return jsx("div", { children: jsx(Counter, {}) });
    }
    return { App, Counter, jsx };
}

describe("hot refresh", () => {
    it("keeps a nested component's state across a save and shows the new version", async () => {
        const reg = new HotRegistry();
        const v1 = counterModule(reg, "one");
        mount(v1.jsx(v1.App, {}));
        act(() => host.querySelector("button")!.click());
        act(() => host.querySelector("button")!.click());
        expect(host.textContent).toBe("one:2");
        const v2 = counterModule(reg, "two");
        render(v2.jsx(v2.App, {}));
        await flush();
        expect(host.textContent).toBe("two:2");
    });

    it("re-renders a mounted family whose parent didn't re-render (behind memo)", async () => {
        const reg = new HotRegistry();
        const make = (label: string) => {
            const { R, jsx } = compile(reg, "a.tsx", label);
            function Leaf() {
                const [n] = R.useState(5);
                return jsx("i", { children: `${label}${n}` });
            }
            const Pane = R.memo(function Pane() {
                return jsx(Leaf, {});
            });
            return { Leaf, el: () => jsx(Pane, {}) };
        };
        const v1 = make("a");
        mount(v1.el());
        expect(host.textContent).toBe("a5");
        // the new compile's JSX ran (other code), the mounted tree wasn't re-rendered
        const v2 = make("b");
        v2.el();
        await flush();
        expect(host.textContent).toBe("b5");
    });

    it("remounts a component whose hook calls changed", async () => {
        const reg = new HotRegistry();
        const v1 = compile(reg, "a.tsx", "1");
        function Box() {
            const [n, setN] = v1.R.useState(0);
            return v1.jsx("b", { onClick: () => setN(n + 1), children: String(n) });
        }
        mount(v1.jsx(Box, {}));
        act(() => (host.querySelector("b") as HTMLElement).click());
        expect(host.textContent).toBe("1");
        const v2 = compile(reg, "a.tsx", "2");
        const Box2 = function Box() {
            const [n] = v2.R.useState(0);
            const r = v2.R.useRef("x");
            return v2.jsx("b", { children: `${n}${r.current}` });
        };
        render(v2.jsx(Box2, {}));
        await flush();
        expect(host.textContent).toBe("0x");
    });

    it("remounts once when a save's render throws (a custom hook changed), and reports a second failure", async () => {
        const reg = new HotRegistry();
        const errors: unknown[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        class Catch extends React.Component<{ children: any }, { e: unknown }> {
            state = { e: null as unknown };
            static getDerivedStateFromError(e: unknown) {
                return { e };
            }
            componentDidCatch(e: unknown) {
                errors.push(e);
            }
            render() {
                return this.state.e ? "caught" : this.props.children;
            }
        }
        const v1 = compile(reg, "a.tsx", "1");
        let fail = 0;
        function Widget() {
            const [n] = v1.R.useState(1);
            return v1.jsx("u", { children: `v1:${n}` });
        }
        mount(React.createElement(Catch, null, v1.jsx(Widget, {})));
        const v2 = compile(reg, "a.tsx", "2");
        const W2 = function Widget() {
            const [n] = v2.R.useState(1);
            if (fail-- > 0) throw new Error("boom");
            return v2.jsx("u", { children: `v2:${n}` });
        };
        fail = 1;
        render(React.createElement(Catch, null, v2.jsx(W2, {})));
        await flush();
        expect(host.textContent).toBe("v2:1");
        expect(errors).toEqual([]);
        // still failing after the remount: the error goes on up
        const v3 = compile(reg, "a.tsx", "3");
        const W3 = function Widget() {
            v3.R.useState(1);
            throw new Error("still");
        };
        render(React.createElement(Catch, null, v3.jsx(W3, {})));
        await flush();
        expect(host.textContent).toBe("caught");
        expect((errors[0] as Error).message).toBe("still");
        spy.mockRestore();
    });

    it("rethrows a render error that didn't follow a save", () => {
        const reg = new HotRegistry();
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const v1 = compile(reg);
        function Bad(): any {
            throw new Error("first");
        }
        let caught: unknown;
        class Catch extends React.Component<{ children: any }, { e: unknown }> {
            state = { e: null as unknown };
            static getDerivedStateFromError(e: unknown) {
                caught = e;
                return { e };
            }
            render() {
                return this.state.e ? "x" : this.props.children;
            }
        }
        mount(React.createElement(Catch, null, v1.jsx(Bad, {})));
        expect((caught as Error).message).toBe("first");
        spy.mockRestore();
    });

    it("leaves a component made inside another one alone (two functions with its name in one compile)", () => {
        const reg = new HotRegistry();
        const { R, jsx } = compile(reg);
        const made: Function[] = [];
        function Outer({ k }: { k: number }) {
            function Inner() {
                return jsx("s", { children: String(k) });
            }
            made.push(Inner);
            return jsx(Inner, {});
        }
        mount(jsx(Outer, { k: 1 }));
        render(jsx(Outer, { k: 2 }));
        expect(host.textContent).toBe("2");
        expect(made[0]).not.toBe(made[1]);
        void R;
    });

    it("leaves anonymous functions, classes and package exports alone", () => {
        const reg = new HotRegistry();
        const { jsx } = compile(reg);
        const anon = jsx((() => null) as any, {});
        expect(anon.type.name).toBe("");
        class K extends React.Component {
            render() {
                return null;
            }
        }
        expect(jsx(K, {}).type).toBe(K);
        const load = makePackageLoader({ aliases: {}, modules: { "https://unpkg.com/p@1.0.0/i.js": { js: "exports.Slot = function Slot(){ return null }", requires: {} } as any } });
        const Slot = load("https://unpkg.com/p@1.0.0/i.js").Slot;
        expect(jsx(Slot, {}).type).toBe(Slot);
        function Named() {
            return null;
        }
        expect(jsx(Named, {}).type).not.toBe(Named);
    });

    it("re-runs a module's effects and memos after a save that changed it, not on other renders", async () => {
        const reg = new HotRegistry();
        const runs: string[] = [];
        const make = (code: string) => {
            const { R, jsx } = compile(reg, "a.tsx", code);
            function Fx({ p }: { p: number }) {
                R.useEffect(() => void runs.push("effect " + code), []);
                const m = R.useMemo(() => code + "!", []);
                return jsx("p", { children: `${m}${p}` });
            }
            return (p: number) => jsx(Fx, { p });
        };
        const v1 = make("one");
        mount(v1(1));
        render(v1(2));
        expect(runs).toEqual(["effect one"]);
        expect(host.textContent).toBe("one!2");
        const v2 = make("two");
        render(v2(2));
        await flush();
        expect(runs).toEqual(["effect one", "effect two"]);
        expect(host.textContent).toBe("two!2");
    });

    it("gives a module's contexts the same object on every save", () => {
        const reg = new HotRegistry();
        const a = compile(reg, "a.tsx").R.createContext(1);
        const b = compile(reg, "a.tsx").R.createContext(2);
        const other = compile(reg, "b.tsx").R.createContext(3);
        expect(b).toBe(a);
        expect(other).not.toBe(a);
    });

    it("doesn't let an older compile still rendering bring back its version", async () => {
        const reg = new HotRegistry();
        const v1 = counterModule(reg, "old");
        mount(v1.jsx(v1.App, {}));
        const v2 = counterModule(reg, "new");
        render(v2.jsx(v2.App, {}));
        await flush();
        render(v1.jsx(v1.App, {}));
        await flush();
        expect(host.textContent).toBe("new:0");
    });

    it("keeps each module's families apart", () => {
        const reg = new HotRegistry();
        const a = compile(reg, "a.tsx");
        function Same() {
            return "a";
        }
        const c2 = a.c.wrap("react/jsx-runtime", J, "b.tsx", "x", React).jsx;
        const Same2 = function Same() {
            return "b";
        };
        expect(a.jsx(Same, {}).type).not.toBe(c2(Same2, {}).type);
    });

    it("runs a package once across a page runtime's saves while its code is the same", () => {
        const url = "https://unpkg.com/q@1.0.0/i.js";
        const pkgs = (js: string) => ({ aliases: {}, modules: { [url]: { js, requires: {} } as any } });
        const a = makePackageLoader(pkgs("exports.o = {}"), undefined, { shared: "t" })(url);
        expect(makePackageLoader(pkgs("exports.o = {}"), undefined, { shared: "t" })(url)).toBe(a);
        expect(makePackageLoader(pkgs("exports.o = {}"), undefined, { shared: "u" })(url)).not.toBe(a);
        expect(makePackageLoader(pkgs("exports.o = {}"))(url)).not.toBe(a);
        expect(makePackageLoader(pkgs("exports.o = []"), undefined, { shared: "t" })(url)).not.toBe(a);
    });

    it("reads a component's hook calls", () => {
        expect(hookSignature(function A() {
            React.useState(0);
            React.useMemo(() => 1, []);
            return null;
        })).toBe("useState,useMemo");
    });
});
