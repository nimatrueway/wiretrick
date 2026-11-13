/**
 * Handles returned by `tt.onSite` / `tt.onPage` / `tt.onOverlay`: the other side's
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
export const SITE_NO_HANDLES = `onSite code can't call handles (${SITE_DISALLOWED}: the site could call them too) — call them from tt.onPage or tt.onOverlay code, and have those read the site through an onSite handle`;
/** a store used in onSite code */
export const SITE_NO_STORES = `tt.globalStore, tt.tabStore and tt.pageStore aren't available in onSite code (${SITE_DISALLOWED}: the site could read and forge them) — keep what the site may see in a tt.siteStore, or use them in tt.onPage or tt.onOverlay code`;
/** `tt.siteStore` where there's no page (network handlers) */
export const NO_SITE_STORE = "tt.siteStore needs a page; network handlers have none — use it in tt.onSite, tt.onPage or tt.onOverlay code";
/** `tt.siteStore` in an imported library */
export const LIB_SITE_STORE = "tt.siteStore: declare site stores in the script itself, not in an imported library";

/** a store that can be declared (top-level code runs everywhere) but throws `message` when used */
export function unusableStore(message: string): any {
    const fail = (): never => {
        throw new Error(message);
    };
    return new Proxy(Object.create(null), { get: (_t, p) => (p === "then" || typeof p === "symbol" ? undefined : fail()), set: fail, has: fail, ownKeys: fail, deleteProperty: fail });
}

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
