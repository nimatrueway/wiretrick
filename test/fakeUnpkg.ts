// A tiny unpkg.com stand-in for package import tests: exact versions,
// ranges and tags resolve by redirect, a package URL redirects to its
// main file, extensionless paths get `.js` / `/index.js`. REGISTRY holds
// the packages the tests use.

export type Registry = Record<string, Record<string, Record<string, string>>>;

const cmp = (a: string, b: string) => {
    const pa = a.split(/[.-]/).map(Number);
    const pb = b.split(/[.-]/).map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
};

function pickVersion(versions: string[], range: string): string | undefined {
    const sorted = [...versions].sort(cmp);
    if (range === "latest" || range === "*") return sorted.slice(-1)[0];
    if (versions.includes(range)) return range;
    const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    if (caret) return sorted.filter((v) => v.split(".")[0] === caret[1] && cmp(v, range.slice(1)) >= 0).slice(-1)[0];
    if (/^\d+$/.test(range)) return sorted.filter((v) => v.split(".")[0] === range).slice(-1)[0];
    return undefined;
}

export function fakeUnpkg(registry: Registry) {
    const calls: string[] = [];
    let offline = false;
    const respond = (status: number, url: string, body = "", type = "text/plain") => ({
        ok: status >= 200 && status < 300,
        status,
        url,
        headers: new Headers({ "content-type": type }),
        text: async () => body,
    });
    const fetch = async (input: string) => {
        calls.push(input);
        if (offline) throw new TypeError("Failed to fetch");
        const url = new URL(input);
        if (url.origin !== "https://unpkg.com") return respond(404, input);
        const m = /^\/((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(url.pathname);
        if (!m) return respond(404, input);
        const [, name, rawRange = "latest", rest = ""] = m;
        const pkg = registry[name];
        const version = pkg && pickVersion(Object.keys(pkg), decodeURIComponent(rawRange));
        if (!version) return respond(404, input, `Not found: ${url.pathname}`);
        const files = pkg[version];
        let path = rest;
        if (!path) path = JSON.parse(files["package.json"] ?? "{}").main ?? "index.js";
        path = path.replace(/^\.\//, "");
        if (!(path in files)) path = [`${path}.js`, `${path}/index.js`].find((p) => p in files) ?? path;
        if (!(path in files)) return respond(404, input, `Not found: ${url.pathname}`);
        const final = `https://unpkg.com/${name}@${version}/${path}`;
        const type = /\.d\.[mc]?ts$/.test(path) ? "text/typescript" : path.endsWith(".json") ? "application/json" : "application/javascript";
        return respond(200, final, files[path], type);
    };
    return {
        fetch,
        calls,
        setOffline: (v: boolean) => void (offline = v),
    };
}

const pj = (o: object) => JSON.stringify(o);

/** test packages: ESM, CJS with a dependency range, UMD, built-ins, failures, cycles, JSON, `exports`, @types */
export const REGISTRY: Registry = {
    "esm-lib": {
        "1.0.0": {
            "package.json": pj({ name: "esm-lib", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
            "index.js": `import { add } from "./math.js";\nexport default function twice(x) { return add(x, x); }\nexport { add };\nexport const where = import.meta.url;\n`,
            "math.js": `export const add = (a, b) => a + b;\n`,
            "index.d.ts": `import { add } from "./math";\nexport default function twice(x: number): number;\nexport { add };\nexport declare const where: string;\n`,
            "math.d.ts": `export declare const add: (a: number, b: number) => number;\n`,
        },
    },
    "cjs-lib": {
        "2.0.0": {
            "package.json": pj({ name: "cjs-lib", version: "2.0.0", main: "lib/index.js", dependencies: { "dep-lib": "^3.0.0" } }),
            "lib/index.js": `"use strict";\nvar dep = require("dep-lib");\nvar sub = require("dep-lib/extra");\nexports.shout = function (s) { return dep.upper(s) + sub.bang; };\n`,
        },
    },
    "@types/cjs-lib": {
        "2.0.1": { "package.json": pj({ name: "@types/cjs-lib", version: "2.0.1", types: "index.d.ts" }), "index.d.ts": `export declare function shout(s: string): string;\n` },
        "3.0.0": { "package.json": pj({ name: "@types/cjs-lib", version: "3.0.0", types: "index.d.ts" }), "index.d.ts": `export declare function shout(s: string): number;\n` },
    },
    "dep-lib": {
        "3.0.0": { "package.json": pj({ name: "dep-lib", version: "3.0.0" }), "index.js": `exports.upper = (s) => s;\n` },
        "3.1.0": {
            "package.json": pj({ name: "dep-lib", version: "3.1.0", types: "types.d.ts" }),
            "index.js": `exports.upper = (s) => s.toUpperCase();\n`,
            "extra.js": `exports.bang = "!";\n`,
            "types.d.ts": `export interface Dep { upper(s: string): string }\nexport declare const upper: (s: string) => string;\n`,
        },
        "4.0.0": { "package.json": pj({ name: "dep-lib", version: "4.0.0" }), "index.js": `exports.upper = () => "v4";\n` },
    },
    "umd-lib": {
        "1.0.0": {
            "package.json": pj({ name: "umd-lib", version: "1.0.0", main: "umd.js" }),
            "umd.js": `(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.umdLib = factory(root);
})(this, function (root) {
  wtUmdSloppyGlobal = 1; // sloppy mode: an undeclared assignment
  var self = (function () { return this; })();
  return { rootIsExports: root !== undefined && typeof root === "object", sloppy: self === globalThis, nodeEnv: process.env.NODE_ENV };
});
`,
        },
    },
    "builtin-lib": {
        "1.0.0": {
            "package.json": pj({ name: "builtin-lib", version: "1.0.0" }),
            "index.js": `var fs = null;\ntry { fs = require("fs"); } catch (e) { exports.err = e.message; }\ntry { require("node:path"); } catch (e) { exports.err2 = e.message; }\nexports.ok = true;\n`,
        },
    },
    "nested-fail": {
        "1.0.0": {
            "package.json": pj({ name: "nested-fail", version: "1.0.0" }),
            "index.js": `try { require("./missing.js"); } catch (e) { exports.err = e.message; }\nexports.ok = 1;\n`,
        },
    },
    "cycle-lib": {
        "1.0.0": {
            "package.json": pj({ name: "cycle-lib", version: "1.0.0" }),
            "index.js": `exports.a = 1;\nvar b = require("./b");\nexports.fromB = b.sawA;\n`,
            "b.js": `var idx = require("./index.js");\nexports.sawA = idx.a;\n`,
        },
    },
    "json-lib": {
        "1.0.0": { "package.json": pj({ name: "json-lib", version: "1.0.0" }), "index.js": `module.exports = require("./data.json").n;\n`, "data.json": `{ "n": 5 }` },
    },
    "exp-lib": {
        "1.0.0": {
            "package.json": pj({
                name: "exp-lib",
                version: "1.0.0",
                main: "dist/index.mjs",
                dependencies: { "dep-lib": "^3.0.0" },
                exports: { ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" } }, "./sub": { types: "./dist/sub.d.ts", default: "./dist/sub.js" } },
            }),
            "dist/index.mjs": `export function go() { return { upper: (s) => s }; }\n`,
            "dist/index.d.mts": `import type { Dep } from "dep-lib";\nexport declare function go(): Dep;\n`,
            "dist/sub.js": `exports.sub = 1;\n`,
            "sub.js": `module.exports = require("./dist/sub.js");\n`,
            "dist/sub.d.ts": `/// <reference path="./globals.d.ts" />\nexport declare const sub: number;\n`,
            "dist/globals.d.ts": `declare const EXP_LIB_GLOBAL: string;\n`,
        },
    },
};
