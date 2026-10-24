/**
 * Problems view: what is currently wrong with each script (and each data
 * file, and settings.yaml). Unlike Log lines, a Problem goes away by itself once it is
 * fixed — type errors live as you type, the rest when the script is saved.
 */
import { EVAL_WRAPPER_LINES } from "../shared/scriptError";
import { userFrames } from "../shared/scriptHealth";
import type { TabBadge } from "./logBadge";

export type ProblemSeverity = "error" | "warning";
export type ProblemKind = "compile" | "rules" | "runtime" | "ts" | "route" | "settings" | "json";

/** Settings dialog sections a message can point at ("… (Settings → Local helper)") → their element id */
const SETTINGS_SECTIONS: Record<string, string> = {
    Appearance: "settings-sec-appearance",
    "Synced folder": "settings-sec-folder",
    "Import / Export": "settings-sec-io",
    Strategy: "settings-sec-strategy",
    "Local helper": "settings-sec-helper",
    Logging: "settings-sec-logging",
    Advanced: "settings-sec-advanced",
    About: "settings-sec-about",
};
/** The "Settings → Section" a message mentions, with where it is in the message, or null. */
export function settingsLink(message: string): { text: string; label: string; section: string; at: number } | null {
    for (const [label, section] of Object.entries(SETTINGS_SECTIONS)) {
        const text = `Settings → ${label}`;
        const at = message.indexOf(text);
        if (at >= 0) return { text, label, section, at };
    }
    return null;
}

export interface Problem {
    severity: ProblemSeverity;
    kind: ProblemKind;
    message: string;
    line?: number;
    column?: number;
    /** where the squiggle ends (exclusive column), when the source is known */
    endLine?: number;
    endColumn?: number;
    /** runtime errors can be dismissed (×) */
    dismissible?: boolean;
}

export interface ProblemGroup {
    /** script / data file id, or the settings id for settings.yaml */
    id: string;
    /** file path shown in the group header */
    label: string;
    file: "ts" | "yaml" | "json";
    problems: Problem[];
}

/** An editor marker, already mapped from Monaco's severity. */
export interface ProblemMarker {
    severity: ProblemSeverity;
    message: string;
    line: number;
    column: number;
}

export interface ProblemScript {
    id: string;
    /** shown name (e.g. "Foo.ts") */
    label: string;
    error?: string | null;
    ruleErrors?: string[];
    runtimeError?: { message: string; at: number; count: number } | null;
    /** saved-code TypeScript errors, "line N: message" */
    typeErrors?: string[];
    routeWarnings?: string[];
    /** the script's handlers and their registration lines ("onRequest #2" → its line) */
    routes?: { kind: string; index: number; line?: number; url?: string[] }[];
    /** the saved source: positions get a range (the token, the URL pattern) */
    code?: string;
}

/** A data file's JSON syntax errors (its editor model's markers). */
export interface ProblemDataFile {
    id: string;
    /** its path (e.g. "mock/limits.json") */
    label: string;
    markers: ProblemMarker[];
}

export const SETTINGS_GROUP = { id: "__settings__", label: "settings.yaml" };

function runtimeMessage(r: { message: string; at: number; count: number }): string {
    const when = new Date(r.at).toLocaleTimeString();
    const times = r.count > 1 ? `${r.count}×, last at ${when}` : `at ${when}`;
    return `Runtime error (${times}): ${userFrames(r.message)}`;
}

function storedTypeError(e: string): Problem {
    const m = /^line (\d+):\s*([\s\S]*)$/.exec(e);
    return m ? { severity: "error", kind: "ts", message: m[2], line: Number(m[1]) } : { severity: "error", kind: "ts", message: e, line: 1 };
}

interface Position {
    line: number;
    column?: number;
}

/**
 * Where an error points in the user's source: a frame rewritten to the
 * source (`at fn (Name:12:5)`), a raw eval frame (`<anonymous>:15:5`, past
 * the wrapper lines) or a syntax error's `(line 12)`. The first user frame
 * is where it was thrown.
 */
