/**
 * Debug log: timestamped ring buffer with a source tag. Every entry is
 * also printed to the local console. Contexts without storage (hook, sw)
 * forward entries to the background, which owns the canonical buffer that
 * the manager's "Download logs" button dumps.
 */

export interface DebugEntry {
    at: number;
    src: string;
    msg: string;
}

const MAX = 3000;
const buffer: DebugEntry[] = [];

export function dlog(src: string, ...args: unknown[]): void {
    const msg = args
        .map((a) => {
            if (typeof a === "string") return a;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(" ");
    buffer.push({ at: Date.now(), src, msg });
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
    console.log(`[res:${src}]`, ...args);
}

export function getDebugBuffer(): DebugEntry[] {
    return buffer.slice();
}

export function clearDebugBuffer(): void {
    buffer.length = 0;
}

/** Push one entry into the local buffer only (used when relaying). */
export function pushEntry(entry: DebugEntry): void {
    buffer.push(entry);
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}
