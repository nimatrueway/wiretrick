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

describe("wt.onDom options", () => {
    it("captures handler + options", () => {
        const c = compileScript(`wt.declareScript({ match: ["*"] });\nres.onDom(() => {}, { when: "document_idle" });`);
        expect(c.error).toBeNull();
        expect(c.handlers.onDom.length).toBe(1);
        expect(c.handlers.onDom[0].when).toBe("document_idle");
    });

    it("defaults: no options → {}", () => {
        const c = compileScript(`wt.declareScript({ match: ["*"] });\nres.onDom(() => {});`);
        expect(c.handlers.onDom[0]?.when).toBe("DOMContentLoaded");
    });
});
