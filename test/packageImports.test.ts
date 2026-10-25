// Package imports: pinned unpkg URLs in scripts. URL validation, the
// background download of a package's module graph (ESM / CJS / UMD,
// dependency ranges, built-ins, failures, caching, pruning), the runtime
// loader through the compilers and the page hook, and the typings crawl.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs, makeModuleResolver } from "../src/shared/compile";
import { makeLibRequire, importResolver } from "../src/shared/scriptImports";
import { errorPosition } from "../src/ui/problems";
import {
    classifyNested,
    declarationRefs,
    isEsModule,
    makePackageLoader,
    packageClosure,
    parsePackageUrl,
    rangeUrl,
    requireSpecs,
    typesCandidates,
    typesPackageName,
    PACKAGE_MODULES_KEY,
    PACKAGE_TYPINGS_KEY,
} from "../src/shared/packageImports";
import { fakeUnpkg, REGISTRY } from "./fakeUnpkg";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {}, getURL: (p: string) => `chrome-extension://x/${p}` },
};

let unpkg = fakeUnpkg(REGISTRY);
let current: typeof import("../src/background/engine/packageImports") | undefined;

/** a fresh background module (its in-memory state) over the current store */
async function bg() {
    vi.resetModules();
    return (current = await import("../src/background/engine/packageImports"));
}

beforeEach(async () => {
    await current?.packageTypingsIdle();
    for (const k of Object.keys(store)) delete store[k];
    unpkg = fakeUnpkg(REGISTRY);
    (globalThis as any).fetch = unpkg.fetch;
});

