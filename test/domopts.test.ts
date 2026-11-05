import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";

// jsdom-ish document stub for the hook-independent compile check
function makeHookScaffold() {
    const logUp: [string, string][] = [];
    let domHandler: any = null;
    let domOpts: any = null;
    const shim = {
        onPage: (fn: any, o: any) => { domHandler = fn; domOpts = o || {}; },
        log: () => {},
    };
    return { logUp, get domHandler() { return domHandler; }, get domOpts() { return domOpts; }, shim };
}

describe("wt.onPage options", () => {
    it("captures handler + options", () => {
        const c = compileScript(`wt.onPage({ url: "*", when: "document_idle" }, () => {});\nwt.onPage("*://x.com/*", () => {});`);
        expect(c.error).toBeNull();
        expect(c.handlers.onDocument.length).toBe(2);
        expect(c.handlers.onDocument[0].route.when).toBe("document_idle");
    });

    it("defaults: when = document_end", () => {
        const c = compileScript(`wt.onPage("*", () => {});`);
        expect(c.handlers.onDocument[0]?.route.when).toBe("document_end");
    });
});
