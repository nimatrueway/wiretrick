import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";

// jsdom-ish document stub for the hook-independent compile check
function makeHookScaffold() {
    const logUp: [string, string][] = [];
    let domHandler: any = null;
    let domOpts: any = null;
    const shim = {
        onDom: (fn: any, o: any) => { domHandler = fn; domOpts = o || {}; },
        log: () => {},
    };
    return { logUp, get domHandler() { return domHandler; }, get domOpts() { return domOpts; }, shim };
}

describe("res.onDom options", () => {
    it("captures handler + options", () => {
        const c = compileScript(`// @match *\nres.onDom(() => {}, { watch: true, watchInterval: 400, maxRuns: 10 });`);
        expect(c.error).toBeNull();
        expect(c.handlers.onDom).toBeTruthy();
        expect(c.handlers.onDomOptions).toEqual({ watch: true, watchInterval: 400, maxRuns: 10 });
    });

    it("defaults: no options → {}", () => {
        const c = compileScript(`// @match *\nres.onDom(() => {});`);
        expect(c.handlers.onDomOptions).toEqual({});
    });
});
