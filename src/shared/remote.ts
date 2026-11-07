/**
 * Handles returned by `wt.onSite` / `wt.onPage` / `wt.onOverlay`: the other side's
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

export const REMOTE_FROM_BACKGROUND = "handles can't be called from network handlers: call a handler's functions from onPage or onOverlay code";
/** in every message about onSite code using what only trusted code may (the editor offers the move-to-onPage quick fix) */
export const SITE_DISALLOWED = "which the site's JavaScript world can't be trusted with";
/** a handle used in onSite code */
export const SITE_NO_HANDLES = `onSite code can't call handles (${SITE_DISALLOWED}: the site could call them too) — call them from wt.onPage or wt.onOverlay code, and have those read the site through an onSite handle`;
/** a store used in onSite code */
export const SITE_NO_STORES = `wt.globalStore and wt.pageStore aren't available in onSite code (${SITE_DISALLOWED}: the site could read and forge them) — use them in wt.onPage or wt.onOverlay code, and pass what onSite code needs as arguments`;

/** thrown where onSite code calls a handle's function */
export class SiteCannotCallError extends Error {
    constructor(message = SITE_NO_HANDLES) {
        super(message);
        this.name = "SiteCannotCallError";
    }
}

/** a handle in onSite code: calling any of its functions throws SiteCannotCallError right there (`onCall` sees each) */
export function siteRemote(onCall?: (e: SiteCannotCallError) => void): any {
    return new Proxy(Object.create(null), {
        get(_t, prop) {
            if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
            return () => {
                const e = new SiteCannotCallError();
                onCall?.(e);
                throw e;
            };
        },
        set() {
            return false;
        },
    });
}
