/**
 * The Editor's Preview tab: one script's overlay (wt.onOverlay) in an
 * `overlay.html` frame over a checkerboard "page", as if on a URL the
 * user picks. This module is the frame's host — what a page's bridge is
 * to a page's overlay (hook/bridge.ts) — over L5: a `wt-preview` port to
 * the background (overlayLinks.ts), the same grant as a page's overlay,
 * so its stores are real replicas and a switch in the preview changes
 * live interception. There's no page: page fetches run from the
 * background (counted for the toolbar's badge) and calls to onPage code
 * fail. It reloads when the script (or what it imports) changes.
 */
import { proxy } from "valtio";
import { messagePortEndpoint, portEndpoint, type Endpoint, type ReqOf } from "../../shared/wire";
import { isRpcCall, NO_PAGE_IN_PREVIEW } from "../../shared/rpc";
import { dlogLevel } from "../../shared/debugLog";
import { persistedProxy } from "./persist";

export const PREVIEW_PORT = "wt-preview";

/** the "page" sizes: fit = the panel's */
export const VIEWPORTS = ["fit", "1280×800", "1024×768", "390×844"] as const;

/** the URL per script and the viewport (localStorage) */
export const previewPrefs = persistedProxy<{ urls?: Record<string, string>; viewport?: string }>("resPreview");

export type PreviewStatus = "idle" | "loading" | "ready" | "error";

export const preview = proxy({
    /** the previewed script (null: none — the open file isn't a script) */
    scriptId: null as string | null,
    status: "idle" as PreviewStatus,
    /** why there's no preview (status "error") */
    message: "",
    name: "",
    /** what `ctx.url` is in the preview */
    url: "",
    /** the script's onOverlay handlers, and how many match `url` */
    handlers: 0,
    matching: 0,
    /** page fetches the overlay made, which ran from the background instead */
    bgFetches: 0,
    /** the frame's one-time nonce ("": no frame) */
    nonce: "",
    /** bumped to make a new frame */
    frameKey: 0,
});

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;

let connect: () => Endpoint = () => portEndpoint(chrome.runtime.connect({ name: PREVIEW_PORT }), { batchMs: 16, debug: (m) => dlogLevel("wire", "debug", `preview: ${m}`) });
let l5: Endpoint | null = null;
let frame: Endpoint | null = null;
let codeHash = "";
/** the latest `reloadPreview` (an older one's answer is dropped) */
let gen = 0;
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const newNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** how the host reaches the background (tests: one side of an endpointPair) */
export function setPreviewConnect(fn: () => Endpoint): void {
    connect = fn;
}

function link(): Endpoint {
    if (l5 && !l5.closed) return l5;
    const ep = connect();
    l5 = ep;
    ep.on("store.patch", (a, s) => s === preview.scriptId && frame?.push("store.patch", a));
    ep.on("store.reject", (a, s) => s === preview.scriptId && frame?.push("store.reject", a));
    ep.on("bundle.update", () => void scriptsChanged());
    ep.onClose(() => {
        if (l5 !== ep) return;
        l5 = null;
        closeFrame("the Editor's link went away");
        if (!preview.scriptId) return;
        // the background restarted (MV3 service worker): open again
        preview.status = "loading";
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void reloadPreview(), retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    });
    return ep;
}

function closeFrame(why: string): void {
    frame?.close(why);
    frame = null;
    preview.nonce = "";
}

/** preview this script (null: none) */
export function showPreview(s: string | null): void {
    if (s === preview.scriptId && preview.status !== "idle") return;
    preview.scriptId = s;
    if (s) void reloadPreview();
    else stopPreview();
}

/** the tab closed: drop the frame and the link */
export function stopPreview(): void {
    gen++;
    clearTimeout(retryTimer);
    closeFrame("the preview closed");
    const ep = l5;
    l5 = null;
    ep?.close("the preview closed");
    Object.assign(preview, { scriptId: null, status: "idle", message: "", bgFetches: 0 });
}

