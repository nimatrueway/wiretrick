import { describe, it, expect } from "vitest";
import { bundleEntry } from "../src/shared/bundler";

const libs: Record<string, string> = {
    "lib/flags.ts": `export function addFlag(json: string): string {
    const j = JSON.parse(json);
    j.featureFlags.groupEnabledFeatureFlags.push("LIB_FLAG");
    return JSON.stringify(j);
}

export const VERSION: number = 2;`,
    "lib/deep/nested.ts": `import { VERSION } from "../flags";
export function doubled(): number { return VERSION * 2; }`,
};

const lookup = (id: string) => (id in libs ? libs[id] : null);

describe("bundleEntry", () => {
    it("inlines a named import and preserves the res handler", async () => {
        const entry = `import { addFlag } from "./lib/flags";
res.modifyResponse((ctx, body) => addFlag(typeof body === "string" ? body : new TextDecoder().decode(body)));`;
        const b = await bundleEntry(entry, lookup);
        expect(b.error).toBeNull();
        expect(b.deps).toEqual(["lib/flags.ts"]);

        // execute the bundle: register handler on a shim, run it
        let handler: any = null;
        const shim = { modifyResponse: (f: any) => (handler = f), log: () => {} };
        // eslint-disable-next-line no-new-func
        new Function("res", `"use strict";\n${b.code}`)(shim);
        const out = await handler({}, JSON.stringify({ featureFlags: { groupEnabledFeatureFlags: [] } }));
        expect(JSON.parse(out).featureFlags.groupEnabledFeatureFlags).toEqual(["LIB_FLAG"]);
    });

    it("resolves nested relative imports between lib modules", async () => {
        const entry = `import { doubled } from "./lib/deep/nested";
res.onRequest(() => { res.log("doubled", doubled()); });`;
        const b = await bundleEntry(entry, lookup);
        expect(b.error).toBeNull();
        expect(b.deps).toContain("lib/deep/nested.ts");
        expect(b.deps).toContain("lib/flags.ts");

        const logs: string[] = [];
        const shim = { onRequest: (f: any) => f({ url: "x" }), log: (...a: any[]) => logs.push(a.join(" ")) };
        // eslint-disable-next-line no-new-func
        new Function("res", `"use strict";\n${b.code}`)(shim);
        expect(logs.join(" ")).toContain("4");
    });

    it("probes extensions and index files", async () => {
        const lib: Record<string, string> = { "lib/util/index.ts": "export const x = 1;" };
        const b = await bundleEntry(`import { x } from "./lib/util";\nres.onRequest(() => { res.log("x", x); });`, (id) => (id in lib ? lib[id] : null));
        expect(b.error).toBeNull();
        expect(b.deps).toEqual(["lib/util/index.ts"]);
    });

    it("unresolved imports produce a clear error and runtime stub", async () => {
        const b = await bundleEntry(`import { nope } from "./lib/nope";\nres.onRequest(() => nope());`, lookup);
        expect(b.error).toContain("unresolved import './lib/nope'");
        expect(b.code).toContain("cannot resolve import");
    });

    it("entry without imports passes through as transpiled code", async () => {
        const entry = `const n: number = 1;\nres.onRequest(() => { res.log("n", n); });`;
        const b = await bundleEntry(entry, lookup);
        expect(b.error).toBeNull();
        expect(b.deps).toEqual([]);
        expect(b.code).not.toContain(": number");
    });
});
