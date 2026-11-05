/**
 * Turns user-script source into a callable. The script sees the Wiretrick
 * API as `wt`, plus a CommonJS-ish `require/module/exports` and a shadowed
 * `console` (and, `withDocument`, a shadowed `document`: the page-world
 * overlay's own).
 */
export type ScriptFn = (api: any, console: any, require: any, module: any, exports: any, document?: Document) => void;

export function scriptFunction(js: string, withDocument = false): ScriptFn {
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    const params = ["wt", "console", "require", "module", "exports", ...(withDocument ? ["document"] : [])];
    return new Function(...params, `"use strict";\n${js}`) as ScriptFn;
}
