/**
 * SW-side access to script compilation/execution.
 *
 * MV2: compileScript runs right here in the persistent background page
 * (eval allowed) — identical to the pre-MV3 behavior.
 *
 * MV3: the service worker's CSP forbids eval, so compilation and handler
 * execution are RPCs into the sandbox page (bridged by the offscreen
 * document) — the ONLY eval-permitted context in MV3:
 *
 *   compileForStorage                  → sandbox 'compileOne'
 *   analyzeScripts                     → sandbox 'analyze'
 *   runBodyOp                          → sandbox 'run'
 *   probeRules                         → sandbox 'rules'
 *
 * scriptStore and the pipeline never call compileScript directly; they go
 * through this module.
 */
import { compileScript, compileWithLibs, makeModuleResolver } from "../shared/compile";
import { defaultMeta, type ResMeta } from "../shared/metaParser";
import type { ParamDef } from "../shared/scriptDef";
import { dlogLevel } from "../shared/debugLog";
import { compileDecision } from "../shared/pac";
import { getDefaultStrategy } from "../shared/route";
import { packBytes, unpackBytes } from "../shared/bytesPack";
import type { ScriptRules } from "../shared/rulesProbe";
import { dataFilesSig, ensureDataFiles } from "./engine/dataFiles";
import { ensurePackages, loadPackages, packagesSig, packagesSnapshot } from "./engine/packageImports";

interface PlainScript {
    id: string;
    name: string;
    code: string;
    updatedAt: number;
    enabled: boolean;
}

export interface Analyzed {
    meta: ResMeta;
    paramDefs: Record<string, ParamDef>;
    error: string | null;
    deps: string[];
}

type ParamValues = { [scriptId: string]: Record<string, any> };

/** stable signature of every stored param value (routes may be built from any of them) */
function paramSig(v: ParamValues | undefined): string {
    const s = JSON.stringify(Object.keys(v || {}).sort().map((k) => [k, v![k]]));
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
    return h.toString(36);
}

// ---- low-level RPC (MV3) ----

let seq = 0;

function sandboxCall(payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const reqId = "sw_" + ++seq;
        const timer = setTimeout(() => reject(new Error("sandbox RPC timeout")), 20000);
        chrome.runtime.sendMessage({ type: "__resSandbox", reqId, extId: chrome.runtime.id, payload }, (resp: any) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (resp?.error) return reject(new Error(resp.error));
            resolve(resp);
        });
    });
}

/**
 * RPC that compiles against the data files and package modules: the
 * sandbox keeps the last set it got and answers `needDataFiles` when its
 * signature differs — then (only) the files ride along.
 */
async function sandboxCallWithData(payload: any): Promise<any | null> {
    const dataFiles = await ensureDataFiles();
    await loadPackages();
    const dataSig = dataFilesSig() + "." + packagesSig();
    const out = await sandboxCallSafe({ ...payload, dataSig });
    return out?.needDataFiles ? sandboxCallSafe({ ...payload, dataSig, dataFiles, packages: packagesSnapshot() }) : out;
}

/**
 * RPC with a null fallback — callers treat null as graceful passthrough.
 * On failure the offscreen document is torn down and the call retried once
 * with a fresh one (heals a dead/zombie document, e.g. after an extension
 * reload or a Chrome shutdown race).
 */
async function sandboxCallSafe(payload: any): Promise<any | null> {
    try {
        return await sandboxCall(payload);
    } catch (e: any) {
        dlogLevel("compile", "warn", `sandbox RPC failed (${payload?.op}) — recreating offscreen host: ${e?.message || e}`);
        await closeOffscreen();
        try {
            await ensureOffscreen(true);
            const out = await sandboxCall(payload);
            dlogLevel("compile", "info", `sandbox RPC recovered after host recreation (${payload?.op})`);
            return out;
        } catch (e2: any) {
            dlogLevel("compile", "warn", `sandbox RPC retry failed (${payload?.op}): ${e2?.message || e2}`);
            return null;
        }
    }
}

