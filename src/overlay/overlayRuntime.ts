/**
 * The overlay frame (overlay.html): one script's GUI over one tab's top
 * page. The bridge frames it (inside a closed shadow root) and hands it a
 * MessagePort (L3); everything the frame needs comes over that port —
 * the script's code comes from the background through the bridge's
 * extension port, never through the page.
 *
 * Here the script's module graph evaluates with network and onPage
 * registrations inert; its onOverlay handlers run at their `when`. Stores
 * are replicas (shared/storeReplica.ts), `fetch` and `wt.fetch` fetch as
 * the page (the bridge does it, with the page's cookies), calls into
 * onPage code and back go through shared/rpc.ts, and the frame reports
 * its visible areas so the bridge lets clicks through everywhere else.
 */
import { compileScript, type ResApiOverrides } from "../shared/compile";
import { messagePortEndpoint, type Endpoint, type OverlayInit } from "../shared/wire";
import { ReplicaHub } from "../shared/storeReplica";
import { builtinModule, ensureBuiltins } from "../shared/builtins";
import { makeLibRequire } from "../shared/scriptImports";
import type { PackageModules } from "../shared/packageImports";
import { Exposer, RpcClient, isRpcCall } from "../shared/rpc";
import { inertRemote, REMOTE_OVERLAY_SELF } from "../shared/remote";
import { isPageLayer, routeMatches, type DocumentWhen } from "../shared/route";
import { fromWireResponse, toWireRequest } from "../shared/wtFetch";
import { formatScriptError } from "../shared/scriptError";
import { formatLogArgs, scriptLogLine, type ScriptLogLevel } from "../shared/scriptLog";
import { collectRects, normalizeRects, watchRects } from "../shared/overlayRects";
import { ShortcutRegistry, watchShortcuts, type ShortcutPriority } from "../shared/shortcut";

const PHASES: DocumentWhen[] = ["document_start", "document_end", "document_idle"];
const rank = (p: DocumentWhen | undefined) => PHASES.indexOf(p ?? "document_end");

const LIB_REMOTE = "wt.onPage handles from an imported library don't connect; register them in the script itself";

export interface OverlayRuntime {
    client: RpcClient;
    exposer: Exposer;
    /** the handlers that ran so far (their route indexes) */
    ran: Set<number>;
    /** measure the visible areas now and report them when they changed */
    measure(): void;
    stop(): void;
}

export interface OverlayEnv {
    win: Window & typeof globalThis;
    doc: Document;
    /** replace the frame's global `fetch` (default true) */
    patchFetch?: boolean;
    /** watch the DOM and report rects (default true) */
    watchRects?: boolean;
    /** which key events count as the user's (default: `isTrusted`) */
    trustedKey?: (e: KeyboardEvent) => boolean;
}

