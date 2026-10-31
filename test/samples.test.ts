import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { SAMPLES, sampleStrategies, sampleSummary, sampleTryUrl } from "../src/ui/samples";

describe("bundled samples", () => {
    for (const s of SAMPLES) {
        it(`${s.name}: compiles, names a page to try and needs no helper`, () => {
            expect(compileScript(s.code).error).toBeNull();
            expect(sampleTryUrl(s.code)).toMatch(/^https:\/\/[^\s]+$/);
            const strategies = sampleStrategies(s.code);
            expect(strategies.length).toBeGreaterThan(0);
            expect(strategies).not.toContain("helper");
            expect(sampleSummary(s.blurb)).not.toMatch(/Try it/);
        });
    }
});

describe("sample helpers", () => {
    it("reads the Try it URL", () => {
        expect(sampleTryUrl(`// Try it: open https://example.com/a?b=1 and reload\nwt.about("x");`)).toBe("https://example.com/a?b=1");
        expect(sampleTryUrl(`wt.about("x");`)).toBeNull();
    });
    it("lists the strategies routes name, both branches of a ternary", () => {
        expect(sampleStrategies(`wt.onRequest({ url: "*://a/*", strategy: "rules" }, f);`)).toEqual(["rules"]);
        expect(sampleStrategies(`wt.onResponseBody({ url: "*://a/*", strategy: wt.isFirefox ? "extension" : "debugger" }, f);`)).toEqual(["debugger", "extension"]);
        expect(sampleStrategies(`wt.onDocument("*://a/*", () => {});`)).toEqual(["onDocument"]);
    });
    it("drops the Try it sentence from the blurb", () => {
        expect(sampleSummary("Send any request elsewhere. Try it: open a.com — b.")).toBe("Send any request elsewhere.");
    });
});