async function closeOffscreen(): Promise<void> {
    await new Promise<void>((resolve) => {
        (chrome as any).offscreen.closeDocument(() => {
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

let readyPromise: Promise<void> | null = null;

/** Ensure the offscreen document (the sandbox host) exists AND its listener answers. */
async function ensureOffscreen(force = false): Promise<void> {
    const runtime = chrome.runtime as any;
    if (!force && readyPromise) return readyPromise;
    readyPromise = (async () => {
        if (!force && runtime.getContexts) {
            const ctx = await runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
            if (ctx && ctx.length) return;
        }
        await new Promise<void>((resolve) => {
            (chrome as any).offscreen.createDocument(
                {
                    url: "offscreen.html",
                    reasons: ["IFRAME_SCRIPTING"],
                    justification: "Compile and run user scripts in the MV3 sandbox (eval is forbidden in service workers)",
                },
                () => {
                    void chrome.runtime.lastError;
                    resolve();
                }
            );
        });
        // readiness ping: the offscreen listener must actually answer (the
        // document loads html + script + a sandbox iframe — a blind fixed
        // sleep raced it and corrupted first saves)
        for (let i = 0; i < 25; i++) {
            try {
                await sandboxCall({ op: "ping" });
                return;
            } catch {
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw new Error("sandbox host not ready");
    })().finally(() => {
        readyPromise = null;
    });
    return readyPromise;
}

if (__MV3__) {
    // reverse calls from the sandbox: storage + logging
    chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
        if (!msg || msg.type !== "__resReverse") return false;
        const payload = msg.payload || {};
        if (payload.op === "log") {
            import("./engine/logs").then(({ log }) => log(typeof payload.tabId === "number" ? payload.tabId : -1, payload.msg, payload.level || "info", payload.scriptId, payload.netKind === "observed" || payload.netKind === "modified" || payload.netKind === "missed" ? payload.netKind : undefined, undefined, typeof payload.requestId === "string" ? payload.requestId : undefined));
            sendResponse({});
            return false;
        }
        if (payload.op === "storageGet" || payload.op === "storageSet") {
            void (async () => {
                const { scriptStorageGet, scriptStorageSet } = await import("./engine/scriptStore");
                if (payload.op === "storageGet") {
                    const value = await scriptStorageGet(payload.scriptId, payload.key);
                    sendResponse({ value });
                } else {
                    await scriptStorageSet(payload.scriptId, payload.key, payload.value);
                    sendResponse({});
                }
            })();
            return true;
        }
        return false;
    });
}

// ---- public API ----

/** compileForStorage error when the sandbox host itself failed (not user code). */
export const SANDBOX_COMPILE_FAILED = "sandbox compile failed";

/** the stored scripts a save-time compile resolves imports against */
export interface StorageCompileContext {
    /** the saved script's id (it replaces its stored copy in `scripts`) */
    id: string;
    scripts: { id: string; name: string; code: string }[];
    /** every script's stored param values (libraries compile with theirs) */
    paramValues?: ParamValues;
}

/**
 * Compile a saved script for storage: meta + paramDefs (saveScript path).
 * Imports resolve against the stored scripts in `ctx` (so e.g. a param
 * definition imported from a utility is captured with its real type);
 * imports with no matching (or a broken) library resolve to inert stubs —
 * routes built from those come out empty until the reload-time analyze.
 * Package URLs it imports are downloaded first.
 */
export async function compileForStorage(
    code: string,
    name?: string,
    paramValues?: Record<string, any>,
    ctx?: StorageCompileContext
): Promise<{ meta: ResMeta; paramDefs: Record<string, ParamDef>; error: string | null }> {
    const label = name || "x";
    const id = ctx?.id ?? "x";
    const target = { id, name: label, code };
    const scripts = (ctx?.scripts ?? []).filter((s) => s.id !== id);
    const values: ParamValues = { ...(ctx?.paramValues ?? {}), [id]: paramValues ?? {} };
    // a save retries the script's own failed package downloads
    await ensurePackages([code], { retry: true });
    await ensurePackages(scripts.map((s) => s.code));
    if (!__MV3__) {
        const c = compileWithLibs(target, scripts, values, await ensureDataFiles(), packagesSnapshot());
        dlogLevel(
            "compile", "debug",
            `compiled "${label}" → active=${c.meta.active} match=${JSON.stringify(c.meta.match)} params=[${Object.keys(c.paramDefs || {}).join(", ")}] deps=[${c.deps.join(", ")}]${c.error ? " — compile error (in the Problems view)" : ""}`
        );
        return { meta: c.meta, paramDefs: c.paramDefs || {}, error: c.error };
    }
    await ensureOffscreen();
    const resp = await sandboxCallWithData({ op: "compileOne", target, scripts, paramValues: values });
    const r = resp?.result;
    if (!r) {
        dlogLevel("compile", "warn", `compileForStorage "${label}": sandbox compile returned nothing — script meta NOT updated`);
        return { meta: defaultMeta(), paramDefs: {}, error: SANDBOX_COMPILE_FAILED };
    }
    dlogLevel(
        "compile", "debug",
        `compiled "${label}" → active=${r.meta.active} match=${JSON.stringify(r.meta.match)} params=[${Object.keys(r.paramDefs || {}).join(", ")}] deps=[${(r.deps || []).join(", ")}]${r.error ? " — compile error (in the Problems view)" : ""}`
    );
    return { meta: r.meta, paramDefs: r.paramDefs, error: r.error };
}

/**
 * Analyze ALL scripts (meta.routes/paramDefs/deps) with the stored param
 * values — routes may be built from params. Reload + getHookBundle path.
 */
export async function analyzeScripts(scripts: { id: string; name: string; code: string; updatedAt: number }[], paramValues?: ParamValues): Promise<Map<string, Analyzed>> {
    const out = new Map<string, Analyzed>();
    if (!scripts.length) return out;
    // imports resolve by name (relative paths) and into the data files
    await ensureDataFiles();
    await ensurePackages(scripts.map((s) => s.code));
    const sig = paramSig(paramValues) + "." + dataFilesSig() + "." + packagesSig();
    if (__MV3__) {
        // FAST PATH: chrome.storage.session-cached analyses, valid while no
        // script's updatedAt changed. A freshly-woken SW serves a page's
        // getHookBundle from here (one storage read) instead of booting the
        // offscreen doc + sandbox — the difference between onDocument running at
        // document_start and after the page already initialized.
        const cached = await readAnalyzeCache();
        if (cached && scripts.every((s) => cached[s.id]?.updatedAt === s.updatedAt && cached[s.id]?.paramSig === sig && cached[s.id]?.name === s.name)) {
            for (const s of scripts) out.set(s.id, cached[s.id].analyzed);
            dlogLevel("compile", "debug", `analyze cache hit — ${scripts.length} script(s) served from session storage (no sandbox round-trip)`);
            return out;
        }
    }
    if (!__MV3__) {
        // MV2: in-page compile, same as before
        const resolver = makeModuleResolver(
            scripts.map((s) => ({ id: s.id, name: s.name, code: s.code })),
            (lib) => ({ paramValues: paramValues?.[lib.id] }),
            { dataFiles: await ensureDataFiles(), packages: packagesSnapshot() }
        );
        for (const s of scripts) {
            const c = compileScript(s.code, { importModule: resolver.resolveFrom(s.name), paramValues: paramValues?.[s.id] });
            out.set(s.id, {
                meta: c.meta,
                paramDefs: c.paramDefs || {},
                error: c.error,
                deps: [...resolver.deps],
            });
        }
        return out;
    }
    await ensureOffscreen();
    const resp = await sandboxCallWithData({ op: "analyze", scripts: scripts.map((s) => ({ ...s, enabled: true })), paramValues: paramValues || {} });
    if (!resp) {
        dlogLevel("compile", "error", `sandbox analyze FAILED for ${scripts.length} script(s) — the page bundle serves WITHOUT them (no interception/onDocument until the next successful analyze)`);
        return out;
    }
    for (const s of scripts) {
        const r = resp?.results?.[s.id];
        if (r) out.set(s.id, r);
        else dlogLevel("compile", "warn", `sandbox analyze returned no result for "${s.name}" — it will not intercept in this bundle`);
    }
    await persistAnalyzeCache(
        scripts.filter((s) => out.has(s.id)).map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt, paramSig: sig, analyzed: out.get(s.id)! }))
    );
    return out;
}

// ---- analyze cache (MV3): session storage, refreshed on script changes ----

const ANALYZE_CACHE_KEY = "resAnalyzeCache";

type AnalyzeCache = Record<string, { updatedAt: number; name?: string; paramSig?: string; analyzed: Analyzed }>;

async function readAnalyzeCache(): Promise<AnalyzeCache | null> {
    try {
        const got = await chrome.storage.session.get(ANALYZE_CACHE_KEY);
        return got?.[ANALYZE_CACHE_KEY] ?? null;
    } catch {
        return null;
    }
}

async function persistAnalyzeCache(entries: { id: string; name: string; updatedAt: number; paramSig: string; analyzed: Analyzed }[]): Promise<void> {
    try {
        // keyed by script id; each write overwrites that id's older entry
        const cached = (await readAnalyzeCache()) ?? {};
        for (const e of entries) cached[e.id] = { updatedAt: e.updatedAt, name: e.name, paramSig: e.paramSig, analyzed: e.analyzed };
        // bound growth: drop ids not seen in a while (keep ≤ 200)
        const ids = Object.keys(cached);
        if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete cached[id];
        await chrome.storage.session.set({ [ANALYZE_CACHE_KEY]: cached });
    } catch (e: any) {
        dlogLevel("compile", "warn", `analyze cache write failed: ${e?.message || e}`);
    }
}

/**
 * Run a body op (requestDecision / transform / replace / responseHeaders)
 * in the sandbox — MV3 only (MV2 executes handlers in-place). Returns null
 * on any failure (callers treat it as passthrough).
 */
export async function runBodyOp(
    scripts: PlainScript[],
    paramValues: Record<string, any>,
    op: "requestDecision" | "transform" | "replace" | "responseHeaders",
    args: Record<string, any>
): Promise<any | null> {
    await ensureOffscreen();
    // the sandbox has no settings: the default strategy rides along; bytes
    // are packed for JSON messaging (offscreen.ts unpacks them)
    const out = unpackBytes(await sandboxCallWithData({ op: "run", runOp: op, scripts, paramValues, args: packBytes({ defaultStrategy: getDefaultStrategy(), ...args }) }));
    dlogLevel("compile", "debug", `runBodyOp ${op} → ${JSON.stringify(out)?.slice(0, 120)}`);
    return out;
}

/**
 * MV3: run every enabled script's `rules` handlers once in the sandbox and
 * translate them (src/shared/rulesProbe.ts). null on failure.
 */
export async function probeRules(scripts: PlainScript[], paramValues: Record<string, any>): Promise<Record<string, ScriptRules> | null> {
    await ensureOffscreen();
    const out = await sandboxCallWithData({ op: "rules", scripts, paramValues, defaultStrategy: getDefaultStrategy() });
    return out?.results ?? null;
}

let pacCache: { source: string; fn: (url: string, host: string) => string } | null = null;

/**
 * Evaluate the user's proxy decision (`__resUser` source from shared/pac)
 * for one URL — MV2 in-page, MV3 in the sandbox (needs eval). "DIRECT" on
 * failure.
 */
export async function evalProxyDecision(source: string, url: string, host: string): Promise<string> {
    if (!__MV3__) {
        if (pacCache?.source !== source) pacCache = { source, fn: compileDecision(source) };
        return pacCache.fn(url, host);
    }
    await ensureOffscreen();
    const out = await sandboxCallSafe({ op: "pac", source, args: { url, host } });
    return typeof out?.result === "string" ? out.result : "DIRECT";
}
