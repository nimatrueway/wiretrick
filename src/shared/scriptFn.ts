/**
 * Turns user-script source into a callable. The script sees the TangiTweak
 * API as `tt`, plus a CommonJS-ish `require/module/exports` and a shadowed
 * `console`.
 */
import { scriptUrl } from "./scriptError";

export type ScriptFn = (api: any, console: any, require: any, module: any, exports: any) => void;

/** `name` labels the script's stack frames (scriptError.ts) */
export function scriptFunction(js: string, name: string): ScriptFn {
    // body keeps "use strict" on line 1 — stack line offsets rely on it
    return new Function("tt", "console", "require", "module", "exports", `"use strict";\n${js}\n//# sourceURL=${scriptUrl(name)}`) as ScriptFn;
}
