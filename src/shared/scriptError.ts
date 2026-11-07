/**
 * Script error formatting for the log: the stored script name + the error,
 * with stack frames rewritten back to the user's source.
 *
 * Scripts compile via `new Function("wt", …, "\"use strict\";\n" + js +
 * "\n//# sourceURL=wiretrick-script:///<name>")` (scriptFn.ts). The sourceURL
 * names each script's frames — `at fn (wiretrick-script:///lib/a.ts:8:14)` —
 * so a library script's frames carry its own name, and the page hook's own
 * frames (an inline <script>: `<anonymous>:L:C` in Chrome) aren't mistaken
 * for the script's. The synthetic source adds exactly EVAL_WRAPPER_LINES
 * lines before the user's line 1 (`function anonymous(…`, `) {`, the
 * "use strict" line); sucrase preserves line numbers, so user line =
 * reported line − EVAL_WRAPPER_LINES. Every other frame (extension, hook,
 * package module) is dropped; user-code frames keep their function name.
 */

/** lines the new Function wrapper adds before the user's line 1 */
export const EVAL_WRAPPER_LINES = 3;

const SCRIPT_URL = "wiretrick-script:///";

/** the `//# sourceURL` that names a script's stack frames */
export function scriptUrl(name: string): string {
    return SCRIPT_URL + encodeURIComponent(name).replace(/%2F/g, "/");
}

/** a script frame's position in its user source (null: not a script frame, or inside the wrapper) */
export function scriptFrame(line: string): { name: string; line: number; column: number; fn: string | null } | null {
    const m = /wiretrick-script:\/\/\/([^\s():]*):(\d+):(\d+)/.exec(line);
    if (!m) return null;
    const userLine = Number(m[2]) - EVAL_WRAPPER_LINES;
    if (userLine < 1) return null;
    let name: string;
    try {
        name = decodeURIComponent(m[1]);
    } catch {
        name = m[1];
    }
    const fn = /^\s*at\s+(?:async\s+)?(\S+)\s+\(/.exec(line);
    return { name, line: userLine, column: Number(m[3]), fn: fn && fn[1] !== "eval" ? fn[1] : null };
}

/**
 * `[name] TypeError: msg` + the user-code stack frames mapped to source
 * positions. `context` (e.g. "onRequest") is inserted after the name.
 */
export function formatScriptError(name: string, e: any, context?: string): string {
    const stack = e && e.stack ? String(e.stack) : String(e);
    const nl = stack.indexOf("\n");
    const head = nl < 0 ? stack : stack.slice(0, nl);
    const frames = nl < 0 ? [] : stack.slice(nl + 1).split("\n");
    const rewritten = frames.map(rewriteFrame).filter((f): f is string => !!f);
    return [`[${name}]${context ? ` ${context}:` : ""} ${head}`, ...rewritten].join("\n");
}

/**
 * The user-source line of the outermost script frame on the current stack:
 * the line in the script's top level that made the current call (for
 * `wt.onRequest(…)`, its registration — also when a recipe from an imported
 * utility registered it). Firefox may not name `new Function` frames by
 * their sourceURL: there they read `… > Function:L:C`.
 */
export function callerLine(): number | undefined {
    const E = Error as any;
    const limit = E.stackTraceLimit;
    E.stackTraceLimit = 100;
    const stack = String(new Error().stack || "");
    E.stackTraceLimit = limit;
    const frame = /(?:wiretrick-script:\/\/\/[^\s():]*|> Function):(\d+):\d+/g;
    let line: number | undefined;
    for (let m = frame.exec(stack); m; m = frame.exec(stack)) {
        const l = Number(m[1]) - EVAL_WRAPPER_LINES;
        if (l >= 1) line = l;
    }
    return line;
}

/**
 * One stack frame line → the user-source frame (`at fn (name:L:C)`), or
 * null to drop it (extension / hook / package / eval machinery). Returns the
 * line unchanged when it isn't a frame (a continuation of a multi-line
 * message).
 */
export function rewriteFrame(line: string): string | null {
    if (!/^\s*at\s/.test(line)) return line;
    const f = scriptFrame(line);
    if (!f) return null;
    return f.fn ? `    at ${f.fn} (${f.name}:${f.line}:${f.column})` : `    at ${f.name}:${f.line}:${f.column}`;
}
