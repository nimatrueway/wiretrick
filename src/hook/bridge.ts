/**
 * ISOLATED-world bridge content script. Runs in the extension's security
 * context (page CSP does not apply here in MV2) and is the only channel
 * between the MAIN-world hook and the background:
 *
 *   hook (MAIN, no eval) ← postMessage → bridge (isolated) ⇄ background
 *
 * Also runs wt.onPage code in the isolated world (MV2; MV3 has no eval in
 * content scripts, so it runs in chrome.userScripts worlds —
 * src/hook/isolated.ts — and the bridge relays the overlay's calls to it
 * through the background, L2), and wt.onSite code when the page CSP
 * blocks eval in the page. The background sends the scripts'
 * SOURCES, the bridge compiles them and runs them at the requested DOM
 * moment — the isolated world shares the page's DOM, not its JS world.
 *
 * In the top frame it also hosts the scripts' overlays (`wt.onOverlay`): one
 * iframe per script inside a closed shadow root, linked to this bridge by
 * a MessagePort (L3). The bridge relays what each overlay may do to the
 * background over the `wt-bridge` port (L2), fetches as the page for it,
 * and routes the overlay's calls into that script's handles by their key:
 * `onPage:` (isolated world here, or through the background on MV3),
 * `onSite:` (the CSP fallback here, else the hook, L4). It also listens
 * for the overlays' `ctx.shortcut` keys in the page.
 *
 * Nothing in the page's world calls trusted code: what the page posts
 * toward it is dropped (and logged).
 */
