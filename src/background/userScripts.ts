/**
 * Chrome MV3: onPage code runs in a `chrome.userScripts`
 * USER_SCRIPT world — the only place an MV3 extension may run code from a
 * string. Each script with isolated onPage handlers is registered once
 * (`wt-iso-<scriptId>`, every frame, `document_start`): a one-line prelude
 * naming the script and its isolated routes, then the packaged runtime
 * (`isolated.js`, src/hook/isolated.ts) — inlined as code, not listed as a
 * `file`: Chrome injects an extension file once per document however many
 * registrations name it, so only one script's runtime would start. In a frame its routes match, the
 * runtime opens the L6 port (`wt-user-script`) and asks the owner for the
 * code (`iso.load`, overlayLinks.ts), so the source never sits in the
 * registration and a save reaches open pages as `iso.update`.
 *
 * Registered rather than `execute`d on the bridge's request: it works from
 * Chrome 120 (`execute` needs 135), injects at `document_start` without a
 * round trip through the service worker, and survives its restarts.
 *
 * The API needs the optional `userScripts` permission and the user's
 * "Allow User Scripts" switch (Developer mode before Chrome 138); without
 * them `chrome.userScripts` is missing or throws. Per-script worlds
 * (`worldId`) need Chrome 133 — before that every script shares the
 * default USER_SCRIPT world (each still in its own function scope), and
 * `configureWorld({ worldId })` would silently reconfigure the default
 * world, so the id is only passed where `getWorldConfigurations` exists.
 *
 * onSite code runs in the page's own world, so it comes the same way:
 * each script with onSite handlers is registered in the MAIN world
 * (`wt-main-<scriptId>`, every frame, `document_start`) as its units — the
 * script, the library scripts and package modules it imports, each a
 * function the hook picks up (shared/siteCode.ts). Here the code itself
 * is the registration (the MAIN world has no messaging to ask for it), so
 * a save updates it and, from Chrome 135, `execute`s the new units into
 * open tabs, where the hook runs them as a hot update.
 */
import type { RouteMeta } from "../shared/route";
import type { UserScriptsStatus } from "../shared/userScriptsStatus";
import { dlogLevel } from "../shared/debugLog";

export const USER_SCRIPT_PORT = "wt-user-script";
const ID_PREFIX = "wt-iso-";
const SITE_PREFIX = "wt-main-";
/** the runtime compiles the script with `new Function`; the page's CSP doesn't apply */
export const ISO_WORLD_CSP = "script-src 'self' 'unsafe-eval'; object-src 'self'";
const STATUS_TTL_MS = 2000;

/** a script with isolated onPage handlers */
export interface IsoScript {
    id: string;
    /** its onPage routes (the runtime only connects where one matches) */
    routes: RouteMeta[];
}

/** a script with onSite handlers: its units (shared/siteCode.ts scriptUnit / packageUnit), its own first */
export interface SiteScript {
    id: string;
    units: string[];
}

let status: { value: UserScriptsStatus; at: number } | null = null;
let checking: Promise<UserScriptsStatus> | null = null;
const listeners: ((s: UserScriptsStatus) => void)[] = [];
let wanted: { iso: IsoScript[]; site: SiteScript[] } = { iso: [], site: [] };
/** a sync went through since the worker started (the first one doesn't push units into open tabs: an extension update leaves no hook there) */
let synced = false;
let syncing: Promise<void> = Promise.resolve();

const api = (): any => {
    try {
        return (globalThis as any).chrome?.userScripts;
    } catch {
        // Chrome before 138 throws on access while Developer mode is off
        return undefined;
    }
};

/** can isolated code run? Re-checked at most every 2 s; a change notifies `onUserScriptsStatus` listeners */
export function userScriptsStatus(fresh = false): Promise<UserScriptsStatus> {
    if (!__MV3__) return Promise.resolve("ok");
    if (!fresh && status && Date.now() - status.at < STATUS_TTL_MS) return Promise.resolve(status.value);
    if (checking) return checking;
    checking = (async (): Promise<UserScriptsStatus> => {
        let value: UserScriptsStatus;
        try {
            const granted = await chrome.permissions.contains({ permissions: ["userScripts"] as any });
            if (!granted) value = "no-permission";
            else {
                const us = api();
                value = us ? await us.getScripts().then(() => "ok" as const, () => "off" as const) : "off";
            }
        } catch {
            value = "off";
        }
        const changed = status?.value !== value;
        const first = !status;
        status = { value, at: Date.now() };
        if (changed && !first) for (const fn of listeners) fn(value);
        return value;
    })().finally(() => (checking = null));
    return checking;
}

/** the last known status (no check) */
export function lastUserScriptsStatus(): UserScriptsStatus | undefined {
    return __MV3__ ? status?.value : "ok";
}

/** run `fn` when the status changes (the user granted the permission, flipped the switch) */
export function onUserScriptsStatus(fn: (s: UserScriptsStatus) => void): void {
    listeners.push(fn);
}

const preludeFor = (s: IsoScript): string => `(globalThis.__wtIsoQ ||= []).push(${JSON.stringify({ s: s.id, routes: s.routes })});`;

