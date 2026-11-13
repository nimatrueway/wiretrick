/**
 * Chrome MV3: the runtime for one script's `tt.onPage` code,
 * in a `chrome.userScripts` USER_SCRIPT world (background/userScripts.ts
 * registers it after a one-line prelude naming the script). The world
 * shares the page's DOM, not its JavaScript, and the page can't reach it.
 *
 * Where one of the script's isolated routes matches the frame, it opens the
 * L6 port (`tt-user-script`) to the owner and asks for the code
 * (`iso.load`), then compiles it the way the bridge does in MV2
 * (`runPageScripts`) and runs the handlers at their `when`. Over L6 go the
 * script's Log lines and `tt.storage`, and — in the top frame — the calls
 * between this code and the script's overlay, which the owner relays
 * through the page's bridge (L2) to the overlay frame (L3). Calls into its
 * onSite handles go to the hook over window messages; into its own onPage
 * handles, straight to this world's handlers. Its stores
 * (`tt.globalStore`, this page's `tt.pageStore` copies) are replicas
 * primed by `iso.load` and synced over L6; its `tt.siteStore`s are
 * mirrors of the hook's, over window messages. A save arrives as
 * `iso.update`: load again, re-run if the code changed.
 */
import { formatScriptError } from "../shared/scriptError";
import { makeScriptConsole, formatLogArgs, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";
import { makeLibRequire } from "../shared/scriptImports";
import { builtinsReady, scriptBuiltin, ensureBuiltins, setBuiltinLoader, shippedSources, sourceLoader } from "../shared/builtins";
import { makePageShim, domHandlersFor, scheduleDocument, fireRun, pageCtxBase, type PageDocumentHandler } from "../shared/pageShim";
import { reactOf, ScriptLife, type Generation, type ReactDomClient } from "../shared/runLifecycle";
import { hotRegistry } from "../shared/hotRefresh";
import { portEndpoint, type Endpoint, type IsoInit } from "../shared/wire";
import { Exposer, RpcClient, isRpcCall, TOP_FRAME_ONLY, type RpcResult } from "../shared/rpc";
import { inertRemote } from "../shared/remote";
import { routeMatches, type PlaceApi, type RouteMeta } from "../shared/route";
import { ReplicaHub } from "../shared/storeReplica";
import { tabScopeOfPage } from "../shared/storeOps";
import { SiteMirrors } from "../shared/siteStoreMirror";
import { SITE_DOWN_KINDS } from "../shared/siteStoreHost";
import { FrameShortcuts } from "../shared/shortcut";

(() => {
    const me = ((globalThis as any).__ttIsoQ as { s: string; routes: RouteMeta[] }[] | undefined)?.shift();
    if (!me || !me.routes.some((r) => routeMatches(r, location.href))) return;
    const s = me.s;
    const top = window === window.top;
    /** the script's name (from iso.load), for errors raised before or outside a run */
    let scriptName = s;

    let current: Endpoint | null = null;
    let link: Promise<Endpoint> | null = null;
    /** the owner refused this frame: nothing more to do */
    let stopped = false;
    /** keep the link up (top frame with an overlay: its calls must find us) */
    let eager = false;
    let backoff = 50;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let codeHash: string | null = null;
    let tries = 0;

    /** the script's store replicas (made when its code first uses one) */
    let hub: ReplicaHub | null = null;
    let page = "";

    const exposer = new Exposer();
    const client = new RpcClient((call) => {
        linkUp().then(
            (ep) => ep.push("rpc.call", call, s),
            () => client.receive({ cid: call.cid, ok: false, error: { name: "DisconnectedError", message: `${call.fn}(): no link to the extension` } })
        );
    });

    // calls into the script's onSite handlers: straight to the hook (main
    // world) over window messages. The page sees and can forge both ways, so
    // the answers are page data. A handle whose route matches the page tags
    // its calls with this version of the onSite code: the hook waits for it
    // when a save reached this world first (hook.ts answerCall).
    let siteV = "";
    let siteHere = new Set<string>();
    const pageClient = new RpcClient((call) =>
        window.postMessage({ source: "res-override-bridge", kind: "rpc.call", s, call, v: siteHere.has(call.h) ? siteV : undefined }, location.origin)
    );
    // calls into its own onPage handlers: answered here (JSON copies, like any handle's)
    const local: RpcClient = new RpcClient((call) => exposer.answer(call, (r) => local.receive(r)));
    // a compile's handles call with its signal: they abort once a reload replaced it and its runs ended
    const handle = (gen: Generation) => (api: PlaceApi, key: string, route: RouteMeta) => {
        const sig = () => gen.signal;
        if (api === "onSite" && routeMatches(route, location.href)) siteHere.add(key);
        return api === "onSite" ? pageClient.remote(key, sig) : api === "onPage" ? local.remote(key, sig) : top ? client.remote(key, sig) : inertRemote(TOP_FRAME_ONLY);
    };
    let reactDom: () => ReactDomClient = () => {
        throw new Error("no React");
    };
    const life = new ScriptLife({ doc: document, react: () => reactDom() });
    /** ctx.shortcut: keys pressed in this frame (listening from the start, before the page) */
    const keys = new FrameShortcuts(window, {
        name: () => scriptName,
        error: (_s, e) => log("error", formatScriptError(scriptName, e, "ctx.shortcut")),
        warn: (_s, msg) => log("warn", msg),
    });
    window.addEventListener("message", (e: MessageEvent) => {
        const d = e.data;
        if (e.source !== window || !d || d.source !== "res-override-hook") return;
        if (d.kind === "rpc.result" && d.s === s) pageClient.receive(d.result);
        else if (SITE_DOWN_KINDS.has(d.kind)) site?.receive(d);
    });

    /** the bound link (opened and loaded on demand); rejects when the owner is unreachable or refused */
    function linkUp(): Promise<Endpoint> {
        if (stopped) return Promise.reject(new Error("stopped"));
        if (link) return link;
        const p = (async () => {
            const port = chrome.runtime.connect({ name: "tt-user-script" });
            const ep = portEndpoint(port);
            ep.on("rpc.call", (c) => isRpcCall(c) && exposer.answer(c, (r: RpcResult) => ep.push("rpc.result", r, s)));
            ep.on("rpc.result", (r) => client.receive(r));
            ep.on("overlay.closed", () => client.disconnect("the overlay closed"));
            ep.on("iso.update", () => void load(ep));
            ep.onClose(() => {
                if (current === ep) current = null;
                if (link === p) link = null;
                client.disconnect("the link to the extension closed");
                // reconnect while the first load is pending, while an overlay may call, and while stores are in use
                if ((eager || hub || (codeHash === null && ++tries < 10)) && !stopped && !timer)
                    timer = setTimeout(() => {
                        timer = null;
                        linkUp().catch(() => {});
                    }, backoff);
                backoff = Math.min(backoff * 2, 2000);
            });
            await load(ep);
            current = ep;
            // after load: ops need the link bound to the script
            hub?.attach(ep);
            setTimeout(() => {
                if (current === ep) backoff = 50;
            }, 2000);
            return ep;
        })();
        link = p;
        p.catch(() => {
            if (link === p) link = null;
        });
        return p;
    }

    /** ask for the code; run it when it changed */
    async function load(ep: Endpoint): Promise<void> {
        let init: IsoInit;
        try {
            init = await ep.call("iso.load", { url: location.href }, s);
        } catch (e: any) {
            if (e?.name !== "DisconnectedError" && e?.name !== "TimeoutError") {
                // disabled, deleted or no longer isolated here
                stopped = true;
                exposer.close();
                life.stop();
                keys.stop();
                site?.dispose();
                for (const c of [client, local, pageClient]) c.abort("the script stopped");
                ep.close("refused");
            }
            throw e;
        }
        eager = top && init.overlay;
        page = init.page;
        primed = { [s]: init.stores, ...init.libStores };
        hub?.prime(primed);
        if (init.codeHash !== codeHash) run(init, codeHash !== null);
    }

    /** the script's `tt.siteStore` mirrors (made when its code first uses one) */
    let site: SiteMirrors | null = null;
    const siteStores = () =>
        (site ??= new SiteMirrors({
            ctx: "isolated",
            post: (m) => window.postMessage({ source: "res-override-bridge", ...m }, location.origin),
            log: (_s, msg, level) => log(level, msg),
        }));

    let primed: Record<string, IsoInit["stores"]> = {};
    function stores(): ReplicaHub {
        if (hub) return hub;
        const h = (hub = new ReplicaHub({ ctx: "isolated", log: (_s, msg, level) => log(level, msg) }));
        h.prime(primed);
        // the first use is while the code runs (inside `load`): attach once the link is bound
        if (current) h.attach(current);
        else linkUp().catch(() => {});
        return h;
    }

    function log(level: ScriptLogLevel, msg: string): void {
        linkUp().then(
            (ep) => ep.push("log", { level, msg }, s),
            () => {}
        );
    }

    /** once per document: tags its Network row with this script */
    const ran = new Set<string>();
    function noteRan(api: "onPage", name: string): void {
        if (ran.has(api)) return;
        ran.add(api);
        linkUp().then(
            (ep) => ep.push("ran", { api, name }, s),
            () => {}
        );
    }

    // the built-in React: evaluated in this world from the owner's copy (a <script> tag would put it in the page)
    setBuiltinLoader(sourceLoader(() => linkUp().then((ep) => ep.call("builtin.react", {}, s))));

    function run(init: IsoInit, hot: boolean): void {
        if (codeHash !== null) exposer.reset();
        codeHash = init.codeHash;
        siteV = init.siteV;
        siteHere = new Set();
        scriptName = init.name;
        const { codes, packages } = shippedSources([init.src], init.libs);
        if (builtinsReady(codes, packages)) return exec(init, hot);
        ensureBuiltins(codes, packages).then(
            () => codeHash === init.codeHash && exec(init, hot),
            (e: any) => log("error", formatScriptError(init.name, new Error(`the built-in React didn't load: ${e?.message || e}`), "onPage"))
        );
    }

    function exec(init: IsoInit, hot: boolean): void {
        const gen = life.begin();
        const shimFor = (storeOwnerId: string, name: string, params: Record<string, any>, mine: boolean) =>
            makePageShim({
                params,
                world: "isolated",
                lib: mine ? undefined : name,
                stores: { store: (n, initial, persist) => stores().store(storeOwnerId, n, initial, persist), tabStore: (n, initial) => stores().tabStore(storeOwnerId, n, initial, tabScopeOfPage(page)), pageStore: (n, initial) => stores().pageStore(storeOwnerId, n, initial, page) },
                siteStore: mine ? (n, initial) => siteStores().store(s, n, initial) : undefined,
                exposer: mine ? exposer : undefined,
                call: mine ? handle(gen) : undefined,
                log: (...args: any[]) => log("info", scriptLogLine(name, "tt.log", formatLogArgs(args))),
                storage: {
                    get: (key: string) => linkUp().then((ep) => ep.call("storage.get", { key }, s)).then((r) => r.value, () => undefined),
                    set: (key: string, value: any) => linkUp().then((ep) => ep.call("storage.set", { key, value }, s)).then(() => null, () => null),
                },
                setParam: (key, value, lib) => linkUp().then((ep) => ep.call("param.set", { key, value, lib }, s)).then(() => undefined),
            });
        const consoleProxy = makeScriptConsole((level, source, text) => log(level, scriptLogLine(init.name, source, text)));
        let dom: PageDocumentHandler[];
        try {
            const codeOf = (importer: string) => (importer === init.name ? init.src : (init.libs.find((l) => l.name === importer)?.src ?? ""));
            const requireFrom = makeLibRequire(
                init.libs,
                (lib, require, moduleObj) => scriptFunction(lib.src!, lib.name)(shimFor(lib.id ?? s, lib.name, lib.params || {}, false).tt, consoleProxy, require, moduleObj, moduleObj.exports),
                { builtin: scriptBuiltin(codeOf, hotRegistry(init.name).begin()) }
            );
            const moduleObj = { exports: {} as any };
            const shim = shimFor(s, init.name, init.params || {}, true);
            shim.top(() => scriptFunction(init.src, init.name)(shim.tt, consoleProxy, requireFrom(init.name), moduleObj, moduleObj.exports));
            dom = shim.dom;
            reactDom = () => reactOf(requireFrom(init.name));
        } catch (e: any) {
            // the previous code keeps running
            exposer.revert();
            exposer.done();
            life.discard(gen);
            log("error", formatScriptError(init.name, e, "onPage compile"));
            return;
        }
        const matching = domHandlersFor(dom, location.href, exposer);
        exposer.done();
        for (const d of matching)
            scheduleDocument(
                d.when,
                () => {
                    try {
                        const base = pageCtxBase(location.href);
                        fireRun(
                            life,
                            gen,
                            d,
                            (signal) => ({ ...base, shortcut: (combo: string, fn: () => unknown, opts?: any) => keys.add(s, combo, fn, opts, signal) }),
                            exposer,
                            (e) => log("error", formatScriptError(init.name, e, "onPage"))
                        );
                        noteRan("onPage", init.name);
                    } catch (e: any) {
                        log("error", formatScriptError(init.name, e, "onPage"));
                    }
                },
                hot
            );
        life.commit(gen);
    }

    linkUp().catch(() => {});
})();
