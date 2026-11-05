/**
 * `wt.onPage({ js: "page", dom: "overlay", unsafe: true })`: a script's
 * overlay as page code. The hook (the page's own world, top frame) frames
 * a same-origin blank document over the page, inside a closed shadow root,
 * and runs the script's handlers with `document` = that document (`window`
 * stays the site's). Like the overlay frame, it lets clicks through
 * everywhere it draws nothing (shared/overlayRects.ts). Unlike it, the
 * site can see, read and change all of it — hence `unsafe`.
 */
import { clipPathFor, collectRects, normalizeRects, watchRects } from "../shared/overlayRects";
import { ShortcutRegistry, watchShortcuts, type ShortcutPriority } from "../shared/shortcut";

export interface PageLayer {
    doc: Document;
    win: Window;
    /** `ctx.onNavigate` / `ctx.shortcut` for its handlers */
    ctx(): Record<string, unknown>;
    /** an in-place navigation may have happened */
    nav(): void;
    remove(): void;
}

const HOST_CSS =
    "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:auto!important;height:auto!important;z-index:2147483647!important;pointer-events:none!important;visibility:visible!important;opacity:1!important;transform:none!important;contain:strict!important";

/** frame the layer; resolves once its document is ready (null: removed before that) */
export function createPageLayer(onError: (e: unknown, context: string) => void): Promise<PageLayer | null> {
    const host = document.createElement("wiretrick-layer");
    host.style.cssText = HOST_CSS;
    const shadow = host.attachShadow({ mode: "closed" });
    const frame = document.createElement("iframe");
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="normal"></head><body></body></html>';
    // same color-scheme inside and out, or Chromium paints the frame opaque
    frame.style.cssText = `all:initial;position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;pointer-events:auto;clip-path:${clipPathFor([])}`;
    shadow.appendChild(frame);
    document.documentElement.appendChild(host);
    return new Promise((resolve) => {
        frame.addEventListener(
            "load",
            () => {
                const win = frame.contentWindow;
                const doc = frame.contentDocument;
                if (!win || !doc || !host.isConnected) return resolve(null);
                // CSSOM, not markup: a page CSP may forbid inline styles
                doc.body.style.margin = "0";
                let last = "";
                const measure = () => {
                    const rects = normalizeRects(collectRects(doc, win) ?? [[0, 0, window.innerWidth, window.innerHeight]], window.innerWidth, window.innerHeight);
                    const key = JSON.stringify(rects);
                    if (key === last) return;
                    last = key;
                    frame.style.clipPath = clipPathFor(rects);
                };
                const stopRects = watchRects(doc, win, measure);
                measure();

                const navFns = new Set<(url: string) => void>();
                let href = location.href;
                const nav = () => {
                    if (location.href === href) return;
                    href = location.href;
                    for (const fn of [...navFns]) {
                        try {
                            fn(href);
                        } catch (e) {
                            onError(e, "ctx.onNavigate");
                        }
                    }
                };
                window.addEventListener("popstate", nav);
                window.addEventListener("hashchange", nav);

                const keys = new ShortcutRegistry();
                const keyFns = new Map<string, () => void>();
                let nextKey = 0;
                const fire = (hits: { id: string }[]) => {
                    for (const h of hits) {
                        try {
                            const out: any = keyFns.get(h.id)?.();
                            if (out && typeof out.then === "function") out.then(undefined, (e: unknown) => onError(e, "ctx.shortcut"));
                        } catch (e) {
                            onError(e, "ctx.shortcut");
                        }
                    }
                };
                const stopKeys = [watchShortcuts(window, (e) => keys.find(e), fire), watchShortcuts(win, (e) => keys.find(e), fire)];

                const ctx = () => ({
                    url: location.href,
                    method: "GET",
                    tabUrl: location.href,
                    resourceType: "main_frame",
                    requestHeaders: {},
                    groups: {},
                    onNavigate(fn: (url: string) => void) {
                        if (typeof fn !== "function") throw new TypeError("ctx.onNavigate: the argument must be a function");
                        navFns.add(fn);
                        return () => void navFns.delete(fn);
                    },
                    shortcut(combo: string, fn: () => void, opts?: { priority?: ShortcutPriority }) {
                        if (typeof fn !== "function") throw new TypeError("ctx.shortcut: the second argument must be a function");
                        const priority = opts?.priority ?? "before-page";
                        if (priority !== "before-page" && priority !== "after-page") throw new TypeError(`ctx.shortcut: priority must be "before-page" or "after-page"`);
                        const id = String(nextKey++);
                        keys.add("", id, combo, priority);
                        keyFns.set(id, fn);
                        return () => {
                            keys.remove("", id);
                            keyFns.delete(id);
                        };
                    },
                });
                resolve({
                    doc,
                    win,
                    ctx,
                    nav,
                    remove() {
                        stopRects();
                        for (const stop of stopKeys) stop();
                        window.removeEventListener("popstate", nav);
                        window.removeEventListener("hashchange", nav);
                        navFns.clear();
                        host.remove();
                    },
                });
            },
            { once: true }
        );
    });
}
