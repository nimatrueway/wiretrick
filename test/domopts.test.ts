import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";

// jsdom-ish document stub for the hook-independent compile check
function makeHookScaffold() {
    const logUp: [string, string][] = [];
    let domHandler: any = null;
    let domOpts: any = null;
    const shim = {
        onDocument: (fn: any, o: any) => { domHandler = fn; domOpts = o || {}; },
        log: () => {},
    };
    return { logUp, get domHandler() { return domHandler; }, get domOpts() { return domOpts; }, shim };
}

describe("wt.onDocument options", () => {
    it("captures handler + options", () => {
        const c = compileScript(`wt.onDocument({ url: "*", when: "document_idle" }, () => {});\nwt.onDocument("*://x.com/*", () => {});`);
        expect(c.error).toBeNull();
        expect(c.handlers.onDocument.length).toBe(2);
        expect(c.handlers.onDocument[0].route.when).toBe("document_idle");
    });

    it("defaults: when = document_end", () => {
        const c = compileScript(`wt.onDocument("*", () => {});`);
        expect(c.handlers.onDocument[0]?.route.when).toBe("document_end");
    });
});
