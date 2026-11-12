/**
 * `tt.isChrome` / `tt.isFirefox` / `tt.isMV2` / `tt.isMV3`: which browser
 * and extension build a script runs in; `tt.isMac` / `tt.isWindows` /
 * `tt.isLinux`: which desktop OS (none of them on Android or ChromeOS). MV2/MV3 is the build (dist vs
 * dist-mv3). The browser comes from the extension API where one is visible
 * (background); sandboxed and page contexts fall back to the user agent.
 * MV3 builds are Chromium-only.
 */
export interface ScriptEnv {
    readonly isChrome: boolean;
    readonly isFirefox: boolean;
    readonly isMV2: boolean;
    readonly isMV3: boolean;
    readonly isMac: boolean;
    readonly isWindows: boolean;
    readonly isLinux: boolean;
}

export type Os = "mac" | "windows" | "linux" | "other";

/** the desktop OS from `navigator.platform` (the user agent when it's empty); Android and ChromeOS report Linux there */
export function detectOs(nav: { platform?: string; userAgent?: string } = globalThis.navigator ?? {}): Os {
    const ua = nav.userAgent || "";
    if (/Android|CrOS/.test(ua)) return "other";
    const p = nav.platform || ua;
    if (/Mac/.test(p)) return "mac";
    if (/^Win|Windows/.test(p)) return "windows";
    if (/Linux/.test(p)) return "linux";
    return "other";
}

// read when the runtime loads: in the site's world, before the site could change `navigator`
const OS = detectOs();

export function detectFirefox(g: any = globalThis): boolean {
    // Firefox exposes `browser` (and `chrome`) to extension pages; Chromium only `chrome`
    if (g.browser?.runtime?.getURL) return true;
    if (g.chrome?.runtime?.id) return false;
    return /\bFirefox\//.test(g.navigator?.userAgent || "");
}

export function scriptEnv(mv3: boolean = __MV3__, firefox: boolean = !mv3 && detectFirefox(), os: Os = OS): ScriptEnv {
    return { isChrome: !firefox, isFirefox: firefox, isMV2: !mv3, isMV3: mv3, isMac: os === "mac", isWindows: os === "windows", isLinux: os === "linux" };
}