export function errorPosition(msg: string): Position | undefined {
    for (const l of msg.split("\n")) {
        if (!/^\s*at\s/.test(l)) continue;
        const raw = /<anonymous>:(\d+):(\d+)/.exec(l);
        if (raw) {
            const line = Number(raw[1]) - EVAL_WRAPPER_LINES;
            if (line >= 1) return { line, column: Number(raw[2]) };
            continue;
        }
        if (/chrome-extension:|moz-extension:/.test(l)) continue;
        const src = /:(\d+):(\d+)\)?\s*$/.exec(l);
        if (src) return { line: Number(src[1]), column: Number(src[2]) };
    }
    const syntax = /^\S*Error\b.*\(line (\d+)\)$/m.exec(msg);
    return syntax ? { line: Number(syntax[1]) } : undefined;
}

const HANDLER = /\b(onRequest|onResponseHeaders|replaceResponse|onResponseBody|onDocument) #(\d+)\b/;

interface Range {
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
}

const lineStart = (lines: string[], line: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);

function rangeAt(lines: string[], offset: number, length: number): Range {
    const before = lines.join("\n").slice(0, offset).split("\n");
    const line = before.length;
    const column = before[line - 1].length + 1;
    return { line, column, endLine: line, endColumn: Math.min(column + length, lines[line - 1].length + 1) };
}

/** the whole (trimmed) line */
function lineRange(lines: string[], line: number): Range {
    const l = Math.min(Math.max(line, 1), lines.length);
    const text = lines[l - 1] ?? "";
    const column = text.length - text.trimStart().length + 1;
    return { line: l, column, endLine: l, endColumn: Math.max(text.trimEnd().length + 1, column + 1) };
}

/**
 * Where a handler named in a message ("onRequest #2: …") is: the URL pattern
 * the message quotes, found in the source (from the registration on, else
 * anywhere — e.g. a constant), else the registration call itself. The
 * registration line comes from the stored route, else the Nth `wt.<kind>(`.
 */
function handlerRange(msg: string, s: ProblemScript): Range | { line: number } | undefined {
    const m = HANDLER.exec(msg);
    if (!m) return undefined;
    const route = s.routes?.find((r) => r.kind === m[1] && r.index === Number(m[2]) - 1);
    const code = s.code;
    if (!code) return route?.line ? { line: route.line } : undefined;
    const lines = code.split("\n");
    let line = route?.line;
    if (!line) {
        const calls = [...code.matchAll(new RegExp(`\\bwt\\s*\\.\\s*${m[1]}\\s*\\(`, "g"))];
        const call = calls[Number(m[2]) - 1];
        if (call) line = code.slice(0, call.index).split("\n").length;
    }
    const from = line ? lineStart(lines, line) : 0;
    for (const url of route?.url ?? []) {
        if (!msg.includes(`"${url}"`)) continue;
        for (const text of new Set([url, JSON.stringify(url).slice(1, -1)])) {
            const at = code.indexOf(text, from);
            const any = at >= 0 ? at : code.indexOf(text);
            if (any >= 0) return rangeAt(lines, any, text.length);
        }
    }
    return line ? lineRange(lines, line) : undefined;
}

/** a stack position → the token there (or the rest of the line) */
function tokenRange(lines: string[], p: Position): Range {
    if (!p.column) return lineRange(lines, p.line);
    const l = Math.min(Math.max(p.line, 1), lines.length);
    const text = lines[l - 1] ?? "";
    const word = /^[\w$]+/.exec(text.slice(p.column - 1));
    return { line: l, column: p.column, endLine: l, endColumn: p.column + (word ? word[0].length : 1) };
}

const fromMarkers = (markers: ProblemMarker[], kind: ProblemKind): Problem[] =>
    markers.map((m) => ({ severity: m.severity, kind, message: m.message, line: m.line, column: m.column }));

/** VS Code order: errors before warnings, then by position. */
function byPosition(a: Problem, b: Problem): number {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);
}

