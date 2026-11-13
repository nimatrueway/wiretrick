/**
 * The background's `tt.globalStore` owner and the links to it:
 *
 *   MV2 — scripts compile right here: one in-process replica hub, joined
 *         to the owner by an endpoint pair, shared by every strategy's
 *         compiled instance (so a store is one object across them).
 *   MV3 — scripts compile in the sandbox: its hub talks to the owner over
 *         the L1 link (sandbox ⇄ offscreen ⇄ chrome.runtime ⇄ here). The
 *         link also serves the sandbox's `tt.fetch`.
 */
import { Endpoint, endpointPair, type Json, type StorePersist, type WireRequest, type WireResponse } from "../../shared/wire";
import { ReplicaHub } from "../../shared/storeReplica";
import { packBytes, unpackBytes } from "../../shared/bytesPack";
import { isTabScope, jsonBytes, tabScopeId } from "../../shared/storeOps";
import { scriptFileName, scriptPathKey } from "../../shared/scriptName";
import { StoreOwner } from "./storeOwner";
import { log } from "./logs";
import { scriptStorageAll, scriptStorageSet, scriptStorageDelete, getScript, listScripts, onScriptsChanged } from "./scriptStore";
import { backgroundFetch } from "./ttFetch";
import { pages, pagesReady } from "./pages";

const ownerLog = (s: string, msg: string, level: "info" | "warn" | "error") => log(-1, msg, level, s);

export const storeOwner = new StoreOwner({
    // lambdas: scriptStore is part of an import cycle
    storageAll: (s) => scriptStorageAll(s),
    storageSet: (s, k, v) => scriptStorageSet(s, k, v),
    storageDelete: (s, k) => scriptStorageDelete(s, k),
    ...(__MV3__
        ? {
              sessionGet: async (k: string) => (await chrome.storage.session.get(k))?.[k],
              sessionSet: (k: string, v: unknown) => chrome.storage.session.set({ [k]: v }),
          }
        : {}),
    log: ownerLog,
    pageAlive: (p) => pages.isAlive(p),
    ready: () => pagesReady,
});
// a page ended: its tt.pageStore copies go; a tab closed: its tt.tabStore copies go
pages.onEnd((key) => storeOwner.dropPage(key));
pages.onTabEnd((tabKey) => storeOwner.dropPage(tabKey));

export interface InspectedStoreEntry {
    /** unique row key: `${scriptId}\0${name}` or `${scriptId}\0${name}\0${page}` */
    id: string;
    scriptId: string;
    scriptName: string;
    name: string;
    scope: "global" | "tab" | "page";
    page?: string;
    tabId?: number;
    tabTitle?: string;
    tabUrl?: string;
    rev: number;
    persist?: StorePersist;
    hasTemplate: boolean;
    bytes: number;
    data: Json;
}

async function queryTabsSafe(): Promise<Map<number, { title?: string; url?: string }>> {
    const out = new Map<number, { title?: string; url?: string }>();
    try {
        const tabs: chrome.tabs.Tab[] = await new Promise((resolve) => {
            if (!chrome?.tabs?.query) return resolve([]);
            chrome.tabs.query({}, (t) => (void chrome.runtime?.lastError, resolve(t || [])));
        });
        for (const t of tabs) if (t.id !== undefined) out.set(t.id, { title: t.title, url: t.url });
    } catch {}
    return out;
}

