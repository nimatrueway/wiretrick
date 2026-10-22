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
        const c = compileScript(`wt.onDom({ url: "*", when: "document_idle" }, () => {});\nwt.onDom("*://x.com/*", () => {});`);
        expect(c.error).toBeNull();
        expect(c.handlers.onDom.length).toBe(2);
        expect(c.handlers.onDom[0].route.when).toBe("document_idle");
    });

    it("defaults: when = DOMContentLoaded", () => {
        const c = compileScript(`wt.onDom("*", () => {});`);
        expect(c.handlers.onDom[0]?.route.when).toBe("DOMContentLoaded");
    });
});
