/**
 * Which page and tab the running handler call belongs to, for `tt.pageStore`
 * and `tt.tabStore`.
 *
 * One compiled script serves every tab, so its `tt.pageStore` and
 * `tt.tabStore` proxies ask here which copy to use. The runner wraps each
 * handler call in `withPage`; the context is known only during the call's
 * synchronous part — after the handler's first `await` it runs from a
 * microtask, outside any `withPage`, and `currentPage()` / `currentTab()`
 * are `undefined` again. (Microtasks never run inside synchronous code, so a
 * resumed handler can't see another call's page or tab.)
 */
import { tabScopeOfPage } from "./storeOps";

/** the "page" of a strategy "rules" probe run: rules are built once, not per document */
export const RULES_PAGE = "\u0000rules";
/** the "tab" of a strategy "rules" base probe run: evaluates `tt.tabStore` against `initial` */
export const RULES_TAB = "\u0000rules-tab";

export interface RulesProbeReads {
    conditional: boolean;
    tabStores: Set<string>;
}

/** a page key (src/background/engine/pages.ts), null: a request with no page, undefined: no handler call */
let current: string | null | undefined;
/** a tab scope key (`"tab:42"`), `RULES_TAB`, null: a request with no tab, undefined: no handler call */
let tabCurrent: string | null | undefined;
/** active `rules` probe read tracker (synchronous portion of the handler call) */
let probeReads: RulesProbeReads | undefined;
/** bumps per `withPage`: a page-less / tab-less call's throwaway copies are per call */
let call = 0;
let callSeq = 0;

export function withPage<T>(page: string | null | undefined, fn: () => T, tab?: string | null): T {
    const prev = current;
    const prevTab = tabCurrent;
    const prevCall = call;
    current = page;
    tabCurrent = tab !== undefined ? tab : page === undefined || page === RULES_PAGE ? undefined : tabScopeOfPage(page);
    call = ++callSeq;
    try {
        return fn();
    } finally {
        current = prev;
        tabCurrent = prevTab;
        call = prevCall;
    }
}

/** run a strategy "rules" probe (`tab`: a specific `"tab:<id>"`, or `undefined` for the `initial` base probe) */
export function withRulesProbe<T>(tab: string | undefined, reads: RulesProbeReads, fn: () => T): T {
    const prevReads = probeReads;
    probeReads = reads;
    try {
        return withPage(RULES_PAGE, fn, tab ?? RULES_TAB);
    } finally {
        probeReads = prevReads;
    }
}

/** record that the running `rules` probe branched on dynamic state (`params` / `globalStore` / `tabStore`) */
export function noteRuleCondition(): void {
    if (probeReads) probeReads.conditional = true;
}

/** record that the running `rules` probe read `tt.tabStore(name)` */
export function noteRuleTabStore(name: string): void {
    if (probeReads) {
        probeReads.conditional = true;
        probeReads.tabStores.add(name);
    }
}

export function currentPage(): string | null | undefined {
    return current;
}

export function currentTab(): string | null | undefined {
    return tabCurrent;
}

/** identifies the running handler call (0: none) */
export function currentCall(): number {
    return current === undefined && tabCurrent === undefined ? 0 : call;
}
