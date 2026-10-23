import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { makePageShim } from "../src/shared/pageShim";
import { detectFirefox, scriptEnv } from "../src/shared/scriptEnv";

describe("wt.isChrome / isFirefox / isMV2 / isMV3", () => {
    it("detects the browser from the extension API, then the user agent", () => {
        expect(detectFirefox({ browser: { runtime: { getURL: () => "" } }, chrome: { runtime: { id: "x" } } })).toBe(true);
        expect(detectFirefox({ chrome: { runtime: { id: "x" } } })).toBe(false);
        expect(detectFirefox({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0" } })).toBe(true);
        expect(detectFirefox({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" } })).toBe(false);
    });

    it("pairs are opposites; MV3 builds are Chromium-only", () => {
        expect(scriptEnv(false, true)).toEqual({ isChrome: false, isFirefox: true, isMV2: true, isMV3: false });
        expect(scriptEnv(true)).toEqual({ isChrome: true, isFirefox: false, isMV2: false, isMV3: true });
    });

    it("scripts see them on wt (background compile and page shim)", () => {
        const c = compileScript(`wt.about([wt.isChrome, wt.isFirefox, wt.isMV2, wt.isMV3].join(","));`);
        expect(c.error).toBeFalsy();
        expect(c.meta.description).toBe("true,false,true,false"); // vitest: MV2 build, not Firefox
        const { wt } = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined } });
        expect([wt.isChrome, wt.isFirefox, wt.isMV2, wt.isMV3]).toEqual([true, false, true, false]);
    });

    it("can pick a route's strategy", () => {
        const c = compileScript(`wt.onRequest({ url: "*://a.com/*", strategy: wt.isFirefox ? "webRequest" : "debugger" }, () => {});`);
        expect(c.meta.routes[0].strategy).toBe("debugger");
    });
});
