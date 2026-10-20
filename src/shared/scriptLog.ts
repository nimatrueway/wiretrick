/**
 * Formatting for user-script log output (res.log and console.*), shared by
 * every context a script runs in: background/sandbox, the MAIN-world hook
 * and the isolated bridge. Every line reaches the extension's LOG panel as
 * `[<script name>] <source>: <text>`, attributed to the script id.
 */

export type ScriptLogLevel = "debug" | "info" | "warn" | "error";

/** console methods a script's `console` shadows */
export const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

export function consoleMethodLevel(method: string): ScriptLogLevel {
    if (method === "error") return "error";
    if (method === "warn") return "warn";
    if (method === "debug" || method === "trace") return "debug";
    return "info";
}

const MAX_LEN = 4000;

function fmtOne(a: any): string {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (a === undefined) return "undefined";
    if (typeof a === "function") return `[function ${a.name || "anonymous"}]`;
    if (typeof a === "bigint" || typeof a === "symbol") return String(a);
    try {
        return JSON.stringify(a) ?? String(a);
    } catch {
        return String(a); // circular / exotic
    }
}

export function formatLogArgs(args: any[]): string {
    const text = args.map(fmtOne).join(" ");
    return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}… (${text.length - MAX_LEN} more chars)` : text;
}

/** the LOG-panel line for a script log: "[name] console.warn: text" */
export function scriptLogLine(name: string, source: string, text: string): string {
    return `[${name}] ${source}: ${text}`;
}

/**
 * Build the `console` object a user script sees. Nothing is echoed to the
 * host console (for page contexts that would litter the page's devtools);
 * every call goes to `emit` instead. Unshadowed members (time, table…)
 * fall through to the real console.
 */
export function makeScriptConsole(emit: (level: ScriptLogLevel, source: string, text: string) => void): Console {
    const shim: any = {};
    for (const method of CONSOLE_METHODS) {
        shim[method] = (...args: any[]) => emit(consoleMethodLevel(method), `console.${method}`, formatLogArgs(args));
    }
    return new Proxy(shim, { get: (t, k) => (k in t ? t[k as any] : (console as any)[k]) }) as Console;
}