/** a new frame for the previewed script (at its URL) */
export async function reloadPreview(): Promise<void> {
    const s = preview.scriptId;
    if (!s) return;
    const my = ++gen;
    clearTimeout(retryTimer);
    closeFrame("reloaded");
    Object.assign(preview, { status: "loading", message: "", bgFetches: 0 });
    const nonce = newNonce();
    let ep: Endpoint | undefined;
    try {
        ep = link();
        const r = await ep.call("preview.open", { nonce, url: previewPrefs.urls?.[s] ?? "" }, s);
        if (my !== gen) return;
        retryMs = RETRY_MIN_MS;
        Object.assign(preview, { name: r.name, url: r.url, handlers: r.handlers, matching: r.matching, nonce, frameKey: preview.frameKey + 1 });
    } catch (e: any) {
        // a link that closed tries again by itself
        if (my !== gen || ep?.closed) return;
        Object.assign(preview, { status: "error", message: String(e?.message ?? e).replace(/^preview\.open: /, "") });
    }
}

/** the URL the overlay sees ("": its routes' first) */
export function setPreviewUrl(url: string): void {
    const s = preview.scriptId;
    if (!s) return;
    url = url.trim();
    if (url === preview.url || (!url && !previewPrefs.urls?.[s])) return;
    const urls = { ...(previewPrefs.urls ?? {}) };
    if (url) urls[s] = url;
    else delete urls[s];
    previewPrefs.urls = urls;
    void reloadPreview();
}

/** scripts changed: reload when this one's overlay did (code, params, imports) or it couldn't run */
async function scriptsChanged(): Promise<void> {
    const s = preview.scriptId;
    if (!s || !l5) return;
    if (preview.status !== "ready") return void reloadPreview();
    const my = gen;
    const hash = await l5.call("overlay.init", {}, s).then(
        (init) => init.codeHash,
        () => ""
    );
    if (my === gen && hash !== codeHash) void reloadPreview();
}

/** the frame loaded: hand it a port; it proves itself with the nonce */
export function attachFrame(win: Window | null | undefined): void {
    const s = preview.scriptId;
    const nonce = preview.nonce;
    const up = l5;
    if (!win || !s || !nonce || !up || up.closed) return;
    frame?.close("reloaded");
    const { port1, port2 } = new MessageChannel();
    const ep = messagePortEndpoint(port1, { debug: (m) => dlogLevel("wire", "debug", `preview frame: ${m}`) });
    frame = ep;
    let proven = false;
    const mine =
        <A, R>(fn: (a: A) => R) =>
        (a: A): R => {
            if (proven && frame === ep) return fn(a);
            throw new Error("refused");
        };
    ep.handle("hello", async (a) => {
        if (proven || a?.nonce !== nonce) {
            ep.close("refused");
            throw new Error("refused");
        }
        proven = true;
        const init = await up.call("overlay.init", {}, s);
        codeHash = init.codeHash;
        if (frame === ep) preview.status = "ready";
        // there's no page to wait for
        return { ...init, phase: "document_idle" as const };
    });
    ep.on("store.declare", (a) => proven && up.push("store.declare", a, s));
    ep.on("store.set", (a) => proven && up.push("store.set", a, s));
    ep.handle("store.sub", mine((a: ReqOf<"store.sub">) => up.call("store.sub", a, s)));
    ep.handle("fetch", mine((a: ReqOf<"fetch">) => up.call("fetch", { request: a.request, bypass: !!a.bypass }, s)));
    ep.handle(
        "pagefetch",
        mine((a: ReqOf<"pagefetch">) => {
            preview.bgFetches++;
            return up.call("fetch", { request: a.request, bypass: !!a.bypass }, s);
        })
    );
    ep.handle("storage.get", mine((a: ReqOf<"storage.get">) => up.call("storage.get", a, s)));
    ep.handle("storage.set", mine((a: ReqOf<"storage.set">) => up.call("storage.set", a, s)));
    ep.on("log", (a) => proven && up.push("log", a, s));
    ep.on("rpc.call", (c) => proven && isRpcCall(c) && ep.push("rpc.result", { cid: c.cid, ok: false, error: { name: "WtCallError", message: NO_PAGE_IN_PREVIEW } }));
    // the frame fills the "page"; keys pressed in it are matched in it
    for (const op of ["rects", "focus", "shortcut.add", "shortcut.remove", "rpc.result"] as const) ep.on(op, () => {});
    ep.onClose(() => {
        if (frame === ep) frame = null;
    });
    // not the nonce: the frame has to know it
    win.postMessage({ wtOverlay: true }, "*", [port2]);
}
