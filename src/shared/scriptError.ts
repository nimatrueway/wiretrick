/**
 * Script error formatting for the log: the stored script name + the error,
 * with stack frames rewritten from the eval wrapper's `<anonymous>:LINE:COL`
 * back to the user's source.
 *
 * Scripts compile via `new Function("res", …, "\"use strict\";\n" + js)`,
 * whose synthetic source adds exactly EVAL_WRAPPER_LINES lines before the
 * user's line 1 (verified empirically: `function anonymous(…`, `) {`, the
 * "use strict" line). Sucrase preserves line numbers, so user line =
 * reported line − EVAL_WRAPPER_LINES. Eval machinery and extension frames
 * are stripped; user-code frames keep their function name when present.
 *
 * Note: `//# sourceURL` does NOT change the stack *string* (it only affects
 * DevTools rendering), so the log text needs this rewriter.
 */

/** lines the new Function wrapper adds before the user's line 1 */
export const EVAL_WRAPPER_LINES = 3;

/**
 * `[name] TypeError: msg` + the user-code stack frames mapped to source
 * positions. `context` (e.g. "onRequest") is inserted after the name.
 */
export function formatScriptError(name: string, e: any, context?: string): string {
    const stack = e && e.stack ? String(e.stack) : String(e);
    const nl = stack.indexOf("\n");
    const head = nl < 0 ? stack : stack.slice(0, nl);
    const frames = nl < 0 ? [] : stack.slice(nl + 1).split("\n");
    const rewritten = frames.map((f) => rewriteFrame(name, f)).filter((f): f is string => !!f);
    return [`[${name}]${context ? ` ${context}:` : ""} ${head}`, ...rewritten].join("\n");
}

/**
 * One stack frame line → the user-source frame, or null to drop it
 * (extension / eval machinery). Returns the line unchanged when it isn't a
 * frame (a continuation of a multi-line message).
 */
export function rewriteFrame(name: string, line: string): string | null {
    if (!/^\s*at\s/.test(line)) return line;
    const m = line.match(/<anonymous>:(\d+):(\d+)/);
    if (!m) return null; // extension / eval machinery frame
    const userLine = Number(m[1]) - EVAL_WRAPPER_LINES;
    if (userLine < 1) return null; // inside the wrapper itself
    const fn = line.match(/^\s*at\s+(?:async\s+)?(\S+)\s+\(eval at /);
    const fnName = fn && fn[1] !== "eval" ? fn[1] : null;
    return fnName ? `    at ${fnName} (${name}:${userLine}:${m[2]})` : `    at ${name}:${userLine}:${m[2]}`;
}
