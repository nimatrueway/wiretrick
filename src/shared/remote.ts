/**
 * Handles returned by `wt.onPage` / `wt.onOverlay`: the other side's
 * functions as async calls (`await page.highlight("a")`). Where a call
 * can't go anywhere (background code, or a world that may not call), the
 * handle is inert: every method rejects with the reason. Live handles are
 * `RpcClient.remote` (shared/rpc.ts).
 */
import { WtCallError } from "./rpc";

/** a handle whose every method rejects with `reason` */
export function inertRemote(reason: string): any {
    return new Proxy(Object.create(null), {
        get(_t, prop) {
            // not a thenable (`await handle` must not hang), no symbol methods
            if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
            return () => Promise.reject(new WtCallError(reason));
        },
        set() {
            return false;
        },
    });
}

export const REMOTE_FROM_BACKGROUND = "page/overlay functions can only be called from this script's overlay or isolated-world onPage code, not from network handlers";
export const REMOTE_MAIN_WORLD = 'main-world onPage code can\'t call the overlay; use world: "isolated"';
export const REMOTE_OVERLAY_SELF = "the overlay can't call its own onOverlay handles — call the functions directly";