/** run `init`'s script in this frame, talking to the bridge over `ep` */
export async function startOverlay(ep: Endpoint, init: OverlayInit, env: OverlayEnv = { win: window as any, doc: document }): Promise<OverlayRuntime> {
    const { win, doc } = env;
    const s = init.s;
    const log = (level: ScriptLogLevel, msg: string) => ep.push("log", { level, msg });
    const errorLine = (e: any, context: string) => formatScriptError(init.name, e, context);

    const hub = new ReplicaHub({ ctx: "overlay", log: (_s, msg, level) => log(level, msg) });
    hub.prime({ [s]: init.stores });
    hub.attach(ep);
    ep.on("store.resync", () => hub.reconnect());

    const client = new RpcClient((call) => {
        if (ep.closed) throw new Error("the overlay was closed");
        ep.push("rpc.call", call);
    });
    const exposer = new Exposer();
    ep.on("rpc.result", (r) => void client.receive(r));
    ep.on("rpc.call", (c) => {
        if (isRpcCall(c)) exposer.answer(c, (r) => ep.push("rpc.result", r));
    });
    ep.onClose((why) => client.disconnect(`the overlay was closed (${why})`));

    // the bridge's `when` and `nav` can come while React loads: keep the latest
    const ran = new Set<number>();
    const navFns = new Set<(url: string) => void>();
    let phase = init.phase ?? "document_start";
    let runDue = () => {};
    const page = { url: init.url, fetch: (request: any, bypass: boolean) => ep.call("pagefetch", { request, bypass }) };
    ep.on("when", (a) => {
        if (rank(a.phase) > rank(phase)) phase = a.phase;
        runDue();
    });
    ep.on("nav", ({ url }) => {
        page.url = url;
        for (const fn of [...navFns])
            try {
                fn(url);
            } catch (e) {
                log("error", errorLine(e, "ctx.onNavigate"));
            }
    });

    // ctx.shortcut: the bridge matches keys pressed in the page and says which
    // fired; keys pressed in this frame are matched here
    const keys = new ShortcutRegistry();
    const keyFns = new Map<string, () => void>();
    let keyIds = 0;
    const fireKey = (id: string) => {
        const fn = keyFns.get(id);
        if (!fn) return;
        try {
            const out: any = fn();
            if (out && typeof out.then === "function") out.then(undefined, (e: any) => log("error", errorLine(e, "ctx.shortcut")));
        } catch (e) {
            log("error", errorLine(e, "ctx.shortcut"));
        }
    };
    ep.on("shortcut.fire", ({ id }) => fireKey(id));
    const stopKeys = watchShortcuts(win, (e) => keys.find(e), (hits) => hits.forEach((h) => fireKey(h.id)), { trusted: env.trustedKey });
    const shortcut = (combo: string, fn: () => void, opts?: { priority?: ShortcutPriority }) => {
        if (typeof fn !== "function") throw new TypeError("ctx.shortcut: the second argument must be a function");
        const priority = opts?.priority ?? "before-page";
        if (priority !== "before-page" && priority !== "after-page") throw new TypeError(`ctx.shortcut: priority must be "before-page" or "after-page"`);
        const id = String(++keyIds);
        keys.add(s, id, combo, priority);
        keyFns.set(id, fn);
        ep.push("shortcut.add", { id, keys: combo, priority });
        return () => {
            if (!keyFns.delete(id)) return;
            keys.remove(s, id);
            if (!ep.closed) ep.push("shortcut.remove", { id });
        };
    };

    const pkgs: PackageModules = { aliases: {}, modules: {} };
    for (const l of init.libs) {
        if (l.pkg) pkgs.modules[l.name] = l.pkg;
        else if (l.alias !== undefined) pkgs.aliases[l.name] = l.alias;
    }
    if (init.react)
        await ensureBuiltins([init.code, ...init.libs.map((l) => l.src ?? "")], pkgs).catch((e: any) => log("error", scriptLogLine(init.name, "overlay", `the built-in React failed to load: ${e?.message || e}`)));

    const common: ResApiOverrides = {
        storage: {
            get: async (key) => (await ep.call("storage.get", { key })).value,
            set: async (key, value) => void (await ep.call("storage.set", { key, value })),
        },
        logSink: (level, source, text) => log(level, scriptLogLine(init.name, `overlay ${source}`, text)),
        store: (name, initial, persist) => hub.store(s, name, initial, persist),
        // the overlay's own page's copy
        pageStore: (name, initial) => hub.pageStore(s, name, initial, init.page),
        fetch: (request, bypass) => ep.call("fetch", { request, bypass }),
        pageFetch: page,
    };
    if (env.patchFetch !== false) {
        // the GUI's own fetch is the page's: same origin, cookies and interception
        win.fetch = async (input: RequestInfo | URL, rinit?: RequestInit) => fromWireResponse(await page.fetch(await toWireRequest(input, rinit ?? {}, page.url), false));
    }

    const codeOf = (importer: string) => (importer === init.name ? init.code : (init.libs.find((l) => l.name === importer)?.src ?? ""));
    const requireFrom = makeLibRequire(
        init.libs,
        (lib, require, moduleObj) => {
            const c = compileScript(lib.src!, { ...common, paramValues: lib.params, importModule: require, remote: () => inertRemote(LIB_REMOTE) });
            if (c.error) throw new Error(`${lib.name}: ${c.error}`);
            moduleObj.exports = c.exports;
        },
        {
            builtin: (spec, importer, loadUrl) => builtinModule(spec, codeOf(importer), loadUrl),
            style: (css) => {
                const el = doc.createElement("style");
                el.textContent = css;
                (doc.head || doc.documentElement).appendChild(el);
            },
        }
    );

    const compiled = compileScript(init.code, {
        ...common,
        paramValues: init.params,
        importModule: requireFrom(init.name),
        remote: (kind, index) => {
            if (kind === "onDocument") return client.remote(`page:${index}`);
            exposer.register(`overlay:${index}`);
            return inertRemote(REMOTE_OVERLAY_SELF);
        },
    });

    let handlers = compiled.handlers.onOverlay;
    if (compiled.error) {
        log("error", `[${init.name}] overlay compile: ${compiled.error}`);
        exposer.reset();
        handlers = [];
    }
    handlers = handlers.filter(({ route }) => {
        // js: "page" overlays run in the page (the hook's layer): here only when the bridge lists them (the Editor's Preview)
        const on = routeMatches(route, init.url) && (!isPageLayer(route) || init.routes.some((r) => r.index === route.index));
        if (!on) exposer.fail(`overlay:${route.index}`);
        return on;
    });
    exposer.done();

    const ctx = () => ({
        url: page.url,
        method: "GET",
        tabUrl: page.url,
        resourceType: "main_frame",
        requestHeaders: {},
        groups: {},
        onNavigate(fn: (url: string) => void) {
            if (typeof fn !== "function") throw new TypeError("ctx.onNavigate: the argument must be a function");
            navFns.add(fn);
            return () => void navFns.delete(fn);
        },
        shortcut,
    });
    runDue = () => {
        for (const { fn, route } of handlers) {
            if (ran.has(route.index) || rank(route.when) > rank(phase)) continue;
            ran.add(route.index);
            const h = `overlay:${route.index}`;
            let out: any;
            try {
                out = fn(ctx() as any);
            } catch (e) {
                exposer.fail(h);
                log("error", errorLine(e, "onOverlay"));
                continue;
            }
            exposer.expose(h, out);
            if (out && typeof out.then === "function") out.then(undefined, (e: any) => log("error", errorLine(e, "onOverlay")));
        }
    };
    const onError = (ev: ErrorEvent) => log("error", ev.error ? errorLine(ev.error, "overlay") : scriptLogLine(init.name, "overlay", ev.message));
    const onRejection = (ev: PromiseRejectionEvent) => log("error", ev.reason instanceof Error ? errorLine(ev.reason, "overlay (unhandled rejection)") : scriptLogLine(init.name, "overlay (unhandled rejection)", formatLogArgs([ev.reason])));
    const onPointer = () => ep.push("focus", {});
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    win.addEventListener("pointerdown", onPointer, true);

    let lastRects = "";
    const measure = () => {
        const rects = normalizeRects(collectRects(doc, win) ?? [[0, 0, win.innerWidth, win.innerHeight]], win.innerWidth, win.innerHeight);
        const key = JSON.stringify(rects);
        if (key === lastRects) return;
        lastRects = key;
        ep.push("rects", { rects });
    };
    const stopRects = env.watchRects === false ? () => {} : watchRects(doc, win, measure);

    runDue();
    measure();
    const stop = () => {
        stopRects();
        stopKeys();
        win.removeEventListener("error", onError);
        win.removeEventListener("unhandledrejection", onRejection);
        win.removeEventListener("pointerdown", onPointer, true);
        ep.close("stopped");
    };
    ep.onClose(stopRects);
    ep.onClose(stopKeys);
    return { client, exposer, ran, measure, stop };
}

