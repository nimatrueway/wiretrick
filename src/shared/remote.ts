/**
 * Handles returned by `wt.onPage` / `wt.onOverlay`: the other side's
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

export const REMOTE_FROM_BACKGROUND = "page/overlay functions can only be called from this script's overlay or isolated-world onPage code, not from network handlers";
export const REMOTE_MAIN_WORLD = 'page-world onPage code can\'t call the overlay; run it in the isolated world (the default: drop js: "page") and read the page with ctx.evaluate';
/** in every warning about page-world onPage code using what only the isolated world may (the editor offers the isolated-world quick fix) */
export const MAIN_WORLD_DISALLOWED = "which the API explicitly disallows in the page world";
export const REMOTE_PAGE_LAYER = 'a js: "page" overlay runs as page code, so it exposes no functions (the page could fake their answers) — use the default js: "isolated" to call it';
export const REMOTE_OVERLAY_SELF = "the overlay can't call its own overlay handles — call the functions directly";
