/**
 * Turns user-script source into a callable. The script sees the Wiretrick
 * API as `wt`, plus a CommonJS-ish `require/module/exports` and a shadowed
 * `console`. Scripts written for v0.0.1 used `res` — they get it bound as
 * a legacy alias, but only when they actually call `res.<api>` (binding it
 * unconditionally would break scripts that declare their own `res`).
 */
export type ScriptFn = (api: any, console: any, require: any, module: any, exports: any) => void;

const LEGACY_API = /\bres\s*\.\s*(declareScript|onRequest|onResponseHeaders|modifyResponse|replaceResponse|onDom|log|storage)\b/;

export function usesLegacyApi(src: string): boolean {
    return LEGACY_API.test(src);
}

export function scriptFunction(js: string): ScriptFn {
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    const body = `"use strict";\n${js}`;
    if (!usesLegacyApi(js)) return new Function("wt", "console", "require", "module", "exports", body) as ScriptFn;
    const fn = new Function("wt", "console", "require", "module", "exports", "res", body);
    return (api, c, r, m, e) => fn(api, c, r, m, e, api);
}