// ---- boot (only in overlay.html) ----

/**
 * The bridge posts `{ wtOverlay: true }` with the port; this frame proves
 * itself by saying hello with the nonce from its URL hash, which the page
 * can't read (a frame the page navigated elsewhere can't). Where this frame has
 * extension APIs (Firefox: no manifest sandbox), the background confirms
 * the nonce belongs to this tab, so a page framing overlay.html itself
 * gets nothing.
 */
function boot(): void {
    const nonce = location.hash.slice(1);
    if (!nonce) return;
    const onMessage = async (ev: MessageEvent) => {
        if (ev.source !== window.parent || ev.data?.wtOverlay !== true || !ev.ports?.[0]) return;
        window.removeEventListener("message", onMessage);
        const rt = (globalThis as any).chrome?.runtime;
        if (rt?.id && typeof rt.sendMessage === "function") {
            const ok = await rt.sendMessage({ type: "wtOverlayNonce", nonce }).catch(() => false);
            if (ok !== true) return;
        }
        const ep = messagePortEndpoint(ev.ports[0]);
        try {
            await startOverlay(ep, await ep.call("hello", { nonce }));
        } catch (e: any) {
            ep.push("log", { level: "error", msg: `overlay failed to start: ${e?.message || e}` });
        }
    };
    window.addEventListener("message", onMessage);
}

if (typeof document !== "undefined" && document.documentElement?.dataset.wtOverlay === "1") boot();
