/**
 * Handles returned by `wt.onPage`: the other side's
 * functions as async calls (`await page.highlight("a")`). Where a call
 * can't go anywhere (background code, or a world that may not call), the
 * handle is inert: every method rejects with the reason. Live handles are
 * `RpcClient.remote` (shared/rpc.ts).
 */
import { WtCallError } from "./rpc";

/** a handle whose every method rejects with `reason` (`onCall` sees each error, thrown at the call site) */
export function inertRemote(reason: string, onCall?: (e: WtCallError) => void): any {
    return new Proxy(Object.create(null), {
        get(_t, prop) {
            // not a thenable (`await handle` must not hang), no symbol methods
            if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
            return () => {
                const e = new WtCallError(reason);
                onCall?.(e);
                return Promise.reject(e);
            };
        },
        set() {
            return false;
        },
    });
}

export const REMOTE_FROM_BACKGROUND = "onPage handles can't be called from network handlers: an onPage handler's functions are called from this script's overlay, an overlay's from its isolated-world onPage code";
/** an isolated onPage handle used in isolated onPage code (it may call js: "page" handles only) */
export const REMOTE_PAGE_FROM_ISOLATED =
    "isolated onPage code can call js: \"page\" handlers' functions, not another isolated handler's (those are for the overlay) — share the functions in the script directly";
export const REMOTE_PAGE_FROM_PAGE = "an onPage handler's functions are called from this script's overlay, not from onPage code — page-world code can call them directly";
export const REMOTE_MAIN_WORLD =
    'page-world onPage code can\'t call the overlay; run it in the isolated world (the default: drop js: "page") and read the page with ctx.evaluate — or, accepting that the page can then call the overlay too, add unsafe: true to its js: "page" routes';
/** in every warning about page-world onPage code using what only the isolated world may (the editor offers the isolated-world quick fix) */
export const MAIN_WORLD_DISALLOWED = "which the API explicitly disallows in the page world";
export const REMOTE_PAGE_LAYER = 'a js: "page" overlay runs as page code, so it exposes no functions (the page could fake their answers) — use the default js: "isolated" to call it';
export const REMOTE_OVERLAY_SELF = "the overlay can't call its own overlay handles — call the functions directly";
