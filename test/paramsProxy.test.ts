// `tt.params` returns a proxy: assigning a param (or changing a list in
// place) is checked against its type, seen right away and sent to be
// saved like a ⚙ change — once per param per turn. Not from a top level
// (each change re-runs the script) and not from onSite code.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileScript, toRunnableJs } from "../src/shared/compile";
import { makePageShim } from "../src/shared/pageShim";
import { makeLibRequire } from "../src/shared/scriptImports";
import { scriptFunction } from "../src/shared/scriptFn";
import { paramsProxy, PARAM_AT_TOP, PARAM_ON_SITE } from "../src/shared/paramsProxy";

const DEFS = {
    on: { type: "boolean", default: true },
    n: { type: "number", default: 1 },
    mode: { type: "enum", choices: ["a", "b"], default: "a" },
    hosts: { type: "stringList", default: ["x.com"] },
    url: { type: "string", default: "https://a.com", parse: (s: string) => new URL(s) },
} as const;

const tick = () => new Promise((r) => setTimeout(r, 0));

function make(blocked?: string) {
    const sent: [string, any][] = [];
    const raw = { on: true, n: 1, mode: "a", hosts: ["x.com"], url: "https://a.com" };
    const cfg = paramsProxy(DEFS as any, raw, {}, { blocked: () => blocked, send: (k, v) => sent.push([k, v]) });
    return { cfg, sent };
}

