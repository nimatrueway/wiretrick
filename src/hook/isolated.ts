/**
 * Chrome MV3: the runtime for one script's `world: "isolated"` onPage code,
 * in a `chrome.userScripts` USER_SCRIPT world (background/userScripts.ts
 * registers it after a one-line prelude naming the script). The world
 * shares the page's DOM, not its JavaScript, and the page can't reach it.
 *
 * Where one of the script's isolated routes matches the frame, it opens the
 * L6 port (`wt-user-script`) to the owner and asks for the code
 * (`iso.load`), then compiles it the way the bridge does in MV2
 * (`runPageScripts`) and runs the handlers at their `when`. Over L6 go the
 * script's Log lines and `wt.storage`, and — in the top frame — the calls
 * between this code and the script's overlay, which the owner relays
 * through the page's bridge (L2) to the overlay frame (L3). Its stores
 * (`wt.globalStore`, this page's `wt.pageStore` copies) are replicas
 * primed by `iso.load` and synced over L6. A save arrives as
 * `iso.update`: load again, re-run if the code changed.
 */
import { formatScriptError } from "../shared/scriptError";
import { makeScriptConsole, formatLogArgs, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { scriptFunction } from "../shared/scriptFn";
import { makeLibRequire } from "../shared/scriptImports";
import { makePageShim, domHandlersFor, scheduleDocument, firePageHandler, type PageDocumentHandler } from "../shared/pageShim";
import { portEndpoint, type Endpoint, type IsoInit } from "../shared/wire";
import { Exposer, RpcClient, isRpcCall, type RpcResult } from "../shared/rpc";
import { routeMatches, type RouteMeta } from "../shared/route";
import { ReplicaHub } from "../shared/storeReplica";
import { makePageEvaluate } from "../shared/pageEval";

(() => {
    const me = ((globalThis as any).__wtIsoQ as { s: string; routes: RouteMeta[] }[] | undefined)?.shift();
    if (!me || !me.routes.some((r) => routeMatches(r, location.href))) return;
    const s = me.s;
    const top = window === window.top;
    /** ctx.evaluate: the hook runs it in the page's world */
    const evaluate = makePageEvaluate();

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

    /** the bound link (opened and loaded on demand); rejects when the owner is unreachable or refused */
    function linkUp(): Promise<Endpoint> {
        if (stopped) return Promise.reject(new Error("stopped"));
        if (link) return link;
        const p = (async () => {
            const port = chrome.runtime.connect({ name: "wt-user-script" });
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
                exposer.reset();
                exposer.done();
                ep.close("refused");
            }
            throw e;
        }
        eager = top && init.overlay;
        page = init.page;
        hub?.prime({ [s]: init.stores });
        primed = init.stores;
        if (init.codeHash !== codeHash) run(init, codeHash !== null);
    }

    let primed: IsoInit["stores"] = {};
    function stores(): ReplicaHub {
        if (hub) return hub;
        const h = (hub = new ReplicaHub({ ctx: "isolated", log: (_s, msg, level) => log(level, msg) }));
        h.prime({ [s]: primed });
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
    function noteRan(api: "onPage" | "onDocument", name: string): void {
        if (ran.has(api)) return;
        ran.add(api);
        linkUp().then(
            (ep) => ep.push("ran", { api, name }, s),
            () => {}
        );
    }

    function run(init: IsoInit, hot: boolean): void {
        if (codeHash !== null) {
            exposer.reset();
            client.disconnect("the script reloaded");
        }
        codeHash = init.codeHash;
        const shimFor = (name: string, params: Record<string, any>, mine: boolean) =>
            makePageShim({
                params,
                world: "isolated",
                stores: { store: (n, initial, persist) => stores().store(s, n, initial, persist), pageStore: (n, initial) => stores().pageStore(s, n, initial, page) },
                exposer: mine ? exposer : undefined,
                overlay: mine && top ? (h) => client.remote(h) : undefined,
                log: (...args: any[]) => log("info", scriptLogLine(name, "wt.log", formatLogArgs(args))),
                storage: {
                    get: (key: string) => linkUp().then((ep) => ep.call("storage.get", { key }, s)).then((r) => r.value, () => undefined),
                    set: (key: string, value: any) => linkUp().then((ep) => ep.call("storage.set", { key, value }, s)).then(() => null, () => null),
                },
            });
        const consoleProxy = makeScriptConsole((level, source, text) => log(level, scriptLogLine(init.name, source, text)));
        let dom: PageDocumentHandler[];
        try {
            const requireFrom = makeLibRequire(init.libs, (lib, require, moduleObj) =>
                scriptFunction(lib.src!)(shimFor(lib.name, lib.params || {}, false).wt, consoleProxy, require, moduleObj, moduleObj.exports)
            );
            const moduleObj = { exports: {} as any };
            const shim = shimFor(init.name, init.params || {}, true);
            scriptFunction(init.src)(shim.wt, consoleProxy, requireFrom(init.name), moduleObj, moduleObj.exports);
            dom = shim.dom;
        } catch (e: any) {
            exposer.reset();
            exposer.done();
            log("error", formatScriptError(init.name, e, "onPage (isolated world) compile"));
            return;
        }
        const matching = domHandlersFor(dom, location.href, exposer);
        exposer.done();
        for (const d of matching)
            scheduleDocument(
                d.when,
                () => {
                    try {
                        firePageHandler(d, { url: location.href, method: "GET", tabUrl: location.href, resourceType: "main_frame", requestHeaders: {}, groups: {}, evaluate }, exposer);
                        noteRan(d.route.api === "onPage" ? "onPage" : "onDocument", init.name);
                    } catch (e: any) {
                        log("error", formatScriptError(init.name, e, d.route.api || "onDocument"));
                    }
                },
                hot
            );
    }

    linkUp().catch(() => {});
})();