describe("package URLs", () => {
    it("accepts pinned unpkg URLs, scoped names, prereleases and subpaths", () => {
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13")).toEqual({ name: "dayjs", version: "1.11.13", sub: "" });
        expect(parsePackageUrl("https://unpkg.com/@scope/pkg@2.0.0-beta.1+build.5/dist/a.js")).toEqual({ name: "@scope/pkg", version: "2.0.0-beta.1+build.5", sub: "dist/a.js" });
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13/plugin/utc")).toEqual({ name: "dayjs", version: "1.11.13", sub: "plugin/utc" });
    });

    it("rejects ranges, tags, other hosts, query strings and odd paths with a helpful message", () => {
        expect(parsePackageUrl("https://unpkg.com/dayjs")).toBe(
            `cannot import "https://unpkg.com/dayjs": pin an exact version, e.g. https://unpkg.com/dayjs@1.2.3 (ranges and tags like "latest" can change under the script)`
        );
        for (const u of ["https://unpkg.com/dayjs@1", "https://unpkg.com/dayjs@^1.2.0", "https://unpkg.com/dayjs@latest/plugin/utc", "https://unpkg.com/@s/x@1.2"]) expect(parsePackageUrl(u)).toMatch(/pin an exact version/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@latest/plugin/utc")).toMatch(/e\.g\. https:\/\/unpkg\.com\/dayjs@1\.2\.3\/plugin\/utc/);
        expect(parsePackageUrl("https://cdn.jsdelivr.net/npm/dayjs@1.11.13")).toMatch(/only pinned https:\/\/unpkg\.com\/<package>@<version> URLs/);
        expect(parsePackageUrl("http://unpkg.com/dayjs@1.11.13")).toMatch(/only pinned/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13?module")).toMatch(/query string or hash/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13#x")).toMatch(/query string or hash/);
        expect(parsePackageUrl("https://unpkg.com/dayjs@1.11.13/../x")).toMatch(/isn't normalized/);
        expect(parsePackageUrl("https://unpkg.com/")).toMatch(/not a package URL/);
    });

    it("are never script or data file imports", () => {
        expect(importResolver(["https:/unpkg.com/x@1.0.0"])("main", "https://unpkg.com/x@1.0.0")).toBeUndefined();
    });

    it("classifies a library's nested specifiers", () => {
        const from = "https://unpkg.com/a@1.0.0/dist/x.js";
        expect(classifyNested("./y", from)).toEqual({ url: "https://unpkg.com/a@1.0.0/dist/y" });
        expect(classifyNested("../z.js", from)).toEqual({ url: "https://unpkg.com/a@1.0.0/z.js" });
        expect(classifyNested("/b@2.0.0/c.js", from)).toEqual({ url: "https://unpkg.com/b@2.0.0/c.js" });
        expect(classifyNested("https://unpkg.com/b@2.0.0", from)).toEqual({ url: "https://unpkg.com/b@2.0.0" });
        expect(classifyNested("https://esm.sh/b", from)).toHaveProperty("error");
        expect(classifyNested("@s/p/sub/x", from)).toEqual({ bare: "@s/p", sub: "sub/x" });
        expect(rangeUrl("b", "^1.2.0 || 2", "x.js")).toBe("https://unpkg.com/b@%5E1.2.0%20%7C%7C%202/x.js");
        expect(rangeUrl("b", undefined, "")).toBe("https://unpkg.com/b@latest");
        for (const r of ["npm:other@1", "workspace:*", "github:a/b", "file:../x", "a/b"]) expect(rangeUrl("b", r, "")).toBeNull();
        expect(typesPackageName("@scope/x")).toBe("@types/scope__x");
    });

    it("scans code: ES module syntax, requires and declaration references", () => {
        expect(isEsModule(`export default 1`)).toBe(true);
        expect(isEsModule(`const a = 1;\nimport x from "y"`)).toBe(true);
        expect(isEsModule(`module.exports = { importer: 1 }; // import x from "y"`)).toBe(false);
        expect(requireSpecs(`a.require("no"); require("x"); require('./y'); myrequire("z")`)).toEqual(["x", "./y"]);
        const refs = declarationRefs(`/// <reference path="./g.d.ts" />\n/// <reference types="node" />\nimport a from "./a";\nexport * from "b/c";\ntype T = import("./t");\nimport e = require("e");\ndeclare module "ambient" {}\ndeclare module "./aug" {}\n// import z from "./commented"`);
        expect(refs).toEqual({ specs: ["./a", "b/c", "./t", "e", "./aug"], paths: ["./g.d.ts"], types: ["node"] });
        expect(typesCandidates({ exports: { ".": { node: { import: { types: "./n.d.mts" } } } } }, "")).toEqual(["n.d.mts", "index.d.ts"]);
        // like TypeScript: `import` before `require`, whatever the order
        expect(typesCandidates({ exports: { "./a": { require: { types: "./a.d.cts" }, import: { types: "./a.d.ts" } } } }, "a.js")[0]).toBe("a.d.ts");
        expect(typesCandidates({ exports: { "./a": { require: { types: "./a.d.cts" } } } }, "a")[0]).toBe("a.d.cts");
        expect(typesCandidates({ main: "dist/a.js" }, "")).toEqual(["dist/a.d.ts", "index.d.ts"]);
        expect(typesCandidates({ exports: { "./*": { types: "./t/*.d.ts" } } }, "x.js")).toEqual(["t/x.js.d.ts", "t/x.d.ts", "x.d.ts", "x.js.d.ts", "x.js/index.d.ts", "x.d.mts", "x.d.cts"]);
    });
});

describe("downloading a package's module graph", () => {
    it("ESM (relative imports, import.meta), CJS with dependency ranges, UMD in sloppy mode", async () => {
        const p = await bg();
        const urls = ["https://unpkg.com/esm-lib@1.0.0", "https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/umd-lib@1.0.0"];
        expect(await p.ensurePackages([urls.map((u, i) => `import m${i} from "${u}";`).join("\n")])).toBe(true);
        const pkgs = p.packagesSnapshot();
        expect(pkgs.aliases["https://unpkg.com/esm-lib@1.0.0"]).toBe("https://unpkg.com/esm-lib@1.0.0/index.js");
        expect(pkgs.modules["https://unpkg.com/esm-lib@1.0.0/index.js"].requires["./math.js"]).toBe("https://unpkg.com/esm-lib@1.0.0/math.js");
        // "^3.0.0" → 3.1.0, not 4.0.0
        expect(pkgs.modules["https://unpkg.com/cjs-lib@2.0.0/lib/index.js"].requires).toEqual({
            "dep-lib": "https://unpkg.com/dep-lib@3.1.0/index.js",
            "dep-lib/extra": "https://unpkg.com/dep-lib@3.1.0/extra.js",
        });
        const load = makePackageLoader(pkgs);
        const esm = load(urls[0]);
        expect(esm.default(4)).toBe(8);
        expect(esm.add(1, 2)).toBe(3);
        expect(esm.where).toBe("https://unpkg.com/esm-lib@1.0.0/index.js");
        expect(load(urls[1]).shout("hi")).toBe("HI!");
        expect(load(urls[2])).toEqual({ rootIsExports: true, sloppy: true, nodeEnv: "production" });
        delete (globalThis as any).wtUmdSloppyGlobal;
        // stored for later runs (offline)
        expect(Object.keys(store[PACKAGE_MODULES_KEY].modules)).toHaveLength(6);
    });

    it("a library's require of a Node.js built-in or a missing file throws a clear error only when run", async () => {
        const p = await bg();
        await p.ensurePackages([`import a from "https://unpkg.com/builtin-lib@1.0.0"; import b from "https://unpkg.com/nested-fail@1.0.0";`]);
        const load = makePackageLoader(p.packagesSnapshot());
        expect(load("https://unpkg.com/builtin-lib@1.0.0")).toEqual({
            ok: true,
            err: `"fs" is a Node.js built-in — not available in Wiretrick scripts`,
            err2: `"node:path" is a Node.js built-in — not available in Wiretrick scripts`,
        });
        const nf = load("https://unpkg.com/nested-fail@1.0.0");
        expect(nf.ok).toBe(1);
        expect(nf.err).toMatch(/cannot import "\.\/missing\.js" \(required by https:\/\/unpkg\.com\/nested-fail@1\.0\.0\/index\.js\): HTTP 404/);
        expect(unpkg.calls.filter((c) => c.includes("fs"))).toEqual([]);
    });

    it("cycles get partial exports; JSON modules export their data", async () => {
        const p = await bg();
        await p.ensurePackages([`import a from "https://unpkg.com/cycle-lib@1.0.0"; import n from "https://unpkg.com/json-lib@1.0.0";`]);
        const load = makePackageLoader(p.packagesSnapshot());
        expect(load("https://unpkg.com/cycle-lib@1.0.0")).toEqual({ a: 1, fromB: 1 });
        expect(load("https://unpkg.com/json-lib@1.0.0")).toBe(5);
    });

    it("is cached: a second ensure (and a fresh background) fetches nothing", async () => {
        let p = await bg();
        const code = `import x from "https://unpkg.com/cjs-lib@2.0.0";`;
        await p.ensurePackages([code]);
        await p.packageTypingsIdle();
        const n = unpkg.calls.length;
        expect(await p.ensurePackages([code])).toBe(false);
        p = await bg();
        expect(await p.ensurePackages([code])).toBe(false);
        await p.packageTypingsIdle();
        expect(unpkg.calls.length).toBe(n);
        expect(makePackageLoader(p.packagesSnapshot())("https://unpkg.com/cjs-lib@2.0.0").shout("a")).toBe("A!");
    });

    it("a failed download isn't stored and is retried on the next save", async () => {
        const p = await bg();
        const code = `import x from "https://unpkg.com/esm-lib@1.0.0";`;
        unpkg.setOffline(true);
        await p.ensurePackages([code], { retry: true });
        expect(p.packagesSnapshot().failed).toEqual({ "https://unpkg.com/esm-lib@1.0.0": "download failed (Failed to fetch)" });
        expect(store[PACKAGE_MODULES_KEY]).toBeUndefined();
        const sig = p.packagesSig();
        // a compile (no retry) right after doesn't hammer the network
        const n = unpkg.calls.length;
        await p.ensurePackages([code]);
        expect(unpkg.calls.length).toBe(n);
        unpkg.setOffline(false);
        expect(await p.ensurePackages([code], { retry: true })).toBe(true);
        expect(p.packagesSnapshot().failed).toEqual({});
        expect(p.packagesSig()).not.toBe(sig);
    });

    it("prunes modules and typings no script imports any more", async () => {
        const p = await bg();
        const a = `import x from "https://unpkg.com/esm-lib@1.0.0";`;
        const b = `import x from "https://unpkg.com/cjs-lib@2.0.0";`;
        await p.ensurePackages([a, b]);
        await p.packageTypingsIdle();
        expect(Object.keys(p.packageTypings().tops).sort()).toEqual(["https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/esm-lib@1.0.0"]);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 120_000); // past the guard for just-saved imports
        try {
            await p.prunePackages([a]);
        } finally {
            vi.useRealTimers();
        }
        expect(Object.keys(store[PACKAGE_MODULES_KEY].modules).sort()).toEqual(["https://unpkg.com/esm-lib@1.0.0/index.js", "https://unpkg.com/esm-lib@1.0.0/math.js"]);
        expect(Object.keys(store[PACKAGE_MODULES_KEY].aliases)).toEqual(["https://unpkg.com/esm-lib@1.0.0"]);
        expect(Object.keys(store[PACKAGE_TYPINGS_KEY].tops)).toEqual(["https://unpkg.com/esm-lib@1.0.0"]);
        expect(Object.keys(store[PACKAGE_TYPINGS_KEY].files).every((f) => f.startsWith("unpkg.com/esm-lib@1.0.0/"))).toBe(true);
    });

    it("a prune racing a save keeps what was just ensured", async () => {
        const p = await bg();
        const a = `import x from "https://unpkg.com/esm-lib@1.0.0";`;
        await p.ensurePackages([a]);
        await p.prunePackages([]);
        expect(Object.keys(store[PACKAGE_MODULES_KEY].modules)).toHaveLength(2);
    });
});

