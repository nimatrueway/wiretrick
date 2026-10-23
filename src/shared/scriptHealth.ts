/** A script's error state as shown by the manager list and the popup. */
export interface ScriptHealthInput {
    error: string | null;
    runtimeError?: { message: string; at: number; count: number } | null;
    /** TypeScript errors in the saved code ("line N: message") */
    typeErrors?: string[];
    /** `rules` handlers that couldn't become rules ("onRequest #2: reason") */
    ruleErrors?: string[];
}

export interface ScriptHealth {
    /** "compile": the script failed to load; "runtime": a hook threw/failed;
     * "rules": some handlers couldn't become `rules` (they don't run; the rest do);
     * "types": TypeScript errors (the script still runs — types are stripped) */
    kind: "compile" | "rules" | "runtime" | "types";
    tooltip: string;
}

/** Drop engine-internal stack frames (extension / anonymous) — keep the user's. */
export function userFrames(msg: string): string {
    return msg
        .split("\n")
        .filter((l) => !/^\s*at .*(chrome-extension:|moz-extension:|<anonymous>)/.test(l))
        .join("\n");
}

export function scriptHealth(s: ScriptHealthInput): ScriptHealth | null {
    if (s.error) return { kind: "compile", tooltip: `Compile error — the script is not running:\n${userFrames(s.error)}` };
    const rules = s.ruleErrors || [];
    if (rules.length) return { kind: "rules", tooltip: `Rules error — ${rules.length > 1 ? "these handlers don't" : "this handler doesn't"} run (the script's other handlers do):\n${rules.join("\n")}\n\nFix the script and save it.` };
    const r = s.runtimeError;
    if (!r) {
        const t = s.typeErrors || [];
        if (!t.length) return null;
        const shown = t.slice(0, 8).join("\n");
        const more = t.length > 8 ? `\n…and ${t.length - 8} more` : "";
        return { kind: "types", tooltip: `${t.length} TypeScript error${t.length > 1 ? "s" : ""}:\n${shown}${more}\n\nFix them in the editor.` };
    }
    const when = new Date(r.at).toLocaleTimeString();
    const times = r.count > 1 ? ` (${r.count}×, last at ${when})` : ` (at ${when})`;
    return { kind: "runtime", tooltip: `Runtime error${times}:\n${userFrames(r.message)}\n\nClick to dismiss. Saving the script clears it too.` };
}
