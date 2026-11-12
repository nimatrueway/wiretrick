/**
 * Pages: which document each tab shows, for `tt.pageStore` (one copy per
 * page). A page starts when a tab's top frame commits a new document (a
 * navigation or reload; a single-page app's route change isn't one) and
 * ends at the next one or when the tab closes — its store copies go then.
 *
 *   Chrome MV3 — `webNavigation.onCommitted` (top frame), keyed by Chrome's
 *     `documentId` so a late event or the top frame's bridge connecting
 *     first don't start it twice. Kept in `chrome.storage.session` across
 *     service-worker restarts.
 *   MV2 (Firefox) — no `documentId`, and no new permission: the top-frame
 *     document's response starting (`webRequest.onResponseStarted`, also
 *     for a page from the HTTP cache; a back/forward-cache restore keeps
 *     the page that was current).
 *
 * A navigation request (`main_frame`) belongs to the page it leaves:
 * the page is taken when the request starts.
 */
import { onBridgeConnect } from "./bridgePorts";

interface PageRec {
    key: string;
    /** Chrome's documentId */
    doc?: string;
}

const SESSION_KEY = "ttPages";
const NAV_TTL_MS = 5 * 60_000;

export class PageRegistry {
    private readonly byTab = new Map<number, PageRec>();
    private readonly alive = new Set<string>();
    /** pages not in a tab (the Editor's overlay preview) */
    private readonly virtual = new Set<string>();
    /** a navigation request → the page it leaves */
    private readonly nav = new Map<string, { key: string | null; at: number }>();
    private readonly endFns: ((key: string, tabId: number) => void)[] = [];
    private seq = 0;

    constructor(private readonly opts: { save?: (byTab: Record<number, PageRec>) => void } = {}) {}

    /** the page a tab shows now (a tab open before TangiTweak started gets one on first use); null: not a tab */
    current(tabId: number): string | null {
        if (typeof tabId !== "number" || tabId < 0) return null;
        let rec = this.byTab.get(tabId);
        if (!rec) rec = this.begin(tabId, undefined);
        return rec.key;
    }

    /**
     * The page a request belongs to. `main_frame`: the page it leaves (the
     * one current when it started, if `navStart` saw it); a top-frame
     * request with an unseen `documentId` started the page that sent it.
     */
    forRequest(r: { tabId: number; type?: string; requestId?: string; frameId?: number; documentId?: string; documentLifecycle?: string }): string | null {
        if (typeof r.tabId !== "number" || r.tabId < 0) return null;
        if (r.type === "main_frame") {
            const n = r.requestId !== undefined ? this.nav.get(String(r.requestId)) : undefined;
            return n ? (n.key && this.alive.has(n.key) ? n.key : null) : this.current(r.tabId);
        }
        if (r.frameId === 0 && r.documentId) {
            const rec = this.byTab.get(r.tabId);
            if (rec?.doc === r.documentId) return rec.key;
            // an older document of this tab (an unload beacon): its page is gone
            if (r.documentLifecycle && r.documentLifecycle !== "active") return null;
            return this.committed(r.tabId, r.documentId);
        }
        return this.current(r.tabId);
    }

    /** a navigation request started: remember the page it leaves */
    navStart(tabId: number, requestId: string): void {
        if (tabId < 0) return;
        const now = Date.now();
        if (this.nav.size > 200) for (const [k, v] of this.nav) if (now - v.at > NAV_TTL_MS) this.nav.delete(k);
        this.nav.set(String(requestId), { key: this.current(tabId), at: now });
    }

    navEnd(requestId: string): void {
        this.nav.delete(String(requestId));
    }

    /** Chrome: the top frame committed document `doc` (idempotent per document) */
    committed(tabId: number, doc: string | undefined): string {
        const rec = this.byTab.get(tabId);
        if (doc && rec?.doc === doc) return rec.key;
        return this.begin(tabId, doc).key;
    }

    /** MV2: the top-frame document's response started — a new page */
    responseStarted(tabId: number): void {
        if (tabId < 0) return;
        this.begin(tabId, undefined);
    }

    /** the top frame's bridge connected (Chrome: its document may be news before onCommitted is) */
    bridgeConnected(tabId: number, doc: string | undefined): void {
        if (doc) this.committed(tabId, doc);
    }

    tabClosed(tabId: number): void {
        const rec = this.byTab.get(tabId);
        if (!rec) return;
        this.byTab.delete(tabId);
        this.end(rec.key, tabId);
        this.save();
    }

    isAlive(key: string): boolean {
        return this.alive.has(key) || this.virtual.has(key);
    }

    /** a page outside any tab (the Editor preview's overlay); ends with `endVirtual` */
    openVirtual(): string {
        const key = `v${this.newKey()}`;
        this.virtual.add(key);
        return key;
    }

    endVirtual(key: string): void {
        if (this.virtual.delete(key)) this.end(key, -1);
    }