describe("package imports in scripts", () => {
    const SCRIPT = `import twice from "https://unpkg.com/esm-lib@1.0.0";
import { shout } from "https://unpkg.com/cjs-lib@2.0.0";
export const run = () => shout(String(twice(21)) + "x");
wt.params({ n: { type: "number", default: twice(2) } });
wt.onRequest("*://a.test/*", () => {});`;

    it("compile and run through the background resolver", async () => {
        const p = await bg();
        await p.ensurePackages([SCRIPT]);
        const c = compileWithLibs({ id: "m", name: "main", code: SCRIPT }, [], {}, [], p.packagesSnapshot());
        expect(c.error).toBeNull();
        expect(c.paramDefs?.n.default).toBe(4);
        expect(c.exports.run()).toBe("42X!");
        expect(c.deps.sort()).toEqual(["https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/esm-lib@1.0.0"]);
    });

    it("a library script's package import works for its importers; each module runs once per registry", async () => {
        const p = await bg();
        const lib = { id: "l", name: "lib/util", code: `import twice from "https://unpkg.com/esm-lib@1.0.0";\nexport const four = twice(2);` };
        const main = { id: "m", name: "main", code: `import { four } from "./lib/util";\nimport twice from "https://unpkg.com/esm-lib@1.0.0";\nexport const same = [four, twice(2)];` };
        await p.ensurePackages([lib.code, main.code]);
        const r = makeModuleResolver([lib, main], () => ({}), { packages: p.packagesSnapshot() });
        const a = r.resolveFrom("main")("https://unpkg.com/esm-lib@1.0.0");
        expect(r.resolveFrom("lib/util")("https://unpkg.com/esm-lib@1.0.0")).toBe(a);
        const c = compileWithLibs(main, [lib], {}, [], p.packagesSnapshot());
        expect(c.error).toBeNull();
        expect(c.exports.same).toEqual([4, 4]);
    });

    it("a bad, missing or failed package URL is the importer's compile error at the import line, never a stub", async () => {
        const p = await bg();
        const at = (code: string, pkgs = p.packagesSnapshot()) => {
            const c = compileWithLibs({ id: "m", name: "main", code }, [], {}, [], pkgs);
            return { error: c.error, line: c.error ? errorPosition(c.error)?.line : undefined };
        };
        const unpinned = at(`// x\n\nimport d from "https://unpkg.com/dayjs";\nwt.onRequest("*://a/*", () => d());`);
        expect(unpinned.error).toMatch(/cannot import "https:\/\/unpkg\.com\/dayjs": pin an exact version, e\.g\. https:\/\/unpkg\.com\/dayjs@1\.2\.3/);
        expect(unpinned.line).toBe(3);
        expect(at(`import d from "https://example.com/x.js";\nd();`).error).toMatch(/only pinned https:\/\/unpkg\.com/);
        expect(at(`\nimport d from "https://unpkg.com/esm-lib@1.0.0";\nd();`)).toEqual({
            error: expect.stringMatching(/not downloaded yet — save the script to download it/),
            line: 2,
        });

        const missing = `\nimport x from "https://unpkg.com/nope@1.0.0";\nwt.onRequest("*://a/*", () => x());`;
        await p.ensurePackages([missing], { retry: true });
        expect(at(missing)).toEqual({ error: expect.stringMatching(/cannot import "https:\/\/unpkg\.com\/nope@1\.0\.0": download failed \(HTTP 404 — no such package, version or file\)/), line: 2 });

        unpkg.setOffline(true);
        const offline = `import x from "https://unpkg.com/umd-lib@1.0.0";\nx();`;
        await p.ensurePackages([offline], { retry: true });
        expect(at(offline).error).toMatch(/cannot import "https:\/\/unpkg\.com\/umd-lib@1\.0\.0": download failed \(Failed to fetch\)/);
    });

    it("the page hook's require resolves package URLs and libraries' nested requires", async () => {
        const p = await bg();
        await p.ensurePackages([SCRIPT]);
        const pkgs = p.packagesSnapshot();
        const libs = [
            ...Object.entries(pkgs.aliases).map(([name, alias]) => ({ name, alias, src: "" })),
            ...[...packageClosure(pkgs, Object.keys(pkgs.aliases))].map((name) => ({ name, pkg: pkgs.modules[name], src: "" })),
            { name: "util", src: "" },
        ];
        const ran: string[] = [];
        const requireFrom = makeLibRequire(libs, (lib, require, m) => {
            ran.push(lib.name);
            m.exports.v = require("https://unpkg.com/esm-lib@1.0.0").default(5);
        });
        expect(requireFrom("main")("https://unpkg.com/cjs-lib@2.0.0").shout("ok")).toBe("OK!");
        expect(requireFrom("main")("./util").v).toBe(10);
        expect(ran).toEqual(["util"]);
        expect(() => requireFrom("main")("https://unpkg.com/other@1.0.0")).toThrow(/not downloaded yet/);
    });
});