describe("paramsProxy", () => {
    it("assigns: seen right away, sent once per param per turn (the last value)", async () => {
        const { cfg, sent } = make();
        cfg.on = false;
        expect(cfg.on).toBe(false);
        cfg.n = 5;
        cfg.n = 7;
        cfg.mode = "b";
        expect(sent).toEqual([]);
        await tick();
        expect(sent).toEqual([
            ["on", false],
            ["n", 7],
            ["mode", "b"],
        ]);
    });

    it("an unchanged value sends nothing", async () => {
        const { cfg, sent } = make();
        cfg.on = true;
        cfg.hosts = ["x.com"];
        await tick();
        expect(sent).toEqual([]);
    });

    it("checks the type, the name and the choices", () => {
        const { cfg } = make();
        expect(() => (cfg.on = "yes")).toThrow(/"on" can't be "yes": it takes a boolean/);
        expect(() => (cfg.n = NaN)).toThrow(/a finite number/);
        expect(() => (cfg.mode = "c")).toThrow(/one of "a", "b"/);
        expect(() => (cfg.hosts = ["a", 1])).toThrow(/an array of strings/);
        expect(() => (cfg.nope = 1)).toThrow(/there's no parameter "nope"/);
        expect(() => delete cfg.on).toThrow(/can't be deleted/);
        expect(cfg.on).toBe(true);
    });

    it("a param with parse can't be assigned", () => {
        const { cfg } = make();
        expect(cfg.url.host).toBe("a.com");
        expect(() => (cfg.url = "https://b.com")).toThrow(/has a parse function/);
    });

    it("lists change in place, like valtio; a kept reference follows", async () => {
        const { cfg, sent } = make();
        const hosts = cfg.hosts;
        expect(Array.isArray(hosts)).toBe(true);
        expect(hosts.push("y.com")).toBe(2);
        hosts[0] = "z.com";
        expect([...cfg.hosts]).toEqual(["z.com", "y.com"]);
        expect(hosts.pop()).toBe("y.com");
        expect(JSON.stringify(cfg)).toBe('{"on":true,"n":1,"mode":"a","hosts":["z.com"],"url":"https://a.com/"}');
        expect(cfg.hosts.includes("z.com")).toBe(true);
        cfg.hosts = ["q.com"];
        expect(hosts.length).toBe(1);
        expect(hosts[0]).toBe("q.com");
        expect(() => hosts.push(3 as any)).toThrow(/an array of strings/);
        expect(() => delete (hosts as any)[0]).toThrow(/splice/);
        await tick();
        expect(sent).toEqual([["hosts", ["q.com"]]]);
    });

    it("blocked: the writer's reason is thrown, nothing changes", async () => {
        const { cfg, sent } = make("not now");
        expect(() => (cfg.on = false)).toThrow("not now");
        expect(() => cfg.hosts.push("y")).toThrow("not now");
        expect(cfg.on).toBe(true);
        expect([...cfg.hosts]).toEqual(["x.com"]);
        await tick();
        expect(sent).toEqual([]);
    });

    it("supports nested section proxies: assigns leaf paths, mutates nested lists, and forbids overwriting a section", async () => {
        const sent: [string, any][] = [];
        const nestedDefs = {
            network: {
                host: { type: "string", default: "a.com" },
                tags: { type: "stringList", default: ["v1"] },
                filter: { type: { type: "enum", choices: ["xhr", "fetch"], default: "xhr" } },
            },
        } as any;
        const raw = { network: { host: "a.com", tags: ["v1"], filter: { type: "xhr" } } };
        const cfg = paramsProxy(nestedDefs, raw, {}, { blocked: () => undefined, send: (k, v) => sent.push([k, v]) });
        cfg.network.host = "b.com";
        cfg.network.tags.push("v2");
        cfg.network.filter.type = "fetch";
        expect(() => ((cfg as any).network = {})).toThrow(/parameter section/);
        await tick();
        expect(sent).toEqual([
            ["network.host", "b.com"],
            ["network.tags", ["v1", "v2"]],
            ["network.filter.type", "fetch"],
        ]);
    });
});

describe("tt.params in the background and the overlay (compileScript)", () => {
    const CODE = `const cfg = tt.params({ on: { type: "boolean", default: true } });
tt.onRequest({ url: "*://a.com/*", strategy: "helper" }, () => { cfg.on = !cfg.on; return { block: cfg.on }; });`;

    it("a handler's assignment goes to overrides.setParam", async () => {
        const sent: [string, any][] = [];
        const c = compileScript(CODE, { paramValues: { on: true }, setParam: async (k, v) => void sent.push([k, v]) });
        expect(c.error).toBeNull();
        expect(c.handlers.onRequest[0].fn({} as any)).toEqual({ block: false });
        await tick();
        expect(sent).toEqual([["on", false]]);
    });

    it("not at the top level", () => {
        const c = compileScript(`const cfg = tt.params({ on: { type: "boolean" } });\ncfg.on = true;`, { setParam: async () => {} });
        expect(c.error).toContain(PARAM_AT_TOP);
    });

    it("without setParam (a save-time compile): can't change", () => {
        const c = compileScript(CODE, { paramValues: { on: true } });
        expect(() => c.handlers.onRequest[0].fn({} as any)).toThrow(/can't be changed here/);
    });
});

describe("tt.params in page code (makePageShim)", () => {
    const base = { log: () => {}, storage: { get: () => undefined, set: () => undefined } };
    const CODE = `const cfg = tt.params({ on: { type: "boolean", default: true }, tags: { type: "stringList" } });
export const flip = () => { cfg.on = !cfg.on; cfg.tags.push("t"); return cfg.on; };`;

    function run(world: "isolated" | "page", setParam?: (k: string, v: any, lib?: string) => Promise<void>) {
        const shim = makePageShim({ ...base, params: { on: true, tags: [] }, world, setParam });
        const m = { exports: {} as any };
        shim.top(() => scriptFunction(toRunnableJs(CODE), "s")(shim.tt, console, () => ({}), m, m.exports));
        return m.exports;
    }

    it("onPage code: sent with setParam", async () => {
        const sent: any[] = [];
        const ex = run("isolated", async (k, v, lib) => void sent.push([k, v, lib]));
        expect(ex.flip()).toBe(false);
        await tick();
        expect(sent).toEqual([
            ["on", false, undefined],
            ["tags", ["t"], undefined],
        ]);
    });

    it("onSite code can't", () => {
        const ex = run("page", async () => {});
        expect(() => ex.flip()).toThrow(PARAM_ON_SITE);
    });

    it("not at the top level", () => {
        const shim = makePageShim({ ...base, params: {}, world: "isolated", setParam: async () => {} });
        expect(() => shim.top(() => scriptFunction(toRunnableJs(`const c = tt.params({ on: { type: "boolean" } }); c.on = true;`), "s")(shim.tt, console, () => ({}), { exports: {} }, {}))).toThrow(PARAM_AT_TOP);
    });

    it("a library's params are sent with its name", async () => {
        const sent: any[] = [];
        const setParam = async (k: string, v: any, lib?: string) => void sent.push([k, v, lib]);
        const libs = [{ name: "gate", src: toRunnableJs(`export const cfg = tt.params({ on: { type: "boolean" } });`) }];
        const requireFrom = makeLibRequire(libs, (lib, require, m) => scriptFunction(lib.src!, lib.name)(makePageShim({ ...base, params: { on: false }, world: "isolated", lib: lib.name, setParam }).tt, console, require, m, m.exports));
        const shim = makePageShim({ ...base, params: {}, world: "isolated", setParam });
        const m = { exports: {} as any };
        shim.top(() => scriptFunction(toRunnableJs(`import { cfg } from "./gate";\nexport const on = () => (cfg.on = true);`), "s")(shim.tt, console, requireFrom("s"), m, m.exports));
        m.exports.on();
        await tick();
        expect(sent).toEqual([["on", true, "gate"]]);
    });
});