    /** the tabs' pages, `tabId → key` */
    tabs(): Map<number, string> {
        return new Map([...this.byTab].map(([t, r]) => [t, r.key]));
    }

    /** the tab a page is in (-1: none) */
    tabOf(key: string): number {
        for (const [t, r] of this.byTab) if (r.key === key) return t;
        return -1;
    }

    onEnd(fn: (key: string, tabId: number) => void): void {
        this.endFns.push(fn);
    }

    /** MV3: the saved map after a service-worker restart (tabs seen since win) */
    restore(saved: Record<string, PageRec> | undefined): void {
        if (!saved || typeof saved !== "object") return;
        for (const [t, r] of Object.entries(saved)) {
            const tabId = Number(t);
            if (!r || typeof r.key !== "string" || this.byTab.has(tabId)) continue;
            this.byTab.set(tabId, { key: r.key, ...(r.doc ? { doc: r.doc } : {}) });
            this.alive.add(r.key);
        }
    }

    private newKey(): string {
        return `${(++this.seq).toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
    }

    private begin(tabId: number, doc: string | undefined): PageRec {
        const old = this.byTab.get(tabId);
        const rec: PageRec = { key: `${tabId}.${this.newKey()}`, ...(doc ? { doc } : {}) };
        this.byTab.set(tabId, rec);
        this.alive.add(rec.key);
        if (old) this.end(old.key, tabId);
        this.save();
        return rec;
    }

    private end(key: string, tabId: number): void {
        this.alive.delete(key);
        for (const fn of this.endFns) {
            try {
                fn(key, tabId);
            } catch {}
        }
    }

    private save(): void {
        this.opts.save?.(Object.fromEntries([...this.byTab].map(([t, r]) => [t, { key: r.key, ...(r.doc ? { doc: r.doc } : {}) }])));
    }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Record<number, PageRec> | null = null;

export const pages = new PageRegistry({
    save: __MV3__
        ? (byTab) => {
              pending = byTab;
              saveTimer ??= setTimeout(() => {
                  saveTimer = null;
                  const v = pending;
                  pending = null;
                  void chrome.storage?.session?.set({ [SESSION_KEY]: v }).catch(() => {});
              }, 50);
          }
        : undefined,
});

/** resolves once MV3 restored the saved pages (handlers await it before asking which page a request is in) */
export let pagesReady: Promise<void> = Promise.resolve();

let installed = false;

/** listen to the browser for pages starting and ending */
export function installPages(): void {
    if (installed) return;
    installed = true;
    const c: typeof chrome | undefined = (globalThis as any).chrome;
    if (__MV3__ && c?.storage?.session)
        pagesReady = c.storage.session
            .get(SESSION_KEY)
            .then((v) => pages.restore(v?.[SESSION_KEY]))
            .catch(() => {});
    const wr = c?.webRequest;
    wr?.onBeforeRequest?.addListener((d) => void (d.frameId === 0 && pages.navStart(d.tabId, d.requestId)), { urls: ["<all_urls>"], types: ["main_frame"] });
    const done = (d: { requestId: string }) => pages.navEnd(d.requestId);
    wr?.onCompleted?.addListener(done, { urls: ["<all_urls>"], types: ["main_frame"] });
    wr?.onErrorOccurred?.addListener(done, { urls: ["<all_urls>"], types: ["main_frame"] });
    if (__MV3__ && (c as any)?.webNavigation)
        c!.webNavigation.onCommitted.addListener((d) => {
            if (d.frameId === 0 && d.tabId >= 0) void pagesReady.then(() => pages.committed(d.tabId, (d as any).documentId));
        });
    else
        wr?.onResponseStarted?.addListener(
            (d) => {
                // a 204 or a download doesn't replace the document
                if (d.frameId === 0 && d.tabId >= 0 && d.statusCode !== 204 && d.statusCode !== 205) pages.responseStarted(d.tabId);
            },
            { urls: ["<all_urls>"], types: ["main_frame"] }
        );
    onBridgeConnect((link) => {
        if (link.frameId === 0) void pagesReady.then(() => pages.bridgeConnected(link.tabId, (link.port.sender as any)?.documentId));
    });
    c?.tabs?.onRemoved?.addListener((tabId) => void pagesReady.then(() => pages.tabClosed(tabId)));
    c?.tabs?.onReplaced?.addListener((_added, removed) => void pagesReady.then(() => pages.tabClosed(removed)));
}

/** the page a strategy's body op runs for: `args.page` (a navigation request: the page it leaves) */
export async function withOpPage<A extends Record<string, any>>(args: A, tabId: number | undefined): Promise<A & { page: string | null }> {
    await pagesReady;
    return Object.assign(args, { page: pages.forRequest({ tabId: tabId ?? -1, type: args.resourceType, requestId: args.requestId }) });
}
