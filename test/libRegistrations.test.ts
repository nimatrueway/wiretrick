// A library's exported function that registers handlers (`export function
// install() { tt.onPage(…) }`), called from the importer's top level: the
// handlers are the importer's — in the background and in the page alike,
// with the same keys.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileScript, makeModuleResolver, siteProblems, toRunnableJs } from "../src/shared/compile";
import { makePageShim } from "../src/shared/pageShim";
import { makeLibRequire } from "../src/shared/scriptImports";
import { scriptFunction } from "../src/shared/scriptFn";
import { routeLabel } from "../src/shared/route";

const A = `export function install(p: string) { tt.onPage(p, () => "a1"); return tt.onPage(p, () => "a2"); }\ntt.onPage("*", () => "a-own");`;
const B = `export const install = () => tt.onPage("*", () => "b");\nexport const site = () => tt.onSite("*", () => "s");`;
const ROOT = `import { install as a } from "./a";\nimport { install as b, site } from "./b";\na("*");\ntt.onPage("*", () => "root");\nb();\nsite();\na("*");`;
const KEYS = ["onPage:0@a", "onPage:1@a", "onPage:0", "onPage:0@b", "onSite:0@b", "onPage:0@a#1", "onPage:1@a#1"];

const base = { params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined } };

function pageRun(world: "isolated" | "page") {
    const libs = [
        { name: "a", src: toRunnableJs(A) },
        { name: "b", src: toRunnableJs(B) },
    ];
    const requireFrom = makeLibRequire(libs, (lib, require, m) => scriptFunction(lib.src!, lib.name)(makePageShim({ ...base, world, lib: lib.name }).tt, console, require, m, m.exports));
    const run = (name: string, code: string) => {
        const shim = makePageShim({ ...base, world });
        const m = { exports: {} as any };
        shim.top(() => scriptFunction(toRunnableJs(code), name)(shim.tt, console, requireFrom(name), m, m.exports));
        return shim;
    };
    return { run, requireFrom };
}

describe("handlers registered by a library's function, for the importer", () => {
    it("background: the importer's routes, keyed by library", () => {
        const scripts = [
            { id: "a", name: "a", code: A },
            { id: "b", name: "b", code: B },
        ];
        const c = compileScript(ROOT, { name: "root", importModule: makeModuleResolver(scripts, () => ({})).resolveFrom("root") });
        expect(c.error).toBeNull();
        const routes = c.meta.routes.filter((r) => r.kind === "onDocument");
        expect(routes.map((r) => r.key).sort()).toEqual([...KEYS].sort());
        expect(routes.find((r) => r.key === "onPage:1@a#1")!.lib).toBe("a");
        expect(routes.find((r) => r.key === "onPage:0")!.lib).toBeUndefined();
        expect(routeLabel(routes.find((r) => r.key === "onPage:1@a")!)).toBe("onPage #2 (a)");
        expect(routeLabel(routes.find((r) => r.key === "onPage:0")!)).toBe("onPage #1");
    });

    it("page (onPage): the importer's handlers run, with the background's keys", () => {
        const shim = pageRun("isolated").run("root", ROOT);
        expect(shim.dom.map((d) => [d.h, d.fn({})])).toEqual([
            ["onPage:0@a", "a1"],
            ["onPage:1@a", "a2"],
            ["onPage:0", "root"],
            ["onPage:0@b", "b"],
            ["onPage:0@a#1", "a1"],
            ["onPage:1@a#1", "a2"],
        ]);
    });

    it("page (onSite): the site's world gets the library's onSite handler", () => {
        const shim = pageRun("page").run("root", ROOT);
        expect(shim.dom.map((d) => [d.h, d.fn({})])).toEqual([["onSite:0@b", "s"]]);
    });

    it("a library's own top level, and calls after the top level, aren't the importer's", () => {
        const { run, requireFrom } = pageRun("isolated");
        const shim = run("root", ROOT);
        const n = shim.dom.length;
        requireFrom("root")("./a").install("*");
        expect(shim.dom).toHaveLength(n);
        expect(shim.dom.some((d) => d.fn({}) === "a-own")).toBe(false);
    });

    it("libraries shared by scripts (one module registry): each script numbers its own", () => {
        const { run } = pageRun("isolated");
        run("root", ROOT);
        const other = run("other", `import { install } from "./a";\ninstall("*");`);
        expect(other.dom.map((d) => d.h)).toEqual(["onPage:0@a", "onPage:1@a"]);
    });

    it("onSite warnings check the importer's own calls only", () => {
        const scripts = [{ id: "b", name: "b", code: B }];
        const code = `import { site } from "./b";\nconst ps = tt.pageStore("ps", {});\nsite();\ntt.onSite("*", () => ps);`;
        const c = compileScript(code, { name: "root", importModule: makeModuleResolver(scripts, () => ({})).resolveFrom("root") });
        expect(c.error).toBeNull();
        expect(siteProblems(code, c.meta.routes).map((m) => m.slice(0, m.indexOf(":")))).toEqual(["onSite #1"]);
    });
});
