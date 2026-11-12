/**
 * The built-in modules onSite code gets (hook.ts; bridge.ts when the page
 * CSP blocks eval): valtio's core — the same copy its `tt.siteStore`s
 * use, so `subscribe` and `snapshot` work on them — and no React.
 */
import * as vanilla from "valtio/vanilla";
import { pageBuiltin } from "./scriptImports";

export function siteBuiltin(spec: string): any {
    if (spec === "valtio/vanilla") return vanilla;
    if (spec === "valtio") {
        const noReact = (fn: string) => () => {
            throw new Error(`valtio's ${fn} needs React, which onSite code doesn't have — use subscribe() and snapshot(), or read the store in onPage or onOverlay code`);
        };
        return { ...vanilla, useSnapshot: noReact("useSnapshot"), useProxy: noReact("useProxy") };
    }
    return pageBuiltin(spec);
}
