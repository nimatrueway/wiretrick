import { describe, it, expect } from "vitest";
import { compileScript } from "../src/shared/compile";
import { makePageShim } from "../src/shared/pageShim";
import { detectFirefox, detectOs, scriptEnv } from "../src/shared/scriptEnv";

describe("wt.isChrome / isFirefox / isMV2 / isMV3 / isMac / isWindows / isLinux", () => {
    it("detects the desktop OS from navigator.platform, then the user agent; Android and ChromeOS are none", () => {
        expect(detectOs({ platform: "MacIntel" })).toBe("mac");
        expect(detectOs({ platform: "Win32" })).toBe("windows");
        expect(detectOs({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0" })).toBe("linux");
        expect(detectOs({ platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0" })).toBe("windows");
        expect(detectOs({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0" })).toBe("mac");
        expect(detectOs({ platform: "Linux armv8l", userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0" })).toBe("other");
        expect(detectOs({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/130.0.0.0" })).toBe("other");
        expect(detectOs({})).toBe("other");
    });

    it("detects the browser from the extension API, then the user agent", () => {
        expect(detectFirefox({ browser: { runtime: { getURL: () => "" } }, chrome: { runtime: { id: "x" } } })).toBe(true);
        expect(detectFirefox({ chrome: { runtime: { id: "x" } } })).toBe(false);
        expect(detectFirefox({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0" } })).toBe(true);
        expect(detectFirefox({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" } })).toBe(false);
    });

    it("pairs are opposites; MV3 builds are Chromium-only", () => {
        expect(scriptEnv(false, true, "linux")).toEqual({ isChrome: false, isFirefox: true, isMV2: true, isMV3: false, isMac: false, isWindows: false, isLinux: true });
        expect(scriptEnv(true, false, "mac")).toEqual({ isChrome: true, isFirefox: false, isMV2: false, isMV3: true, isMac: true, isWindows: false, isLinux: false });
    });

    it("scripts see them on wt (background compile and page shim)", () => {
        const c = compileScript(`wt.metadata({ description: [wt.isChrome, wt.isFirefox, wt.isMV2, wt.isMV3].join(",") });`);
        expect(c.error).toBeFalsy();
        expect(c.meta.description).toBe("true,false,true,false"); // vitest: MV2 build, not Firefox
        const { wt } = makePageShim({ params: {}, log: () => {}, storage: { get: () => undefined, set: () => undefined } });
        expect([wt.isChrome, wt.isFirefox, wt.isMV2, wt.isMV3]).toEqual([true, false, true, false]);
        const os = [wt.isMac, wt.isWindows, wt.isLinux];
        expect(os.filter(Boolean).length).toBe(["mac", "windows", "linux"].includes(detectOs()) ? 1 : 0);
        const c2 = compileScript(`wt.metadata({ description: [wt.isMac, wt.isWindows, wt.isLinux].join(",") });`);
        expect(c2.meta.description).toBe(os.join(","));
    });

    it("can pick a route's strategy", () => {
        const c = compileScript(`wt.onRequest({ url: "*://a.com/*", strategy: wt.isFirefox ? "extension" : "debugger" }, () => {});`);
        expect(c.meta.routes[0].strategy).toBe("debugger");
    });
});
