/**
 * `wt.isChrome` / `wt.isFirefox` / `wt.isMV2` / `wt.isMV3`: which browser
 * and extension build a script runs in. MV2/MV3 is the build (dist vs
 * dist-mv3). The browser comes from the extension API where one is visible
 * (background); sandboxed and page contexts fall back to the user agent.
 * MV3 builds are Chromium-only.
 */
export interface ScriptEnv {
    readonly isChrome: boolean;
    readonly isFirefox: boolean;
    readonly isMV2: boolean;
    readonly isMV3: boolean;
}

export function detectFirefox(g: any = globalThis): boolean {
    // Firefox exposes `browser` (and `chrome`) to extension pages; Chromium only `chrome`
    if (g.browser?.runtime?.getURL) return true;
    if (g.chrome?.runtime?.id) return false;
    return /\bFirefox\//.test(g.navigator?.userAgent || "");
}

export function scriptEnv(mv3: boolean = __MV3__, firefox: boolean = !mv3 && detectFirefox()): ScriptEnv {
    return { isChrome: !firefox, isFirefox: firefox, isMV2: !mv3, isMV3: mv3 };
}
