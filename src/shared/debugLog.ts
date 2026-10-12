/**
 * Debug log: timestamped ring buffer with a source tag. Every entry is
 * also printed to the local console, optionally mirrored to a sink (the
 * background uses this to stream entries into the manager's LOG panel).
 */

export type DebugLevel = "debug" | "info" | "warn" | "error";

export interface DebugEntry {
    at: number;
    src: string;
    msg: string;
    level?: DebugLevel;
}

const MAX = 3000;
const buffer: DebugEntry[] = [];
let sink: ((e: DebugEntry) => void) | null = null;

/** Register a mirror (used by the background to reach the UI panel). */
export function setSink(fn: (e: DebugEntry) => void): void {
    sink = fn;
}

export function dlog(src: string, ...args: unknown[]): void {
    dlogLevel(src, "debug", ...args);
}

/** Explicit-level variant; Errors bump to error automatically. */
export function dlogLevel(src: string, level: DebugEntry["level"], ...args: unknown[]): void {
    const inferred = args.find((a) => a instanceof Error) ? "error" : undefined;
    pushEntry({ at: Date.now(), src, msg: args.map(fmt).join(" "), level: inferred || level });
}

function fmt(a: unknown): string {
    if (a instanceof Error) return a.message || String(a);
    if (typeof a === "string") return a;
    try {
        return JSON.stringify(a);
    } catch {
        return String(a);
    }
}

export function getDebugBuffer(): DebugEntry[] {
    return buffer.slice();
}

export function clearDebugBuffer(): void {
    buffer.length = 0;
}

/** Push one entry into the local buffer + mirror to the sink if set. */
export function pushEntry(entry: DebugEntry): void {
    buffer.push(entry);
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
    sink?.(entry);
}
