/**
 * The background's `wt.globalStore` owner and the links to it:
 *
 *   MV2 — scripts compile right here: one in-process replica hub, joined
 *         to the owner by an endpoint pair, shared by every strategy's
 *         compiled instance (so a store is one object across them).
 *   MV3 — scripts compile in the sandbox: its hub talks to the owner over
 *         the L1 link (sandbox ⇄ offscreen ⇄ chrome.runtime ⇄ here). The
 *         link also serves the sandbox's `wt.fetch`.
 */
import { Endpoint, endpointPair, type WireRequest, type WireResponse } from "../../shared/wire";
import { ReplicaHub } from "../../shared/storeReplica";
import { packBytes, unpackBytes } from "../../shared/bytesPack";
import { StoreOwner } from "./storeOwner";
import { log } from "./logs";
import { scriptStorageAll, scriptStorageSet, getScript } from "./scriptStore";
import { backgroundFetch } from "./wtFetch";
import { pages, pagesReady } from "./pages";

const ownerLog = (s: string, msg: string, level: "info" | "warn" | "error") => log(-1, msg, level, s);

export const storeOwner = new StoreOwner({
    // lambdas: scriptStore is part of an import cycle
    storageAll: (s) => scriptStorageAll(s),
    storageSet: (s, k, v) => scriptStorageSet(s, k, v),
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
// a page ended: its wt.pageStore copies go
pages.onEnd((key) => storeOwner.dropPage(key));

/** a script's name for log lines (its id if it's gone) */
async function nameOf(scriptId: string): Promise<string> {
    return (await getScript(scriptId).catch(() => undefined))?.meta.name ?? scriptId;
}

/** `wt.fetch(..., { from: "background" })` for a script */
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
 * in MV2, load the others' current state into the hub so `wt.globalStore`
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