import { formatScriptError } from "../shared/scriptError";
import { makeScriptConsole, formatLogArgs, scriptLogLine, type ScriptContext, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";
import { makeLibRequire, type ShippedLib } from "../shared/scriptImports";
import { builtinModule, builtinsReady, ensureBuiltins, setBuiltinLoader, shippedSources, sourceLoader } from "../shared/builtins";
import { makePageShim, domHandlersFor, scheduleDocument, fireRun, pageCtxBase, type PageDocumentHandler } from "../shared/pageShim";
import { ScriptLife, type Generation, type ReactDomClient } from "../shared/runLifecycle";
import { packBytes, unpackBytes } from "../shared/bytesPack";
import { Endpoint, endpointPair, messagePortEndpoint, portEndpoint, ISO_STORE_TAG, type ReqOf, type ReqOps, type ResOf } from "../shared/wire";
import { ReplicaHub, type StoreSnapshots } from "../shared/storeReplica";
import { SiteMirrors } from "../shared/siteStoreMirror";
import { siteBuiltin } from "../shared/siteBuiltin";
import { SITE_DOWN_KINDS, SITE_UP_KINDS, type SiteDown, type SiteUp } from "../shared/siteStoreHost";
import { Exposer, RpcClient, isRpcCall, isRpcResult, NOT_RUNNING, RPC_QUEUE_MAX, TOP_FRAME_ONLY, type RpcCall, type RpcResult } from "../shared/rpc";
import { inertRemote } from "../shared/remote";
import type { DocumentWhen, PlaceApi, RouteMeta } from "../shared/route";
import { clipPathFor, normalizeRects } from "../shared/overlayRects";
import { fromWireRequest, toWireResponse } from "../shared/wtFetch";
import { ShortcutRegistry, watchShortcuts } from "../shared/shortcut";
import type { RanApi } from "../shared/netTypes";

(() => {
    const MAIN_SOURCE = "res-override-bridge";
    const HOOK_SOURCE = "res-override-hook";

    /** bridge diagnostics → extension debug log (never the page console) */
    function dlog(level: ScriptLogLevel, ...args: any[]): void {
        safeSend({ type: "debugLog", entry: { at: Date.now(), src: "bridge", msg: formatLogArgs(args), level } });
    }

    /** a user script's own output → extension LOG, attributed to the script (and tagged with where it ran) */
    function scriptLog(scriptId: string | null, level: ScriptLogLevel, msg: string, ctx?: ScriptContext): void {
        safeSend({ type: "scriptLog", scriptId, level, msg, ...(ctx ? { ctx } : {}) });
    }

    /** onPage/onOverlay ran on this document (once per script), or an overlay fetched `url`: tag that Network row */
    const ranHere = new Set<string>();
    function scriptRan(scriptId: unknown, name: unknown, api: RanApi, url = location.href): void {
        if (typeof scriptId !== "string") return;
        if (api !== "pageFetch") {
            const key = `${scriptId}|${api}`;
            if (ranHere.has(key) || ranHere.size > 200) return;
            ranHere.add(key);
        }
        safeSend({ type: "scriptRan", scriptId, name: String(name ?? ""), api, url });
    }

    // ---- MAIN-world hook relaying ----

    /**
     * Extension reloads invalidate this content script's context:
     * chrome.runtime.sendMessage then THROWS synchronously. Every relay
     * must survive that — the first detection marks the bridge dead and
     * tells the hook to go dormant (restoring the page's own fetch/XHR)
     * instead of stalling every request on the 15s watchdog.
     */
    let dead = false;
    const CONTEXT_DEAD = /context invalidated/i;
    function markDead(): void {
        if (dead) return;
        dead = true;
        try {
            window.postMessage({ source: MAIN_SOURCE, kind: "extensionDead" }, window.location.origin);
        } catch {}
        try {
            for (const s of [...overlays.keys()]) removeOverlay(s, "the extension reloaded");
        } catch {}
    }
    function safeSend(msg: any, onResp?: (resp: any) => void): void {
        if (dead) return;
        try {
            chrome.runtime.sendMessage(msg, (resp: any) => {
                // the context can die between send and callback — nothing in
                // here may throw uncaught
                try {
                    const err = (chrome.runtime as any).lastError;
                    if (err && CONTEXT_DEAD.test(err.message || "")) return markDead();
                    onResp?.(resp);
                } catch (e: any) {
                    if (CONTEXT_DEAD.test(e?.message || "")) markDead();
                }
            });
        } catch (e: any) {
            if (CONTEXT_DEAD.test(e?.message || "")) markDead();
            else onResp?.(undefined);
        }
    }

    /** final net: a content-script event handler may never throw uncaught */
    function guard(fn: () => void): void {
        try {
            fn();
        } catch (e: any) {
            if (CONTEXT_DEAD.test(e?.message || "")) markDead();
            else dlog("error", "bridge message handler failed:", String(e?.message || e));
        }
    }

    function askBundle(): Promise<any> {
        return new Promise((resolve) => safeSend({ type: "getHookBundle", url: location.href }, resolve));
    }
    /**
     * asked for as the bridge starts — the hook's first `status?` is answered
     * from it, so the hook (which holds the page's requests until then)
     * waits as little as possible
     */
    let earlyBundle: Promise<any> | null = null;
    /** the hook's calls still waiting on the extension (by the hook's reqId) */
    const hookCalls = new Set<number>();

    window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;
        void guard(() => {

        if (data.kind === "status?") {
            const bundle = earlyBundle ?? askBundle();
            earlyBundle = null;
            void bundle.then((resp) => guard(() => {
                noteBundle(resp, false);
                postStatus(resp, false);
            }));
            return;
        }
        if (data.kind === "alive?") {
            // the hook's watchdog: is this call still waiting on the extension?
            // (if the extension's end dies, sendMessage's callback says so)
            if (hookCalls.has(data.reqId)) window.postMessage({ source: MAIN_SOURCE, kind: "alive", reqId: data.reqId }, window.location.origin);
            return;
        }
        if (data.kind === "claim") {
            safeSend({ type: "claimRequest", url: data.url });
            return;
        }
        if (data.kind === "call" && (data.op === "storageGet" || data.op === "storageSet")) {
            // the page can forge this message: only scripts whose main-world
            // onPage code was shipped to this frame may use its storage
            if (typeof data.scriptId !== "string" || !pageScriptIds.has(data.scriptId)) {
                dlog("warn", `refused a page storage ${data.op} for a script not running in this frame's page world`);
                window.postMessage({ source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: null }, window.location.origin);
                return;
            }
            const storageType = data.op === "storageGet" ? "scriptStorageGet" : "scriptStorageSet";
            hookCalls.add(data.reqId);
            safeSend(
                { type: storageType, scriptId: data.scriptId, key: data.key, value: data.value },
                (resp: any) => {
                    hookCalls.delete(data.reqId);
                    window.postMessage(
                        { source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: resp || null },
                        window.location.origin
                    );
                }
            );
            return;
        }
        if (data.kind === "call") {
            const bgType = data.op === "replace" ? "runReplace" : data.op === "respond" ? "runRequestDecision" : "runTransform";
            // runtime messaging is JSON: binary bodies travel as base64 both ways
            hookCalls.add(data.reqId);
            safeSend(
                packBytes({ type: bgType, url: data.url, method: data.method, body: data.body, status: data.status, contentType: data.contentType, requestBody: data.requestBody }),
                (resp: any) => {
                    hookCalls.delete(data.reqId);
                    window.postMessage(
                        { source: MAIN_SOURCE, kind: "callResult", reqId: data.reqId, result: unpackBytes(resp) || null },
                        window.location.origin
                    );
                }
            );
            return;
        }
        if (data.kind === "bodySkip") {
            safeSend({ type: "bodySkip", url: data.url, method: typeof data.method === "string" ? data.method : "GET", why: data.why, contentType: data.contentType || "" });
            return;
        }
        if (data.kind === "log") {
            safeSend(
                { type: "debugLog", entry: { at: Date.now(), src: data.src || "page", msg: data.msg, level: data.level || "info" } }
            );
        }
        if (data.kind === "scriptLog") {
            safeSend({ type: "scriptLog", scriptId: data.scriptId ?? null, level: data.level, msg: data.msg, ctx: "page" });
        }
        if (data.kind === "scriptRan" && data.api === "onSite") {
            scriptRan(data.scriptId, data.name, data.api);
        }
        // the hook's answer to an overlay's call (L4). The page can post this
        // too: only a cid we sent and are still waiting for is accepted, and
        // the value is page data either way. A call from the page never
        // reaches trusted code.
        // the site's world's `wt.siteStore` answers: to this world's mirrors and the overlays' (page data, for their own subscriptions)
        if (SITE_DOWN_KINDS.has(data.kind)) {
            siteMirrors?.receive(data);
            relaySiteDown(data);
            return;
        }
        if (data.kind === "rpc.result") {
            const p = typeof data.result?.cid === "string" ? l4Pending.get(data.result.cid) : undefined;
            if (!p || p.s !== data.s || !isRpcResult(data.result)) return;
            l4Pending.delete(data.result.cid);
            p.reply(data.result);
            return;
        }
        if (data.kind === "nav") noteNav();
        if (data.kind === "wire") dropped("a page-world message to trusted code");
        });
    });

    // ---- onPage code in the isolated world: compiles the FULL script source
    // with a shim so top-level helpers/closures survive; the DOM is shared
    // with the page, window (page JS globals) is not ----
    interface DocumentHandler { scriptId: string; name: string; src: string; params?: Record<string, any> }

    /** page-world messages toward trusted code: dropped, logged (a few per page) */
    let droppedN = 0;
    function dropped(what: string): void {
        if (droppedN++ < 5) dlog("warn", `dropped ${what}: code in the page's world can't call trusted code`);
    }

    /** script ids whose onSite code this frame got (storage relay allow-list) */
    let pageScriptIds = new Set<string>();
    let isoFired = false;

    function postStatus(resp: any, hot: boolean): void {
        const active = !!(resp && (resp.count > 0 || (resp.domHandlers || []).length));
        // main-world handlers and libraries only: isolated code never reaches the page
        window.postMessage(
            {
                source: MAIN_SOURCE,
                kind: "status",
                active,
                routes: (resp && resp.routes) || [],
                textTypes: resp?.textTypes,
                domHandlers: (resp && resp.domHandlers) || [],
                libs: (resp && resp.libs) || [],
                ...(hot ? { hot: true } : {}),
            },
            window.location.origin
        );
    }

    /** a fresh bundle: refresh the storage allow-list, run isolated handlers (once per load; again on a hot update) */
    function noteBundle(resp: any, hot: boolean): void {
        if (!resp) return;
        if (resp.count > 0 || (resp.domHandlers || []).length || (resp.isoHandlers || []).length || (resp.overlays || []).length) openPort();
        pageScriptIds = new Set(((resp.domHandlers || []) as DocumentHandler[]).map((h) => h.scriptId));
        syncOverlays(window === top ? resp.overlays || [] : [], hot);
        if (__MV3__) {
            // MV3 content scripts can't eval: isolated code runs in user-script worlds; this frame only relays the overlay's calls
            isoScripts = new Set(((resp.isoHandlers || []) as { scriptId: string }[]).map((h) => h.scriptId));
            isoOff = typeof resp.isoOff === "string" ? resp.isoOff : null;
            return;
        }
        const iso: DocumentHandler[] = resp.isoHandlers || [];
        if (resp.isoStores) {
            isoPrimed = resp.isoStores;
            isoPage = typeof resp.isoPage === "string" ? resp.isoPage : "";
            isoHub?.prime(isoPrimed);
        }
        if (isoFired && !hot) return;
        isoFired = true;
        runPageScripts(iso, resp.isoLibs || [], "isolated", hot);
    }

    /** MV3: the scripts whose onPage code runs in this frame (in chrome.userScripts worlds) */
    let isoScripts = new Set<string>();
    /** MV3: why that code doesn't run (user scripts are off), if it doesn't */
    let isoOff: string | null = null;
    /** per script, what answers calls into handlers run here: onPage (MV2), and onSite when the page CSP blocks eval */
    const isoExposers = new Map<string, Exposer>();
    const fallbackExposers = new Map<string, Exposer>();

    // ---- isolated onPage code's stores (MV2: it runs here) ----
    //
    // Replicas, primed by the bundle (`isoStores`, this page's wt.pageStore
    // copies). Their ops go over L2 tagged `ISO_STORE_TAG + s`, once the
    // background granted the script (`iso.stores`) on that link.
    let isoHub: ReplicaHub | null = null;
    /** the hub's side of the relay to L2 */
    let isoOut: Endpoint | null = null;
    let isoPrimed: StoreSnapshots = {};
    let isoPage = "";
    /** per script: L2 granted (null: refused), for the current L2 link */
    function storeGrants(op: "iso.stores", what: string) {
        let grants = new Map<string, Promise<Endpoint | null>>();
        return {
            reset: () => void (grants = new Map()),
            get(s: string): Promise<Endpoint | null> {
                let p = grants.get(s);
                if (!p) {
                    const mine = grants;
                    p = l2up(op).then(
                        (ep) => ep.call(op, { url: location.href }, s).then(() => ep),
                        (e: any) => {
                            if (mine.get(s) === p) mine.delete(s);
                            throw e;
                        }
                    );
                    p = p.catch((e: any) => {
                        if (e?.name === "DisconnectedError") {
                            if (mine.get(s) === p) mine.delete(s);
                        } else dlog("warn", `${what} of ${s}: refused: ${e?.message || e}`);
                        return null;
                    });
                    mine.set(s, p);
                }
                return p;
            },
        };
    }
    const isoGrants = storeGrants("iso.stores", "isolated onPage stores");

    /** a hub's store ops (on `out`) → L2, tagged `tag + s`, for the scripts `allowed` lets through; in order: each op waits for its script's grant */
    function relayStores(out: Endpoint, grant: (s: string) => Promise<Endpoint | null>, tag: string, allowed: (s: string) => boolean = () => true): void {
        const ok = (s: string | undefined): s is string => s !== undefined && allowed(s);
        out.on("store.declare", (a, s) => ok(s) && void grant(s).then((ep) => ep && !ep.closed && ep.push("store.declare", a, tag + s)));
        out.on("store.set", (a, s) => ok(s) && void grant(s).then((ep) => ep && !ep.closed && ep.push("store.set", a, tag + s)));
        out.handle("store.sub", async (a, s) => {
            if (!ok(s)) throw new Error("store.sub: this script's stores aren't reachable here");
            const ep = await grant(s);
            if (!ep) throw Object.assign(new Error("store.sub: no link to the extension"), { name: "DisconnectedError" });
            return ep.call("store.sub", a, tag + s);
        });
    }

    function isoStores(): ReplicaHub {
        if (isoHub) return isoHub;
        const [hubSide, out] = endpointPair();
        isoOut = out;
        relayStores(out, isoGrants.get, ISO_STORE_TAG);
        isoHub = new ReplicaHub({ ctx: "isolated", log: (s, msg, level) => scriptLog(s, level, msg, "isolated") });
        isoHub.prime(isoPrimed);
        isoHub.attach(hubSide);
        return isoHub;
    }

    // ---- `wt.siteStore`: the hook holds them; mirrors here (MV2 onPage code,
    // the onSite fallback) and in the overlays (relayed) connect over window messages ----
    let siteMirrors: SiteMirrors | null = null;
    const postSite = (m: SiteUp) => window.postMessage({ source: MAIN_SOURCE, ...m }, location.origin);
    const siteStores = () => (siteMirrors ??= new SiteMirrors({ ctx: "bridge", post: postSite, log: (s, msg, level) => scriptLog(s, level, msg, "isolated") }));
    /** an overlay's subscriptions: sub → its script */
    const overlaySubs = new Map<string, string>();

    /** an overlay's mirror message → the hook: for its own script's stores only */
    function relaySiteUp(s: string, m: any): void {
        if (!m || !SITE_UP_KINDS.has(m.kind) || (m.kind !== "site.set" && typeof m.sub !== "string")) return;
        if (m.kind === "site.disconnect") {
            if (overlaySubs.get(m.sub) !== s) return;
            overlaySubs.delete(m.sub);
        } else {
            if (m.s !== s) return;
            if (m.kind === "site.connect") {
                const had = overlaySubs.get(m.sub);
                if (had !== undefined && had !== s) return;
                overlaySubs.set(m.sub, s);
            }
        }
        postSite(m);
    }

    function relaySiteDown(d: SiteDown): void {
        if (d.kind === "site.ready") {
            for (const o of overlays.values()) o.ep?.push("site.down", d);
            return;
        }
        const s = typeof d.sub === "string" ? overlaySubs.get(d.sub) : undefined;
        if (s !== undefined) overlays.get(s)?.ep?.push("site.down", d);
    }

    /** script `s`'s overlay went: its subscriptions end */
    function dropOverlaySubs(s: string): void {
        for (const [sub, of] of [...overlaySubs])
            if (of === s) {
                overlaySubs.delete(sub);
                postSite({ kind: "site.disconnect", sub });
            }
    }

    /** scripts whose onSite fallback code already reported calling a handle */
    const siteCallers = new Set<string | null>();

    // isolated code's built-in React: evaluated here from the background's copy (a <script> tag would put it in the page)
    if (!__MV3__)
        setBuiltinLoader(
            sourceLoader(() => new Promise((resolve, reject) => safeSend({ type: "getBuiltinReact" }, (r: any) => (typeof r?.src === "string" ? resolve(r.src) : reject(new Error(r?.error || "no answer from the extension"))))))
        );

    /** per world, per script: its runs here (shared/runLifecycle.ts) */
    const lives = { isolated: new Map<string, ScriptLife>(), page: new Map<string, ScriptLife>() };
    /** per script: its `react-dom/client` (for `ctx.mount` in onPage code) */
    const reactDoms = new Map<string, () => ReactDomClient>();

    function runPageScripts(handlers: DocumentHandler[], libSources: ShippedLib[], world: "page" | "isolated", hot: boolean, loaded = false): void {
        if (dead) return;
        if (world === "isolated" && !loaded) {
            const { codes, packages } = shippedSources(handlers.map((h) => h.src), libSources);
            if (!builtinsReady(codes, packages)) {
                ensureBuiltins(codes, packages)
                    .catch((e: any) => {
                        for (const h of handlers) scriptLog(h.scriptId, "error", formatScriptError(h.name, new Error(`the built-in React didn't load: ${e?.message || e}`), "onPage"), "isolated");
                    })
                    .then(() => runPageScripts(handlers, libSources, world, hot, true));
                return;
            }
        }
        const api: PlaceApi = world === "isolated" ? "onPage" : "onSite";
        const what = world === "isolated" ? "onPage" : "onSite (isolated-world fallback)";
        dlog("debug", `${what}: running ${handlers.length} script(s)${hot ? " (hot refire)" : ""}`);
        const exposers = world === "isolated" ? isoExposers : fallbackExposers;
        // the onSite fallback is still page code
        const ctx: ScriptContext = world === "isolated" ? "isolated" : "page";
        for (const [id, ex] of [...exposers])
            if (!handlers.some((h) => h.scriptId === id)) {
                ex.close();
                exposers.delete(id);
                lives[world].get(id)?.stop();
                lives[world].delete(id);
                if (world === "isolated") abortCalls(id, "the script stopped");
            }
        // onPage code's handles: its onSite handlers (the page's world), its own (here), its overlay (top frame)
        // a compile's handles call with its signal: they abort once a reload replaced it and its runs ended
        const handle = (scriptId: string, gen: Generation) => (api: PlaceApi, key: string) => {
            const sig = () => gen.signal;
            return api === "onSite"
                ? pageClient(scriptId).remote(key, sig)
                : api === "onPage"
                  ? localClient(scriptId).remote(key, sig)
                  : window === top
                    ? overlayClient(scriptId).remote(key, sig)
                    : inertRemote(TOP_FRAME_ONLY);
        };
        const shimFor = (scriptId: string | null, name: string, params: Record<string, any>, exposer?: Exposer, storesOf?: string, gen?: Generation) =>
            makePageShim({
                params,
                world,
                exposer,
                stores:
                    world === "isolated" && storesOf
                        ? { store: (n, initial, persist) => isoStores().store(storesOf, n, initial, persist), pageStore: (n, initial) => isoStores().pageStore(storesOf, n, initial, isoPage) }
                        : undefined,
                call: scriptId && gen && world === "isolated" ? handle(scriptId, gen) : undefined,
                siteStore: scriptId ? (n, initial) => siteStores().store(scriptId, n, initial) : undefined,
                // the onSite fallback reports a handle call like the hook does (once per script)
                onSiteCall: (e) => {
                    if (siteCallers.has(scriptId)) return;
                    siteCallers.add(scriptId);
                    scriptLog(scriptId, "error", formatScriptError(name, e, "onSite"), ctx);
                },
                log: (...args: any[]) => scriptLog(scriptId, "info", scriptLogLine(name, "wt.log", formatLogArgs(args)), ctx),
                storage: {
                    get: (key: string) => new Promise((r) => safeSend({ type: "scriptStorageGet", scriptId, key }, (x: any) => r(x && x.value))),
                    set: (key: string, value: any) => new Promise((r) => safeSend({ type: "scriptStorageSet", scriptId, key, value }, () => r(null))),
                },
            });
        for (const h of handlers) {
            let exposer = exposers.get(h.scriptId);
            if (!exposer) exposers.set(h.scriptId, (exposer = new Exposer()));
            else exposer.reset();
            let life = lives[world].get(h.scriptId);
            if (!life) {
                const id = h.scriptId;
                life = new ScriptLife({ doc: document, react: world === "isolated" ? () => reactDoms.get(id)!() : undefined, onError: (e) => scriptLog(id, "error", formatScriptError(h.name, e, "teardown"), ctx) });
                lives[world].set(id, life);
            }
            const gen = life.begin();
            // shadow console like the MAIN-world path: script console.*
            // calls go to the extension LOG, not the page console
            const consoleProxy = makeScriptConsole((level, source, text) => scriptLog(h.scriptId, level, scriptLogLine(h.name, source, text), ctx));
            let dom: PageDocumentHandler[];
            try {
                // page-side require over the shipped library sources and data files
                const codeOf = (importer: string) => (importer === h.name ? h.src : (libSources.find((l) => l.name === importer)?.src ?? ""));
                const requireFrom = makeLibRequire(
                    libSources,
                    (lib, require, moduleObj) => scriptFunction(lib.src!, lib.name)(shimFor(null, lib.name, lib.params || {}, undefined, h.scriptId).wt, consoleProxy, require, moduleObj, moduleObj.exports),
                    // the built-ins: isolated code all of them, the onSite fallback valtio's core
                    world === "isolated" ? { builtin: (spec, importer, loadUrl) => builtinModule(spec, codeOf(importer), loadUrl) } : { builtin: siteBuiltin, onSite: true }
                );
                const moduleObj = { exports: {} as any };
                const shim = shimFor(h.scriptId, h.name, h.params || {}, exposer, h.scriptId, gen);
                scriptFunction(h.src, h.name)(shim.wt, consoleProxy, requireFrom(h.name), moduleObj, moduleObj.exports);
                dom = shim.dom;
                if (world === "isolated") reactDoms.set(h.scriptId, () => requireFrom(h.name)("react-dom/client"));
            } catch (e: any) {
                // the previous code keeps running
                exposer.revert();
                exposer.done();
                life.discard(gen);
                scriptLog(h.scriptId, "error", formatScriptError(h.name, e, `${what} compile`), ctx);
                continue;
            }
            const matching = domHandlersFor(dom, location.href, exposer);
            exposer.done();
            for (const d of matching) {
                const run = () => {
                    try {
                        fireRun(life, gen, d, pageCtxBase(location.href), exposer, (e) => scriptLog(h.scriptId, "error", formatScriptError(h.name, e, api), ctx));
                        scriptRan(h.scriptId, h.name, api);
                    } catch (e: any) {
                        scriptLog(h.scriptId, "error", formatScriptError(h.name, e, api), ctx);
                    }
                };
                scheduleDocument(d.when, run, hot);
            }
            life.commit(gen);
        }
    }

    /** onSite handlers, here because the page CSP blocks eval in the page */
    async function runDocumentHandlers(hot: boolean): Promise<void> {
        if (dead) return;
        // handlers come embedded in the hook bundle (getHookBundle)
        const bundle = await new Promise<any>((resolve) => {
            safeSend({ type: "getHookBundle", url: location.href }, (r: any) => resolve(r || { domHandlers: [] }));
            // dead bridge: safeSend never answers — resolve empty after a beat
            setTimeout(() => resolve({ domHandlers: [] }), 1000);
        });
        runPageScripts(bundle.domHandlers || [], bundle.libs || [], "page", hot);
    }

    let hookBroken = false;

    // ---- L2: the `wt-bridge` port to the background ----
    //
    // Opened once this frame has scripts, so bundle updates come over it;
    // frames without one keep getting the one-shot `bundleUpdate`. A drop
    // (an MV3 service worker stopping) is not redialled while nothing
    // holds the port — a reconnect would wake the worker again — the next
    // bundle reopens it. Holders (the overlay, Phase 2) get a backoff
    // reconnect, 50 ms doubling to 2 s.
    let l2: Endpoint | null = null;
    let l2Holders = 0;
    let l2Backoff = 50;
    let l2Timer: ReturnType<typeof setTimeout> | null = null;
    let l2Opened = 0;
    const l2Waiters: (() => void)[] = [];
    function openPort(): void {
        if (dead || l2) return;
        let port: chrome.runtime.Port;
        try {
            port = chrome.runtime.connect({ name: "wt-bridge" });
        } catch (e: any) {
            if (CONTEXT_DEAD.test(e?.message || "")) markDead();
            return;
        }
        const ep = portEndpoint(port, { debug: (m) => dlog("debug", "wt-bridge:", m) });
        l2 = ep;
        ep.on("bundle.update", () => guard(() => onBundleUpdate()));
        // an overlay's store updates (the background only sends those of scripts with an overlay here)
        // (and isolated onPage code's, tagged ISO_STORE_TAG + s)
        for (const op of ["store.patch", "store.reject", "store.drop"] as const)
            ep.on(op, (a: any, s) => {
                if (s === undefined) return;
                if (s.startsWith(ISO_STORE_TAG)) isoOut?.push(op, a, s.slice(ISO_STORE_TAG.length));
                else overlays.get(s)?.ep?.push(op, a, s);
            });
        // MV3: the overlay ⇄ isolated-world relay (the background checks tab, frame and script)
        ep.on("iso.result", (r, s) => {
            const p = isRpcResult(r) ? isoPending.get(r.cid) : undefined;
            if (!p || p.s !== s) return;
            isoPending.delete(r.cid);
            p.reply(r);
        });
        ep.on("iso.call", (c, s) => guard(() => s !== undefined && isRpcCall(c) && callOverlayFromIso(s, c)));
        // a new link (after a drop, or a new service worker): re-grant each
        // overlay (a fresh nonce), then its replicas re-declare and re-subscribe
        if (l2Opened++)
            for (const o of overlays.values())
                if (o.ep)
                    ep.call("overlay.open", { nonce: newNonce(), url: o.url }, o.info.scriptId).then(
                        () => o.ep?.push("store.resync", {}),
                        (e: any) => dlog("warn", `overlay ${o.info.name}: no longer granted: ${e?.message || e}`)
                    );
        for (const w of l2Waiters.splice(0)) w();
        // isolated code's replicas re-grant (on first use) and re-subscribe
        isoGrants.reset();
        isoHub?.reconnect();
        ep.onClose(() => {
            if (l2 === ep) l2 = null;
            for (const [cid, p] of [...isoPending])
                if (p.ep === ep) {
                    isoPending.delete(cid);
                    p.reply({ cid, ok: false, error: { name: "DisconnectedError", message: "the link to the extension dropped" } });
                }
            if (dead || (!l2Holders && !isoHub) || l2Timer) return;
            l2Timer = setTimeout(() => {
                l2Timer = null;
                openPort();
            }, l2Backoff);
            l2Backoff = Math.min(l2Backoff * 2, 2000);
        });
        // a port that lasts a moment is healthy again: reset the backoff
        setTimeout(() => {
            if (l2 === ep) l2Backoff = 50;
        }, 2000);
    }

    /** the L2 link, (re)opening the port first; it waits up to 5 s for a reconnect */
    async function l2up(op: string): Promise<Endpoint> {
        if (!l2 && !l2Timer) openPort();
        if (!l2)
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => reject(Object.assign(new Error(`${op}: no link to the extension`), { name: "DisconnectedError" })), 5000);
                l2Waiters.push(() => {
                    clearTimeout(t);
                    resolve();
                });
            });
        return l2!;
    }

    /** an L2 call, (re)opening the port first */
    async function l2call<K extends ReqOps>(op: K, a: ReqOf<K>, s: string): Promise<ResOf<K>> {
        return (await l2up(op)).call(op, a, s);
    }

    /** scripts changed: refresh hook status; onPage refires in the MAIN world (hook) when healthy, else here (isolated) */
    function onBundleUpdate(): void {
        if (hookBroken) void runDocumentHandlers(true);
        safeSend({ type: "getHookBundle", url: location.href }, (resp: any) => {
            noteBundle(resp, true);
            postStatus(resp, true);
        });
    }

    // ---- the overlay host (top frame) ----
    //
    // One iframe per script (overlay.html, a web-accessible extension page)
    // in a closed shadow root: the page can't find the frames or read their
    // URLs. Each frame's URL hash is a one-time nonce; on load the bridge
    // posts it a MessagePort, and the frame proves itself by sending the
    // nonce back (`hello`) — a page that navigated the frame away gets a
    // port it can't use. The frame covers the viewport and is clipped to
    // what it draws, so clicks elsewhere reach the page.

    interface OverlayInfo {
        scriptId: string;
        name: string;
        routes: RouteMeta[];
        codeHash: string;
    }
    interface Overlay {
        info: OverlayInfo;
        /** the page it was opened for */
        url: string;
        nonce: string;
        frame: HTMLIFrameElement | null;
        /** the L3 link, once the frame proved itself */
        ep: Endpoint | null;
        /** isolated-world calls waiting for the frame */
        queue: RpcCall[];
        closed: boolean;
    }
    const overlays = new Map<string, Overlay>();
    /** isolated-world `overlay.fn()` callers, per script */
    const overlayClients = new Map<string, RpcClient>();
    /** MV3: overlay → isolated-world calls waiting for the background's answer (L2), by cid */
    const isoPending = new Map<string, { s: string; reply: (r: RpcResult) => void; ep?: Endpoint }>();
    /** MV3: isolated-world → overlay calls the overlay hasn't answered yet, by cid */
    const isoRelayed = new Map<string, { s: string }>();
    /** overlay → main-world calls waiting for the hook (L4), by cid */
    const l4Pending = new Map<string, { s: string; reply: (r: RpcResult) => void }>();
    let host: HTMLElement | null = null;
    let shadow: ShadowRoot | null = null;
    let zTop = 0;
    let lastOverlays: OverlayInfo[] = [];

    const newNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const PHASES: DocumentWhen[] = ["document_start", "document_end", "document_idle"];
    const phaseNow = (): DocumentWhen => (document.readyState === "complete" ? "document_idle" : document.readyState === "interactive" ? "document_end" : "document_start");
    const callError = (cid: string, message: string): RpcResult => ({ cid, ok: false, error: { name: "WtCallError", message } });

    // ctx.shortcut: keys pressed in the page. Listening from the start puts
    // the capture listener ahead of the page's own; only trusted events count,
    // and the page sees nothing but the default prevented on a match.
    const shortcuts = new ShortcutRegistry(undefined, (s) => {
        const i = lastOverlays.findIndex((o) => o.scriptId === s);
        return i < 0 ? Infinity : i;
    });
    if (window === top)
        watchShortcuts(
            window,
            (e) => (shortcuts.size ? shortcuts.find(e) : []),
            (hits) =>
                guard(() => {
                    const o = overlays.get(hits[0].s);
                    if (!o?.ep) return;
                    if (o.frame && o.frame.style.zIndex !== String(zTop)) o.frame.style.zIndex = String(++zTop);
                    for (const h of hits) o.ep.push("shortcut.fire", { id: h.id });
                })
        );

    /** the bundle's overlays for this page: start new ones, update changed ones in place (code hash), drop the rest */
    function syncOverlays(list: OverlayInfo[], hot: boolean): void {
        if (dead) return;
        lastOverlays = list;
        const want = new Map(list.map((o) => [o.scriptId, o]));
        for (const s of [...overlays.keys()]) if (!want.has(s)) removeOverlay(s, "was disabled or no longer matches this page");
        for (const info of list) {
            const old = overlays.get(info.scriptId);
            if (old && old.info.codeHash === info.codeHash) {
                old.info = info;
                continue;
            }
            // a running frame recompiles in place (its runs reconcile); one still starting starts over
            if (old?.ep && !old.closed) {
                old.info = info;
                updateOverlay(old);
                continue;
            }
            if (old) removeOverlay(info.scriptId, "reloaded");
            createOverlay(info, hot || !!old);
        }
        l2Holders = overlays.size;
        if (overlays.size) watchNavigation();
    }

    function createOverlay(info: OverlayInfo, now: boolean): void {
        const o: Overlay = { info, url: location.href, nonce: newNonce(), frame: null, ep: null, queue: [], closed: false };
        overlays.set(info.scriptId, o);
        const first = PHASES[Math.min(...info.routes.map((r) => PHASES.indexOf(r.when || "document_end")))] || "document_end";
        scheduleDocument(first, () => guard(() => void mountOverlay(o)), now);
    }

    function updateOverlay(o: Overlay): void {
        const s = o.info.scriptId;
        l2call("overlay.init", {}, s).then(
            (init) => {
                if (!o.closed && o.ep && overlays.get(s) === o) o.ep.push("overlay.update", { ...init, phase: phaseNow() });
            },
            (e: any) => scriptLog(s, "error", scriptLogLine(o.info.name, "overlay", `couldn't update: ${e?.message || e}`))
        );
    }

    function ensureHost(): ShadowRoot {
        if (host && shadow && host.isConnected) return shadow;
        if (!host || !shadow) {
            host = document.createElement("wiretrick-ui");
            shadow = host.attachShadow({ mode: "closed" });
            host.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:auto!important;height:auto!important;z-index:2147483647!important;pointer-events:none!important;visibility:visible!important;opacity:1!important;transform:none!important;contain:strict!important";
            // a page that rewrites its <html> drops the host: put it back (its frames reload)
            new MutationObserver(() => {
                if (host && !host.isConnected && overlays.size && !dead) {
                    document.documentElement.appendChild(host);
                    for (const s of [...overlays.keys()]) removeOverlay(s, "reloaded");
                    syncOverlays(lastOverlays, true);
                }
            }).observe(document, { childList: true, subtree: true });
        }
        document.documentElement.appendChild(host);
        return shadow;
    }

    async function mountOverlay(o: Overlay): Promise<void> {
        if (o.closed || dead || o.frame) return;
        const s = o.info.scriptId;
        try {
            await l2call("overlay.open", { nonce: o.nonce, url: o.url }, s);
        } catch (e: any) {
            scriptLog(s, "error", scriptLogLine(o.info.name, "overlay", `couldn't start: ${e?.message || e}`));
            return;
        }
        if (o.closed || dead) return;
        const frame = document.createElement("iframe");
        o.frame = frame;
        frame.src = chrome.runtime.getURL("overlay.html") + "#" + o.nonce;
        frame.setAttribute("allowtransparency", "true");
        frame.setAttribute("aria-label", `${o.info.name} (Wiretrick)`);
        // same color-scheme inside and out, or Chromium paints the frame opaque
        frame.style.cssText = `all:initial;position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;pointer-events:auto;z-index:${++zTop};clip-path:${clipPathFor([])}`;
        frame.addEventListener("load", () => guard(() => connectOverlay(o)), { once: true });
        ensureHost().appendChild(frame);
    }

    function connectOverlay(o: Overlay): void {
        if (o.closed || !o.frame?.contentWindow) return;
        const s = o.info.scriptId;
        const { port1, port2 } = new MessageChannel();
        const ep = messagePortEndpoint(port1, { debug: (m) => dlog("debug", `overlay ${o.info.name}:`, m) });
        let proven = false;
        const log = (level: ScriptLogLevel, msg: string) => scriptLog(s, level, msg);
        ep.handle("hello", async ({ nonce }) => {
            if (proven || nonce !== o.nonce) {
                ep.close("refused");
                throw new Error("refused");
            }
            proven = true;
            o.ep = ep;
            scriptRan(s, o.info.name, "onOverlay");
            const init = await l2call("overlay.init", {}, s);
            queueMicrotask(() => {
                for (const call of o.queue.splice(0)) ep.push("rpc.call", call);
            });
            return { ...init, phase: phaseNow() };
        });
        const mine = <T>(fn: (a: T) => any) => (a: T) => {
            if (proven && !o.closed) return fn(a);
            throw new Error("refused");
        };
        // the frame's script: its stores, fetches and storage, for script `s` only
        ep.on("store.declare", (a) => proven && l2?.push("store.declare", a, s));
        ep.on("store.set", (a) => proven && l2?.push("store.set", a, s));
        ep.handle("store.sub", mine((a: ReqOf<"store.sub">) => l2call("store.sub", a, s)));
        ep.handle("fetch", mine((a: ReqOf<"fetch">) => l2call("fetch", { request: a.request, bypass: !!a.bypass }, s)));
        ep.handle("pagefetch", mine((a: ReqOf<"pagefetch">) => pageFetch(s, a.request, !!a.bypass)));
        ep.handle("storage.get", mine((a: ReqOf<"storage.get">) => new Promise((r) => safeSend({ type: "scriptStorageGet", scriptId: s, key: a.key }, (x: any) => r({ value: x?.value })))));
        ep.handle("storage.set", mine((a: ReqOf<"storage.set">) => new Promise((r) => safeSend({ type: "scriptStorageSet", scriptId: s, key: a.key, value: a.value }, () => r({})))));
        ep.on("log", (a) => proven && scriptLog(s, ["debug", "info", "warn", "error"].includes(a?.level) ? a.level : "info", String(a?.msg ?? ""), "overlay"));
        ep.on("rects", (a) => {
            if (proven && o.frame && Array.isArray(a?.rects)) o.frame.style.clipPath = clipPathFor(normalizeRects(a.rects, window.innerWidth, window.innerHeight));
        });
        ep.on("focus", () => {
            if (proven && o.frame && o.frame.style.zIndex !== String(zTop)) o.frame.style.zIndex = String(++zTop);
        });
        ep.on("shortcut.add", (a) => {
            if (!proven || o.closed || typeof a?.id !== "string" || typeof a.keys !== "string" || a.id.length > 32 || a.keys.length > 64) return;
            let r: ReturnType<ShortcutRegistry["add"]>;
            try {
                r = shortcuts.add(s, a.id, a.keys, a.priority === "after-page" ? "after-page" : "before-page");
            } catch {
                return;
            }
            // the warning goes to the script that lost the keys
            const nameOf = (x: string) => overlays.get(x)?.info.name ?? x;
            if (r.taken) log("warn", scriptLogLine(o.info.name, "overlay", `shortcut ${a.keys}: "${nameOf(r.taken)}" (earlier in the list) uses these keys too and keeps them`));
            if (r.displaced) scriptLog(r.displaced, "warn", scriptLogLine(nameOf(r.displaced), "overlay", `shortcut ${a.keys}: "${o.info.name}" (earlier in the list) uses these keys too and keeps them`));
        });
        ep.on("shortcut.remove", (a) => proven && typeof a?.id === "string" && shortcuts.remove(s, a.id));
        ep.on("rpc.call", (c) => proven && isRpcCall(c) && routeOverlayCall(s, c, (r) => ep.push("rpc.result", r)));
        ep.on("site.up", (m) => proven && !o.closed && relaySiteUp(s, m));
        ep.on("rpc.result", (r) => {
            if (!proven) return;
            const rel = isRpcResult(r) ? isoRelayed.get(r.cid) : undefined;
            if (!rel || rel.s !== s) return void overlayClients.get(s)?.receive(r);
            isoRelayed.delete(r.cid);
            l2?.push("iso.result", r, s);
        });
        ep.onClose(() => {
            if (o.ep === ep) removeOverlay(s, "closed");
        });
        // not the nonce: the frame has to know it
        o.frame.contentWindow.postMessage({ wtOverlay: true }, "*", [port2]);
        // a frame that never says hello (navigated away, blocked) is dropped
        setTimeout(() => {
            if (!proven && !o.closed) {
                ep.close("no hello");
                log("warn", scriptLogLine(o.info.name, "overlay", "the overlay frame didn't start"));
            }
        }, 15000);
    }

    function removeOverlay(s: string, why: string): void {
        const o = overlays.get(s);
        if (!o) return;
        overlays.delete(s);
        o.closed = true;
        shortcuts.removeScript(s);
        dropOverlaySubs(s);
        o.frame?.remove();
        o.ep?.close(why);
        for (const call of o.queue.splice(0)) overlayClients.get(s)?.receive(callError(call.cid, NOT_RUNNING));
        // MV3: the isolated side's calls end with the `overlay.closed` below
        for (const [cid, r] of [...isoRelayed])
            if (r.s === s) isoRelayed.delete(cid);
        overlayClients.get(s)?.disconnect(`the overlay ${why}`);
        l2?.push("overlay.closed", {}, s);
        l2Holders = overlays.size;
    }

    /** the isolated world's caller into script `s`'s overlay */
    function overlayClient(s: string): RpcClient {
        let c = overlayClients.get(s);
        if (c) return c;
        c = new RpcClient((call) => {
            const o = overlays.get(s);
            if (!o) return void queueMicrotask(() => c!.receive(callError(call.cid, NOT_RUNNING)));
            if (o.ep) return o.ep.push("rpc.call", call);
            if (o.queue.length >= RPC_QUEUE_MAX) return void queueMicrotask(() => c!.receive(callError(call.cid, `${call.fn}(): too many calls waiting for the overlay`)));
            o.queue.push(call);
        });
        overlayClients.set(s, c);
        return c;
    }

    /** MV3: isolated code calls script `s`'s overlay (relayed by the background) */
    function callOverlayFromIso(s: string, call: RpcCall): void {
        const o = window === top ? overlays.get(s) : undefined;
        const fail = (message: string) => l2?.push("iso.result", callError(call.cid, message), s);
        if (!o || o.closed) return void fail(NOT_RUNNING);
        if (!o.ep && o.queue.length >= RPC_QUEUE_MAX) return void fail(`${call.fn}(): too many calls waiting for the overlay`);
        isoRelayed.set(call.cid, { s });
        if (o.ep) o.ep.push("rpc.call", call);
        else o.queue.push(call);
    }

    /** MV3: the overlay calls isolated code, in a user-script world (through the background) */
    function callIso(s: string, call: RpcCall, reply: (r: RpcResult) => void): void {
        if (isoOff) return reply(callError(call.cid, isoOff));
        const p: { s: string; reply: (r: RpcResult) => void; ep?: Endpoint } = { s, reply };
        isoPending.set(call.cid, p);
        l2up("iso.call").then(
            (ep) => {
                if (isoPending.get(call.cid) !== p) return;
                p.ep = ep;
                ep.push("iso.call", call, s);
            },
            (e: any) => {
                if (isoPending.get(call.cid) !== p) return;
                isoPending.delete(call.cid);
                reply({ cid: call.cid, ok: false, error: { name: "DisconnectedError", message: String(e?.message || e) } });
            }
        );
    }

    /** an overlay's call into one of its script's handles, by the handle's key: onPage (here, or a user-script world on MV3), onSite (the CSP fallback here, else the hook) */
    function routeOverlayCall(s: string, call: RpcCall, reply: (r: RpcResult) => void): void {
        if (call.h.startsWith("onPage:")) {
            if (__MV3__) return isoScripts.has(s) ? callIso(s, call, reply) : reply(callError(call.cid, NOT_RUNNING));
            const iso = isoExposers.get(s);
            return iso ? iso.answer(call, reply) : reply(callError(call.cid, NOT_RUNNING));
        }
        if (call.h.startsWith("onSite:")) return callSite(s, call, reply);
        reply(callError(call.cid, NOT_RUNNING));
    }

    /** a call into the script's onSite code: the CSP fallback here, else the hook (L4) */
    function callSite(s: string, call: RpcCall, reply: (r: RpcResult) => void): void {
        const fb = fallbackExposers.get(s);
        if (fb?.has(call.h)) return fb.answer(call, reply);
        if (pageScriptIds.has(s) && !hookBroken) return callHook(s, call, reply);
        reply(callError(call.cid, NOT_RUNNING));
    }

    /** a call into the script's main-world onPage code (L4) */
    function callHook(s: string, call: RpcCall, reply: (r: RpcResult) => void): void {
        l4Pending.set(call.cid, { s, reply });
        window.postMessage({ source: MAIN_SOURCE, kind: "rpc.call", s, call }, window.location.origin);
    }

    /** onPage code → its script's onSite handlers; the answers are page data */
    const pageClients = new Map<string, RpcClient>();
    function pageClient(s: string): RpcClient {
        let c = pageClients.get(s);
        if (!c) {
            const client: RpcClient = new RpcClient((call) => callSite(s, call, (r) => client.receive(r)));
            pageClients.set(s, (c = client));
        }
        return c;
    }

    /** the script's onPage code reloaded or stopped: its pending calls end (AbortError) and are cancelled */
    function abortCalls(s: string, reason: string): void {
        pageClients.get(s)?.abort(reason);
        localClients.get(s)?.abort(reason);
        overlayClients.get(s)?.abort(reason);
    }

    /** onPage code → its own onPage handlers (MV2: here) */
    const localClients = new Map<string, RpcClient>();
    function localClient(s: string): RpcClient {
        let c = localClients.get(s);
        if (!c) {
            const client: RpcClient = new RpcClient((call) => {
                const ex = isoExposers.get(s);
                if (ex) ex.answer(call, (r) => client.receive(r));
                else client.receive(callError(call.cid, NOT_RUNNING));
            });
            localClients.set(s, (c = client));
        }
        return c;
    }

    /** `wt.fetch(…, { from: "page" })` and the overlay's `fetch`: this frame fetches, as the page (Firefox: the page's own fetch) */
    async function pageFetch(s: string, request: ReqOf<"pagefetch">["request"], bypass: boolean): Promise<ResOf<"pagefetch">> {
        const [url, init] = fromWireRequest(request, { credentials: "include" });
        const abs = new URL(url, location.href).href;
        if (bypass) await l2call("bypass.add", { tabId: -1, method: (init.method || "GET").toUpperCase(), url: abs }, s);
        const content = (globalThis as any).content;
        const f: typeof fetch = typeof content?.fetch === "function" ? (u, i) => content.fetch(u, i) : fetch;
        const res = await f(abs, init);
        const o = overlays.get(s);
        if (o) scriptRan(s, o.info.name, "pageFetch", abs);
        return toWireResponse(res);
    }

    // ---- in-place navigation (ctx.onNavigate) ----
    let navWatching = false;
    let lastHref = location.href;
    function watchNavigation(): void {
        if (navWatching) return;
        navWatching = true;
        // the isolated world can't see history.pushState: the hook nudges (`nav`)
        window.postMessage({ source: MAIN_SOURCE, kind: "watchNav" }, window.location.origin);
        window.addEventListener("popstate", () => noteNav());
        window.addEventListener("hashchange", () => noteNav());
        // pages whose hook is missing or broken: poll while overlays exist
        setInterval(() => overlays.size && noteNav(), 1000);
    }
    function noteNav(): void {
        if (location.href === lastHref) return;
        lastHref = location.href;
        for (const o of overlays.values()) o.ep?.push("nav", { url: lastHref });
    }

    // the overlays' `when`
    document.addEventListener("DOMContentLoaded", () => {
        for (const o of overlays.values()) o.ep?.push("when", { phase: "document_end" });
    });
    window.addEventListener("load", () => {
        for (const o of overlays.values()) o.ep?.push("when", { phase: "document_idle" });
    });

    chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
        // the background asks whether this frame has a live hook (see pipeline.ts checkMissed)
        if (msg && msg.type === "hookPing") {
            sendResponse({ ok: true });
            return false;
        }
        guard(() => {
            if (msg && msg.type === "hookCspBlocked") {
                hookBroken = true;
            }
            // with an open port the same update arrives as `bundle.update`
            if (msg && msg.type === "bundleUpdate" && !l2) onBundleUpdate();
        });
        return false;
    });

    // initial: inject the hook + register dom handlers
    function injectHook(): void {
        if (document.querySelector("script[data-res-override-hook]")) return;
        // MV2 Chromium: inline, so it runs now — before the page's own
        // scripts make their first requests (a src script runs later). MV2
        // content scripts' inline scripts aren't bound by the page CSP; if
        // one ever blocks it (Trusted Types…), src still works
        // (Firefox runs the hook as a MAIN-world content script already)
        if (!__MV3__ && !chrome.runtime.getURL("").startsWith("moz-extension:")) {
            const inline = document.createElement("script");
            inline.setAttribute("data-res-override-hook", "1");
            try {
                inline.textContent = __HOOK_SRC__;
                (document.head || document.documentElement).appendChild(inline);
            } catch {}
            const ran = inline.hasAttribute("data-res-ran");
            inline.remove();
            if (ran) return;
            dlog("debug", "the inline page hook didn't run (page CSP) — injecting it by src");
        }
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("hook.js");
        script.setAttribute("data-res-override-hook", "1");
        (document.head || document.documentElement).appendChild(script);
        script.addEventListener("load", () => script.remove());
    }

    async function init(): Promise<void> {
        dlog("debug", "bridge ready", { href: location.href, readyState: document.readyState });
        earlyBundle = askBundle();
        injectHook();
        // isolated handlers must not depend on the page hook asking for its status
        setTimeout(() => {
            if (!isoFired && !dead) safeSend({ type: "getHookBundle", url: location.href }, (resp: any) => noteBundle(resp, false));
        }, 1500);
    }

    void init();
})();
