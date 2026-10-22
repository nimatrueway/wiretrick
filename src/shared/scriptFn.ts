/**
 * Turns user-script source into a callable. The script sees the Wiretrick
 * API as `wt`, plus a CommonJS-ish `require/module/exports` and a shadowed
 * `console`.
 */
export type ScriptFn = (api: any, console: any, require: any, module: any, exports: any) => void;

export function scriptFunction(js: string): ScriptFn {
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    return new Function("wt", "console", "require", "module", "exports", `"use strict";\n${js}`) as ScriptFn;
}
