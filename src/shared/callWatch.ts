/**
 * Watchdog for a call whose answer may legitimately take forever — a
 * handler that waits for the user, say. It never times the call itself
 * out: after `checkMs` of quiet it asks the next hop whether the call is
 * still in flight (`ask`), and gives up (`onLost`) only if no `alive()`
 * comes back within `graceMs`. So it catches lost messages and dead hops,
 * not slow handlers.
 *
 * The answer is a message, not a timer on the other side, so a hidden tab
 * whose timers Chrome throttles to once a minute still answers at once.
 */
export interface CallWatch {
    /** the next hop says the call is still running */
    alive(): void;
    /** the call ended */
    stop(): void;
}

export function watchCall(opts: { checkMs: number; graceMs: number; ask: () => void; onLost: () => void }): CallWatch {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const arm = (ms: number, fn: () => void) => {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
    const lost = () => {
        done = true;
        opts.onLost();
    };
    const check = () => {
        arm(opts.graceMs, lost);
        try {
            opts.ask();
        } catch {}
    };
    arm(opts.checkMs, check);
    return {
        alive() {
            if (!done) arm(opts.checkMs, check);
        },
        stop() {
            done = true;
            clearTimeout(timer);
        },
    };
}