describe("package typings", () => {
    async function typingsOf(...urls: string[]) {
        const p = await bg();
        await p.ensurePackages([urls.map((u) => `import "${u}";`).join("\n")]);
        await p.packageTypingsIdle();
        return p.packageTypings();
    }

    it("a package's own types: entry, relative references and a pointer package.json", async () => {
        const t = await typingsOf("https://unpkg.com/esm-lib@1.0.0", "https://unpkg.com/esm-lib@1.0.0/math.js");
        expect(Object.keys(t.files).sort()).toEqual(["unpkg.com/esm-lib@1.0.0/index.d.ts", "unpkg.com/esm-lib@1.0.0/math.d.ts", "unpkg.com/esm-lib@1.0.0/package.json"]);
        expect(JSON.parse(t.files["unpkg.com/esm-lib@1.0.0/package.json"])).toEqual({ name: "esm-lib", version: "1.0.0", types: "./index.d.ts" });
        expect(t.tops["https://unpkg.com/esm-lib@1.0.0/math.js"]).toEqual(["unpkg.com/esm-lib@1.0.0/math.d.ts"]);
        expect(store[PACKAGE_TYPINGS_KEY]).toEqual(t);
    });

    it("`exports` types, a subpath, `/// <reference path>` and a bare type dependency under node_modules", async () => {
        const t = await typingsOf("https://unpkg.com/exp-lib@1.0.0", "https://unpkg.com/exp-lib@1.0.0/sub");
        expect(JSON.parse(t.files["unpkg.com/exp-lib@1.0.0/package.json"]).types).toBe("./dist/index.d.mts");
        expect(t.files["unpkg.com/exp-lib@1.0.0/dist/globals.d.ts"]).toContain("EXP_LIB_GLOBAL");
        expect(JSON.parse(t.files["unpkg.com/exp-lib@1.0.0/sub/package.json"])).toEqual({ types: "../dist/sub.d.ts" });
        // dep-lib "^3.0.0" → 3.1.0, mirrored once, pointed at from node_modules
        expect(t.files["unpkg.com/dep-lib@3.1.0/types.d.ts"]).toContain("interface Dep");
        expect(JSON.parse(t.files["node_modules/dep-lib/package.json"])).toEqual({ name: "dep-lib", version: "3.1.0", types: "../../unpkg.com/dep-lib@3.1.0/types.d.ts" });
    });

    it("no declarations: @types at the same major, else a stub", async () => {
        const t = await typingsOf("https://unpkg.com/cjs-lib@2.0.0", "https://unpkg.com/umd-lib@1.0.0");
        expect(t.files["unpkg.com/@types/cjs-lib@2.0.1/index.d.ts"]).toContain("shout(s: string): string");
        expect(JSON.parse(t.files["unpkg.com/cjs-lib@2.0.0/package.json"]).types).toBe("../@types/cjs-lib@2.0.1/index.d.ts");
        expect(t.files["unpkg.com/umd-lib@1.0.0/index.d.ts"]).toMatch(/no TypeScript declarations[\s\S]*export = mod/);
        expect(JSON.parse(t.files["unpkg.com/umd-lib@1.0.0/package.json"]).types).toBe("./index.d.ts");
    });

    it("typing failures don't fail the download", async () => {
        const p = await bg();
        const real = unpkg.fetch;
        (globalThis as any).fetch = async (u: string) => (/\.d\.|@types/.test(u) ? Promise.reject(new TypeError("Failed to fetch")) : real(u));
        await p.ensurePackages([`import "https://unpkg.com/esm-lib@1.0.0";`]);
        await p.packageTypingsIdle();
        expect(p.packagesSnapshot().failed).toEqual({});
        expect(p.packageTypings().tops).toEqual({});
    });
});
