import { signal, computed } from "@preact/signals";
import type { NetEntry, NetPortMsg } from "../../shared/netTypes";

/** Network-tab state: entries from the background recorder, keyed by id. */
export function createNetStore() {
    const byId = new Map<string, NetEntry>();
    const version = signal(0);
    const entries = computed(() => {
        void version.value;
        return [...byId.values()];
    });
    let send: ((m: any) => void) | null = null;

    function apply(msg: NetPortMsg): void {
        if (msg.type === "netCleared") byId.clear();
        else if (msg.type === "netRemoved") for (const id of msg.ids) byId.delete(id);
        else {
            if (msg.type === "netSnapshot") byId.clear();
            for (const e of msg.entries) byId.set(e.id, e);
            // the recorder drops its oldest entries; mirror its cap
            if (byId.size > 1500) for (const k of [...byId.keys()].slice(0, byId.size - 1000)) byId.delete(k);
        }
        version.value++;
    }

    return {
        entries,
        apply,
        clear(): void {
            byId.clear();
            version.value++;
            send?.({ type: "netClear" });
        },
        /** wire to the background "network" port (reconnects after SW restarts) */
        connect(onMessage?: (m: NetPortMsg) => void): void {
            const open = () => {
                let port: chrome.runtime.Port;
                try {
                    port = chrome.runtime.connect({ name: "network" });
                } catch {
                    return; // extension reloading — the manager reloads itself
                }
                send = (m) => port.postMessage(m);
                port.onMessage.addListener((m: NetPortMsg) => {
                    apply(m);
                    onMessage?.(m);
                });
                port.onDisconnect.addListener(() => {
                    send = null;
                    void chrome.runtime.lastError;
                    setTimeout(open, 500);
                });
            };
            open();
        },
    };
}

export type NetStore = ReturnType<typeof createNetStore>;
