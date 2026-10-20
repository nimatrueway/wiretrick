/** A script's error state as shown by the manager list and the popup. */
export interface ScriptHealthInput {
    error: string | null;
    runtimeError?: { message: string; at: number; count: number } | null;
}

export interface ScriptHealth {
    /** "compile": the script failed to load; "runtime": a hook threw/failed */
    kind: "compile" | "runtime";
    tooltip: string;
}

/** Drop engine-internal stack frames (extension / anonymous) — keep the user's. */
function userFrames(msg: string): string {
    return msg
        .split("\n")
        .filter((l) => !/^\s*at .*(chrome-extension:|moz-extension:|<anonymous>)/.test(l))
        .join("\n");
}

export function scriptHealth(s: ScriptHealthInput): ScriptHealth | null {
    if (s.error) return { kind: "compile", tooltip: `Compile error — the script is not running:\n${userFrames(s.error)}` };
    const r = s.runtimeError;
    if (!r) return null;
    const when = new Date(r.at).toLocaleTimeString();
    const times = r.count > 1 ? ` (${r.count}×, last at ${when})` : ` (at ${when})`;
    return { kind: "runtime", tooltip: `Runtime error${times}:\n${userFrames(r.message)}\n\nClick to dismiss. Saving the script clears it too.` };
}
