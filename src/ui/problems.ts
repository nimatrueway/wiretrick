/**
 * Problems view: what is currently wrong with each script (and
 * settings.yaml). Unlike Log lines, a Problem goes away by itself once it is
 * fixed — type errors live as you type, the rest when the script is saved.
 */
import { EVAL_WRAPPER_LINES } from "../shared/scriptError";
import { userFrames } from "../shared/scriptHealth";
import type { TabBadge } from "./logBadge";

export type ProblemSeverity = "error" | "warning";
export type ProblemKind = "compile" | "rules" | "runtime" | "ts" | "route" | "settings";

export interface Problem {
    severity: ProblemSeverity;
    kind: ProblemKind;
    message: string;
    line?: number;
    column?: number;
    /** runtime errors can be dismissed (×) */
    dismissible?: boolean;
}

export interface ProblemGroup {
    /** script id, or the settings id for settings.yaml */
    id: string;
    /** file name shown in the group header */
    label: string;
    file: "ts" | "yaml";
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
    routes?: { kind: string; index: number; line?: number }[];
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

/** the registration line of the handler a message names ("onRequest #2: …") */
function handlerLine(msg: string, routes: ProblemScript["routes"]): number | undefined {
    const m = HANDLER.exec(msg);
    return m ? routes?.find((r) => r.kind === m[1] && r.index === Number(m[2]) - 1)?.line : undefined;
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
 * first, then the scripts in the given (explorer) order. A script with a
 * live editor model uses its markers (`liveMarkers` has its id); otherwise
 * the saved code's stored type errors stand in.
 */
export function collectProblems(scripts: ProblemScript[], liveMarkers: Map<string, ProblemMarker[]>, settingsMarkers?: ProblemMarker[]): ProblemGroup[] {
    const groups: ProblemGroup[] = [];
    if (settingsMarkers?.length) groups.push({ ...SETTINGS_GROUP, file: "yaml", problems: fromMarkers(settingsMarkers, "settings").sort(byPosition) });
    for (const s of scripts) {
        const problems: Problem[] = [];
        const live = liveMarkers.get(s.id);
        // every problem points at a line: its stack frame, else the handler's
        // registration, else (a load failure without either) the first live
        // error, else the top of the file
        const at = (raw: string, fallback?: number): Position => errorPosition(raw) ?? { line: handlerLine(raw, s.routes) ?? fallback ?? 1 };
        if (s.error) problems.push({ severity: "error", kind: "compile", message: userFrames(s.error), ...at(s.error, live?.find((m) => m.severity === "error")?.line) });
        for (const r of s.ruleErrors || []) problems.push({ severity: "error", kind: "rules", message: r, line: handlerLine(r, s.routes) ?? 1 });
        if (s.runtimeError) problems.push({ severity: "error", kind: "runtime", message: runtimeMessage(s.runtimeError), dismissible: true, ...at(s.runtimeError.message) });
        if (live) problems.push(...fromMarkers(live, "ts"));
        // (the saved code's type errors aren't checked while it fails to compile)
        else if (!s.error) problems.push(...(s.typeErrors || []).map(storedTypeError));
        for (const w of s.routeWarnings || []) problems.push({ severity: "warning", kind: "route", message: w, line: handlerLine(w, s.routes) ?? 1 });
        if (problems.length) groups.push({ id: s.id, label: s.label, file: "ts", problems: problems.sort(byPosition) });
    }
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