/** list every script's globalStore and active pageStore entries for the Stores panel and Diagnostics */
export async function listAllStores(providedScripts?: readonly { id: string; meta: { name: string } }[]): Promise<InspectedStoreEntry[]> {
    const scripts = providedScripts ?? (await listScripts());
    const [inspected, tabMap] = await Promise.all([storeOwner.inspect(scripts.map((s) => s.id)), queryTabsSafe()]);
    const rows: InspectedStoreEntry[] = [];
    const rank = { global: 0, tab: 1, page: 2 } as const;
    for (const s of scripts) {
        const entries = inspected[s.id] ?? [];
        entries.sort((a, b) => rank[a.scope] - rank[b.scope] || a.name.localeCompare(b.name) || (a.page ?? "").localeCompare(b.page ?? ""));
        for (const e of entries) {
            const tabId = e.page ? (isTabScope(e.page) ? tabScopeId(e.page) : pages.tabOf(e.page)) : undefined;
            const tab = tabId !== undefined && tabId >= 0 ? tabMap.get(tabId) : undefined;
            const isPreview = e.page?.startsWith("v") || e.page?.startsWith("tab:v");
            rows.push({
                id: e.page ? `${s.id}\u0000${e.name}\u0000${e.page}` : `${s.id}\u0000${e.name}`,
                scriptId: s.id,
                scriptName: s.meta.name,
                name: e.name,
                scope: e.scope,
                ...(e.page ? { page: e.page } : {}),
                ...(tabId !== undefined && tabId >= 0 ? { tabId } : {}),
                ...(isPreview ? { tabTitle: "Overlay Preview" } : tab?.title ? { tabTitle: tab.title } : {}),
                ...(tab?.url ? { tabUrl: tab.url } : {}),
                rev: e.rev,
                persist: e.persist,
                hasTemplate: e.hasTemplate,
                bytes: jsonBytes(e.data),
                data: e.data,
            });
        }
    }
    return rows;
}

export async function exportPersistedStores(): Promise<Record<string, Record<string, Json>>> {
    const scripts = await listScripts();
    return storeOwner.exportPersisted(scripts.map((s) => ({ id: s.id, name: scriptFileName(s.meta.name) })));
}

export async function importPersistedStores(exported: Record<string, Record<string, Json>>): Promise<number> {
    const scripts = await listScripts();
    const byKey = new Map(scripts.map((s) => [scriptPathKey(s.meta.name), s.id]));
    let count = 0;
    for (const [scriptName, stores] of Object.entries(exported || {})) {
        const scriptId = byKey.get(scriptPathKey(scriptName));
        if (!scriptId || !stores || typeof stores !== "object") continue;
        for (const [storeName, data] of Object.entries(stores)) {
            await storeOwner.replace(scriptId, storeName, data);
            count++;
        }
    }
    return count;
}

/** a script's name for log lines (its id if it's gone) */
async function nameOf(scriptId: string): Promise<string> {
    return (await getScript(scriptId).catch(() => undefined))?.meta.name ?? scriptId;
}

/** `tt.fetch(..., { from: "background" })` for a script */
export async function fetchFor(scriptId: string, request: WireRequest, bypass: boolean): Promise<WireResponse> {
    return backgroundFetch(request, { bypass, scriptId, scriptName: await nameOf(scriptId) });
}

// ---- MV2: the in-process hub ----

let hub: ReplicaHub | null = null;

/** MV2: the replicas the background's compiled scripts use */
export function backgroundHub(): ReplicaHub {
    if (!hub) {
        hub = new ReplicaHub({ ctx: "bg", log: ownerLog });
        const [replicaSide, ownerSide] = endpointPair();
        storeOwner.attach(ownerSide, { all: true });
        hub.attach(replicaSide);
    }
    return hub;
}

/**
 * Before scripts compile (reload): drop the stores of deleted scripts and,
 * in MV2, load the others' current state into the hub so `tt.globalStore`
 * returns real data synchronously.
 */
export async function prepareStores(scriptIds: string[]): Promise<void> {
    storeOwner.retain(scriptIds);
    if (__MV3__) return; // the sandbox primes its own hub (store.init)
    const h = backgroundHub();
    h.retain(scriptIds);
    h.prime(await storeOwner.init(scriptIds.filter((s) => !h.isPrimed(s))));
}

// ---- MV3: the L1 link to the sandbox ----

/** a random id per service-worker start: the sandbox re-syncs its stores when it changes */
export const SW_EPOCH = Math.random().toString(36).slice(2, 10);

if (__MV3__) {
    const l1 = new Endpoint((msg) => {
        chrome.runtime.sendMessage({ type: "__resSandboxWire", msg: packBytes(msg) }, () => void chrome.runtime.lastError);
    });
    storeOwner.attach(l1, { all: true });
    l1.handle("fetch", (a, s) => {
        if (!s) throw new Error("fetch: no script");
        return fetchFor(s, a.request, !!a.bypass);
    });
    chrome.runtime.onMessage.addListener((msg: any) => {
        if (msg?.type === "__resWire") l1.receive(unpackBytes(msg.msg));
        return false;
    });
}