/**
 * Every current problem, one group per file that has any: settings.yaml
 * first, then the scripts in the given (explorer) order, then the data
 * files. A script with a
 * live editor model uses its markers (`liveMarkers` has its id); otherwise
 * the saved code's stored type errors stand in.
 */
export function collectProblems(scripts: ProblemScript[], liveMarkers: Map<string, ProblemMarker[]>, settingsMarkers?: ProblemMarker[], dataFiles: ProblemDataFile[] = []): ProblemGroup[] {
    const groups: ProblemGroup[] = [];
    if (settingsMarkers?.length) groups.push({ ...SETTINGS_GROUP, file: "yaml", problems: fromMarkers(settingsMarkers, "settings").sort(byPosition) });
    for (const s of scripts) {
        const problems: Problem[] = [];
        const live = liveMarkers.get(s.id);
        // every problem points at a line: its stack frame, else the handler's
        // registration, else (a load failure without either) the first live
        // error, else the top of the file
        const lines = s.code?.split("\n");
        const at = (raw: string, fallback?: number): Position | Range => {
            const pos = errorPosition(raw);
            if (pos) return lines ? tokenRange(lines, pos) : pos;
            const h = handlerRange(raw, s);
            if (h) return h;
            return lines ? lineRange(lines, fallback ?? 1) : { line: fallback ?? 1 };
        };
        const handler = (raw: string): Position | Range => handlerRange(raw, s) ?? (lines ? lineRange(lines, 1) : { line: 1 });
        if (s.error) problems.push({ severity: "error", kind: "compile", message: userFrames(s.error), ...at(s.error, live?.find((m) => m.severity === "error")?.line) });
        for (const r of s.ruleErrors || []) problems.push({ severity: "error", kind: "rules", message: r, ...handler(r) });
        if (s.runtimeError) problems.push({ severity: "error", kind: "runtime", message: runtimeMessage(s.runtimeError), dismissible: true, ...at(s.runtimeError.message) });
        if (live) problems.push(...fromMarkers(live, "ts"));
        // (the saved code's type errors aren't checked while it fails to compile)
        else if (!s.error) problems.push(...(s.typeErrors || []).map(storedTypeError));
        for (const w of s.routeWarnings || []) problems.push({ severity: "warning", kind: "route", message: w, ...handler(w) });
        if (problems.length) groups.push({ id: s.id, label: s.label, file: "ts", problems: problems.sort(byPosition) });
    }
    for (const d of dataFiles) if (d.markers.length) groups.push({ id: d.id, label: d.label, file: "json", problems: fromMarkers(d.markers, "json").sort(byPosition) });
    return groups;
}

export function problemCounts(groups: ProblemGroup[]): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const g of groups) for (const p of g.problems) p.severity === "error" ? errors++ : warnings++;
    return { errors, warnings };
}

/** Case-insensitive substring filter on the message and the file name; groups left empty are dropped. */
export function filterProblems(groups: ProblemGroup[], query: string): ProblemGroup[] {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
        .map((g) => (g.label.toLowerCase().includes(q) ? g : { ...g, problems: g.problems.filter((p) => p.message.toLowerCase().includes(q)) }))
        .filter((g) => g.problems.length);
}

const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;

/** Problems tab / status bar counts: the current problems — nothing to clear. */
export class ProblemsBadge implements TabBadge {
    errors = 0;
    warnings = 0;

    set(c: { errors: number; warnings: number }): void {
        this.errors = c.errors;
        this.warnings = c.warnings;
    }

    /** Problems go away when they're fixed, not when looked at. */
    reset(): void {}

    get counts() {
        return [["error", this.errors], ["warn", this.warnings]] as const;
    }

    get empty(): boolean {
        return !this.errors && !this.warnings;
    }

    get title(): string {
        return `${[this.errors && plural(this.errors, "error"), this.warnings && plural(this.warnings, "warning")].filter(Boolean).join(", ")} in Problems`;
    }
}
