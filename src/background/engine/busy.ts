/**
 * Work in flight on script changes — compiling a save, reloading the
 * strategies and pushing the hot-reload — so the toolbar icon can show it.
 */
let inFlight = 0;
const listeners = new Set<(busy: boolean) => void>();

/** Mark work started; call the returned function (once) when it's done. */
export function beginBusy(): () => void {
    if (inFlight++ === 0) for (const f of listeners) f(true);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        if (--inFlight === 0) for (const f of listeners) f(false);
    };
}

export async function whileBusy<T>(work: () => Promise<T>): Promise<T> {
    const end = beginBusy();
    try {
        return await work();
    } finally {
        end();
    }
}

export function onBusyChange(fn: (busy: boolean) => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
