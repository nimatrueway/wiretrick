import { proxy, ref } from "valtio";
import type { LogFilter } from "../logFilter";
import type { LogLine } from "../logQuery";
import { badges, badgesChanged } from "./panel";

/** `ctx`: where a script's GUI code ran ("overlay › example.com", see shared/scriptLog.ts contextTag) */
export type LogItem = LogLine & { text: string; seq: number; ctx?: string };

/**
 * Log auto-scroll, VS Code style: "follow" keeps the newest line in view;
 * scrolling up pauses it ("paused", resumes at the end); the lock button
 * stops it until clicked again ("locked").
 */
export type LogScroll = "follow" | "paused" | "locked";

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
/** "observed (no change)" DEBUG lines (one per handler run) may fill at most this much of the buffer */
const MAX_OBSERVED_ENTRIES = 300;
const MAX_ENTRIES = 2000;

export const logState = proxy({
    /** bumped when the buffer changes */
    version: 0,
    /** the lowest level shown */
    level: "info",
    /** lines shown (the newest that pass the filters) */
    cap: 500,
    /** the filter bar's query (all lines until it mounts) */
    filter: ref<LogFilter>({ test: () => true, mark: null }),
    scroll: "follow" as LogScroll,
});

/** All received entries: filtered ones stay here, so a new filter can show them. */
const entries: LogItem[] = [];
/** Sources seen in the buffer: the filter's `source:` suggestions. */
const sources = new Set<string>();
let observedEntries = 0;
let seq = 0;

/** Extract the source tag of a message: "[pipeline] …" → "pipeline"; "console.log: …" → "console.log". */
export function sourceOf(message: string): string {
    const bracket = message.match(/^\s*\[([^\]]*)\]/);
    if (bracket) return bracket[1];
    const dot = message.match(/^\s*([a-zA-Z0-9_.-]+):/);
    return dot ? dot[1] : "(untagged)";
}

export function appendLog(entry: { at: number; message?: unknown; level?: string; kind?: string; ctx?: unknown }): void {
    const time = new Date(entry.at).toLocaleTimeString();
    const message = String(entry.message ?? "");
    const source = sourceOf(message);
    const observed = entry.kind === "observed";
    const level = entry.level || "info";
    const ctx = typeof entry.ctx === "string" && entry.ctx ? entry.ctx : undefined;
    entries.push({ text: `[${time}] ${message}`, message, level, source, seq: seq++, ...(observed ? { observed } : {}), ...(ctx ? { ctx } : {}) });
    badges.log.note(level);
    let counted = level === "error" || level === "warn";
    if (observed && ++observedEntries > MAX_OBSERVED_ENTRIES) {
        entries.splice(entries.findIndex((e) => e.observed), 1);
        observedEntries--;
    }
    if (entries.length > MAX_ENTRIES) {
        for (const e of entries.splice(0, entries.length - MAX_ENTRIES)) {
            if (e.observed) observedEntries--;
            badges.log.drop(e.level);
            counted ||= e.level === "error" || e.level === "warn";
        }
    }
    if (counted) badgesChanged();
    sources.add(source);
    logState.version++;
}

export function clearLog(): void {
    entries.length = 0;
    observedEntries = 0;
    badges.log.reset();
    badgesChanged();
    if (logState.scroll === "paused") logState.scroll = "follow";
    logState.version++;
}

/** The lines the Log shows: the newest `cap` that pass the level and the filter. */
export function shownLines(): LogItem[] {
    const min = LEVEL_ORDER[logState.level] ?? 1;
    const f = logState.filter;
    return entries.filter((e) => (LEVEL_ORDER[e.level] ?? 1) >= min && f.test(e)).slice(-logState.cap);
}

export const logSources = (): string[] => [...sources].sort((a, b) => a.localeCompare(b));
