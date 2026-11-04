/**
 * Which page the running handler call belongs to, for `wt.pageStore`.
 *
 * One compiled script serves every tab, so its `wt.pageStore` proxy asks
 * here which page's copy to use. The runner wraps each handler call in
 * `withPage`; the page is known only during the call's synchronous part —
 * after the handler's first `await` it runs from a microtask, outside any
 * `withPage`, and `currentPage()` is `undefined` again. (Microtasks never
 * run inside synchronous code, so a resumed handler can't see another
 * call's page.)
 */

/** the "page" of a strategy "rules" probe run: rules are built once, for every page */
export const RULES_PAGE = "\u0000rules";

/** a page key (src/background/engine/pages.ts), null: a request with no page, undefined: no handler call */
let current: string | null | undefined;
/** bumps per `withPage`: a page-less call's throwaway copies are per call */
let call = 0;
let callSeq = 0;

export function withPage<T>(page: string | null | undefined, fn: () => T): T {
    const prev = current;
    const prevCall = call;
    current = page;
    call = ++callSeq;
    try {
        return fn();
    } finally {
        current = prev;
        call = prevCall;
    }
}

export function currentPage(): string | null | undefined {
    return current;
}

/** identifies the running handler call (0: none) */
export function currentCall(): number {
    return current === undefined ? 0 : call;
}
