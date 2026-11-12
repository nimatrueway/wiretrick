import { describe, it, expect, vi } from "vitest";
import { SITE_QUEUE, packageUnit, scriptUnit, siteKey, siteUnits } from "../src/shared/siteCode";
import { EVAL_WRAPPER_LINES } from "../src/shared/scriptError";

/** runs a unit's source with `globalThis` = `g` */
const run = (unit: string, g: any) => new Function("globalThis", unit)(g);

describe("onSite units (Chrome MV3 userScripts in the MAIN world)", () => {
    it("a script unit keeps the user's line 1 at EVAL_WRAPPER_LINES + 1 and runs strict", () => {
        const js = 'exports.x = tt + 1;\nexports.strict = this === undefined;';
        const u = scriptUnit("hello.ts", js);
        expect(u.split("\n").indexOf("exports.x = tt + 1;")).toBe(EVAL_WRAPPER_LINES);
        expect(u).toMatch(/\/\/# sourceURL=\S+$/);
        const g: any = {};
        run(u, g);
        const [[key, fn]] = g[Symbol.for(SITE_QUEUE)];
        expect(key).toBe(siteKey("hello.ts", js));
        const exports: any = {};
        fn.call(undefined, 1, console, null, { exports }, exports);
        expect(exports).toEqual({ x: 2, strict: true });
    });

    it("a package unit runs sloppy with the CommonJS parameters", () => {
        const g: any = {};
        run(packageUnit("https://unpkg.com/p@1/index.js", "module.exports = typeof __ttStyle + typeof global;"), g);
        const [[key, fn]] = g[Symbol.for(SITE_QUEUE)];
        expect(key).toBe(siteKey("https://unpkg.com/p@1/index.js", "module.exports = typeof __ttStyle + typeof global;"));
        const module: any = { exports: {} };
        fn(null, module, module.exports, {}, g, () => {});
        expect(module.exports).toBe("functionobject");
    });

    it("keys change with the code, not just the name", () => {
        expect(siteKey("a.ts", "1")).toBe(siteKey("a.ts", "1"));
        expect(siteKey("a.ts", "1")).not.toBe(siteKey("a.ts", "2"));
        expect(siteKey("a.ts", "1")).not.toBe(siteKey("b.ts", "1"));
    });

    it("the hook takes units pushed before and after it starts; the first unit with a key wins", () => {
        const g: any = {};
        run(scriptUnit("a.ts", "exports.v = 'early'"), g);
        const onUnit = vi.fn();
        const units = siteUnits(onUnit, g);
        expect(units.get(siteKey("a.ts", "exports.v = 'early'"))).toBeTypeOf("function");
        expect(onUnit).not.toHaveBeenCalled();
        run(scriptUnit("b.ts", "exports.v = 'late'"), g);
        expect(onUnit).toHaveBeenCalledTimes(1);
        expect(units.get(siteKey("b.ts", "exports.v = 'late'"))).toBeTypeOf("function");
        const first = units.get(siteKey("b.ts", "exports.v = 'late'"));
        g[Symbol.for(SITE_QUEUE)].push([siteKey("b.ts", "exports.v = 'late'"), () => "forged"]);
        expect(units.get(siteKey("b.ts", "exports.v = 'late'"))).toBe(first);
        // the queue can't be replaced
        expect(() => {
            "use strict";
            g[Symbol.for(SITE_QUEUE)] = [];
        }).toThrow();
        expect(units.get("missing")).toBeUndefined();
    });
});
