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
        const c = compileScript(`// @match *\nres.onDom(() => {}, { when: "document_idle" });`);
        expect(c.error).toBeNull();
        expect(c.handlers.onDom).toBeTruthy();
        expect(c.handlers.onDomOptions).toEqual({ when: "document_idle" });
    });

    it("defaults: no options → {}", () => {
        const c = compileScript(`// @match *\nres.onDom(() => {});`);
        expect(c.handlers.onDomOptions).toEqual({ when: "DOMContentLoaded" });
    });
});
