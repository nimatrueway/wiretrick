/**
 * Chrome MV3: onSite code reaches the page's world through
 * `chrome.userScripts` registrations (world MAIN, background/userScripts.ts),
 * not as strings the hook evaluates — the Chrome Web Store allows running
 * code that isn't in the package only through the userScripts and debugger
 * APIs. Each unit (a script, a library script it imports, a package module)
 * is its own source: a function expression pushed onto a queue on the
 * page's global (`Symbol.for(SITE_QUEUE)`), which the hook drains and then
 * replaces (either may run first). The hook finds a unit by the key the
 * page bundle names (`fk`): its name and a hash of its code.
 */
import { contentHash } from "./folderSync";
import { scriptUrl } from "./scriptError";

export const SITE_QUEUE = "tangitweak.site";

/** a package module's function: runs with `this` = `module.exports`, sloppy mode */
export type PackageFn = (require: (spec: string) => any, module: { exports: any }, exports: any, process: any, global: any, style: (css: string, url: string) => void) => void;

const hashes = new Map<string, string>();
/** a unit's key: its name and a hash of its code */
export function siteKey(name: string, js: string): string {
    let h = hashes.get(js);
    if (h === undefined) {
        if (hashes.size > 500) hashes.clear();
        hashes.set(js, (h = contentHash(js)));
    }
    return `${name}\0${h}`;
}

const push = (key: string, params: string) => `(globalThis[Symbol.for(${JSON.stringify(SITE_QUEUE)})] ||= []).push([${JSON.stringify(key)}, function (${params}) {`;

/**
 * A script's or library script's unit. The user's line 1 is line 4, as in
 * scriptFunction (EVAL_WRAPPER_LINES), so error positions map the same way.
 */
export function scriptUnit(name: string, js: string): string {
    return `${push(siteKey(name, js), "tt, console, require, module, exports")}\n\n"use strict";\n${js}\n}]);\n//# sourceURL=${scriptUrl(name)}`;
}

/** a package module's unit (`url`: its final URL) */
export function packageUnit(url: string, js: string): string {
    return `${push(siteKey(url, js), "require, module, exports, process, global, __ttStyle")}\n${js}\n}]);\n//# sourceURL=${url}`;
}

/**
 * The hook's side: the units that arrived (and arrive later — `onUnit`
 * runs after each push). The first unit with a key wins.
 */
export function siteUnits(onUnit: () => void, g: any = globalThis): { get(key: string): Function | undefined } {
    const units = new Map<string, Function>();
    const sym = Symbol.for(SITE_QUEUE);
    const take = (u: any) => {
        if (Array.isArray(u) && typeof u[0] === "string" && typeof u[1] === "function" && !units.has(u[0])) units.set(u[0], u[1]);
    };
    const early = g[sym];
    if (Array.isArray(early)) early.forEach(take);
    const queue = {
        push(...us: any[]): number {
            us.forEach(take);
            onUnit();
            return units.size;
        },
    };
    try {
        Object.defineProperty(g, sym, { value: queue, configurable: false, writable: false, enumerable: false });
    } catch {}
    return { get: (key) => units.get(key) };
}