let runtime: Promise<string> | null = null;
/** the packaged runtime's source (read once) */
function runtimeSource(): Promise<string> {
    runtime ??= fetch(chrome.runtime.getURL("isolated.js")).then((r) => {
        if (!r.ok) throw new Error(`isolated.js: HTTP ${r.status}`);
        return r.text();
    });
    runtime.catch(() => (runtime = null));
    return runtime;
}

/**
 * Register exactly `scripts` (and configure their worlds) and `site`
 * (none: the last `site`);
 * does nothing while user scripts are off — `syncUserScripts()` again (no
 * argument) once they're on. Calls run one at a time.
 */
export function syncUserScripts(scripts?: IsoScript[], site?: SiteScript[]): Promise<void> {
    if (!__MV3__) return Promise.resolve();
    if (scripts) wanted = { iso: scripts, site: site ?? wanted.site };
    const want = wanted;
    syncing = syncing.then(() => doSync(want)).catch((e: any) => dlogLevel("userScripts", "warn", `syncing user scripts failed: ${e?.message || e}`));
    return syncing;
}

async function doSync({ iso: want, site }: typeof wanted): Promise<void> {
    if ((await userScriptsStatus(true)) !== "ok") return;
    const us = api();
    if (!us) return;
    const perWorld = typeof us.getWorldConfigurations === "function";
    const source = await runtimeSource();
    const registered = (await us.getScripts()) as any[];
    const have = new Map<string, any>(registered.filter((r) => r.id.startsWith(ID_PREFIX)).map((r) => [r.id, r]));
    const add: any[] = [];
    const change: any[] = [];
    for (const s of want) {
        const reg: any = { id: ID_PREFIX + s.id, matches: ["<all_urls>"], allFrames: true, runAt: "document_start", world: "USER_SCRIPT", js: [{ code: `${preludeFor(s)}\n${source}` }] };
        if (perWorld) reg.worldId = s.id;
        const old = have.get(reg.id);
        have.delete(reg.id);
        if (!old) add.push(reg);
        else if (old.js?.[0]?.code !== reg.js[0].code || (perWorld && old.worldId !== s.id)) change.push(reg);
    }
    // worlds first: a registration may inject right away
    if (perWorld) for (const s of want) await us.configureWorld({ worldId: s.id, csp: ISO_WORLD_CSP, messaging: true });
    else if (want.length) await us.configureWorld({ csp: ISO_WORLD_CSP, messaging: true });
    if (have.size) await us.unregister({ ids: [...have.keys()] });
    if (perWorld && typeof us.resetWorldConfiguration === "function") for (const id of have.keys()) await us.resetWorldConfiguration(id.slice(ID_PREFIX.length)).catch(() => {});
    if (change.length) await us.update(change);
    if (add.length) await us.register(add);
    dlogLevel("userScripts", "debug", `user scripts: ${want.length} registered (${add.length} new, ${change.length} changed, ${have.size} removed)${perWorld ? "" : ", shared world"}`);
    await syncSite(us, site, registered.filter((r) => r.id.startsWith(SITE_PREFIX)));
    synced = true;
}

/** the MAIN-world registrations (onSite code); new units go into open tabs too (Chrome 135+) */
async function syncSite(us: any, want: SiteScript[], registered: any[]): Promise<void> {
    const have = new Map<string, any>(registered.map((r) => [r.id, r]));
    const old = new Set<string>(registered.flatMap((r) => (r.js || []).map((j: any) => j.code)));
    const add: any[] = [];
    const change: any[] = [];
    for (const s of want) {
        const reg = { id: SITE_PREFIX + s.id, matches: ["*://*/*"], allFrames: true, runAt: "document_start", world: "MAIN", js: s.units.map((code) => ({ code })) };
        const was = have.get(reg.id);
        have.delete(reg.id);
        if (!was) add.push(reg);
        else if ((was.js || []).map((j: any) => j.code).join("\0") !== s.units.join("\0")) change.push(reg);
    }
    if (have.size) await us.unregister({ ids: [...have.keys()] });
    if (change.length) await us.update(change);
    if (add.length) await us.register(add);
    const fresh = [...new Set(want.flatMap((s) => s.units))].filter((u) => !old.has(u));
    dlogLevel("userScripts", "debug", `user scripts (onSite): ${want.length} registered (${add.length} new, ${change.length} changed, ${have.size} removed)`);
    if (!synced || !fresh.length || typeof us.execute !== "function") return;
    // open pages: the hook takes the new units and runs the hot update the bundle brings
    const tabs = await chrome.tabs.query({ url: ["*://*/*"] }).catch(() => [] as chrome.tabs.Tab[]);
    await Promise.all(
        tabs.map((t) =>
            t.id === undefined || t.discarded
                ? undefined
                : us.execute({ target: { tabId: t.id, allFrames: true }, world: "MAIN", injectImmediately: true, js: fresh.map((code) => ({ code })) }).catch(() => {})
        )
    );
}

/** tests: forget the cached status and registrations */
export function resetUserScripts(): void {
    status = null;
    checking = null;
    listeners.length = 0;
    wanted = { iso: [], site: [] };
    synced = false;
    syncing = Promise.resolve();
    runtime = null;
}
