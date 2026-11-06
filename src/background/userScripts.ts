/**
 * Chrome MV3: `js: "isolated"` onPage code runs in a `chrome.userScripts`
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
 */
import type { RouteMeta } from "../shared/route";
import type { UserScriptsStatus } from "../shared/userScriptsStatus";
import { dlogLevel } from "../shared/debugLog";

export const USER_SCRIPT_PORT = "wt-user-script";
const ID_PREFIX = "wt-iso-";
/** the runtime compiles the script with `new Function`; the page's CSP doesn't apply */
export const ISO_WORLD_CSP = "script-src 'self' 'unsafe-eval'; object-src 'self'";
const STATUS_TTL_MS = 2000;

/** a script with isolated onPage handlers */
export interface IsoScript {
    id: string;
    /** its `js: "isolated"` onPage routes (the runtime only connects where one matches) */
    routes: RouteMeta[];
}

let status: { value: UserScriptsStatus; at: number } | null = null;
let checking: Promise<UserScriptsStatus> | null = null;
const listeners: ((s: UserScriptsStatus) => void)[] = [];
let wanted: IsoScript[] = [];
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
 * Register exactly `scripts` (and configure their worlds); does nothing
 * while user scripts are off — `syncUserScripts()` again (no argument)
 * once they're on. Calls run one at a time.
 */
export function syncUserScripts(scripts?: IsoScript[]): Promise<void> {
    if (!__MV3__) return Promise.resolve();
    if (scripts) wanted = scripts;
    const want = wanted;
    syncing = syncing.then(() => doSync(want)).catch((e: any) => dlogLevel("userScripts", "warn", `syncing user scripts failed: ${e?.message || e}`));
    return syncing;
}

async function doSync(want: IsoScript[]): Promise<void> {
    if ((await userScriptsStatus(true)) !== "ok") return;
    const us = api();
    if (!us) return;
    const perWorld = typeof us.getWorldConfigurations === "function";
    const source = await runtimeSource();
    const have = new Map<string, any>(((await us.getScripts()) as any[]).filter((r) => r.id.startsWith(ID_PREFIX)).map((r) => [r.id, r]));
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
}

/** tests: forget the cached status and registrations */
export function resetUserScripts(): void {
    status = null;
    checking = null;
    listeners.length = 0;
    wanted = [];
    syncing = Promise.resolve();
    runtime = null;
}
