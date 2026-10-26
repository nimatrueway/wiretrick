/**
 * Log filter language: the Network query syntax (netQuery.ts) over log lines.
 *
 *   word, "two words", /regex/   → message contains
 *   level:warn  level:>=warn      source:pipeline      is:observed  is:link
 */
import { dialect, strTest, valueError, type QNode, type QValue, type Test } from "./network/netQuery";
import { logSegments } from "./logLinks";

/** one log line as the filter sees it */
export interface LogLine {
    /** the message, without the time prefix */
    message: string;
    level: string;
    source: string;
    observed?: boolean;
}
export interface LogSuggest {
    sources: string[];
}

const LEVELS = ["debug", "info", "warn", "error"];
const LEVEL_HELP: Record<string, string> = { debug: "Debug", info: "Info", warn: "Warning", error: "Error" };

const IS_VALUES: { name: string; help: string; test: (l: LogLine) => boolean }[] = [
    { name: "observed", help: "A script ran without changing the request", test: (l) => !!l.observed },
    { name: "link", help: "Has a link", test: (l) => logSegments(l.message).some((s) => s.uri) },
];

function levelTest(v: QValue): Test {
    const m = /^(>=|<=|>|<|=)?([a-z]+)$/i.exec(v.text.trim());
    const rank = m ? LEVELS.indexOf(m[2].toLowerCase()) : -1;
    if (!m || rank < 0) throw valueError("level: expects debug, info, warn or error (>=warn: warnings and errors)");
    const op = m[1] ?? "";
    return (l: LogLine) => {
        const r = LEVELS.indexOf(l.level);
        return op === ">" ? r > rank : op === ">=" ? r >= rank : op === "<" ? r < rank && r >= 0 : op === "<=" ? r <= rank && r >= 0 : r === rank;
    };
}

function logValueTest(field: string, v: QValue): Test {
    switch (field) {
        case "level":
            return levelTest(v);
        case "is": {
            const t = IS_VALUES.find((x) => x.name === v.text.toLowerCase());
            if (!t) throw valueError(`is: expects ${IS_VALUES.map((x) => x.name).join(", ")}`);
            return t.test;
        }
        case "source": {
            const ok = strTest(v, false);
            return (l: LogLine) => ok(l.source);
        }
        default: {
            const ok = strTest(v, false);
            return (l: LogLine) => ok(l.message);
        }
    }
}

function logFieldValues(field: string, data: LogSuggest): { value: string; detail?: string }[] {
    switch (field) {
        case "level":
            return [...LEVELS.map((value) => ({ value, detail: LEVEL_HELP[value] })), { value: ">=warn", detail: "Warnings and errors" }];
        case "source":
            return data.sources.map((value) => ({ value }));
        case "is":
            return IS_VALUES.map((x) => ({ value: x.name, detail: x.help }));
        default:
            return [];
    }
}

export const LOG = dialect({
    fields: [
        { name: "message", kind: "text", help: "Message text" },
        { name: "source", kind: "text", help: "Script name or component (pipeline, page…)" },
        { name: "level", kind: "enum", help: "debug, info, warn, error; >=warn" },
        { name: "is", kind: "is", help: "observed, link" },
    ],
    bare: "message",
    bareNoun: "message",
    valueTest: logValueTest,
    fieldValues: logFieldValues,
    quick: ["level", "source", "is"],
    merge: new Set(["level", "source", "is"]),
    modeKey: "wt.log.filterMode",
    initial: "",
    sample: "level:>=warn source:pipeline -is:observed",
    syntax: [
        ["word", "Message contains word (space = AND)"],
        ["field:value", "Field contains / equals value"],
        ["field:a,b", "Either value"],
        ["-term   NOT term", "Exclude"],
        ["a OR b   ( … )", "Either side; group with parentheses"],
        ['"two words"', "Quote spaces, commas, parentheses"],
        ["=value   val*   /re/", "Exact, wildcard (whole value), regex"],
        [">=warn   <info", "This level and above / below"],
    ],
    examples: [
        ["level:>=warn", "Warnings and errors"],
        ["source:pipeline", "What the engine's pipeline did"],
        ["/timeout|refused/", "Regex over the message"],
        ['level:error OR "failed"', "Errors, or anything that failed"],
        ["is:link -source:page", "Lines with a link, not from the page"],
        ["is:observed", "Handlers that ran without changing anything"],
    ],
    note: "The level menu to the right also applies — pick Debug+ to see `debug` lines.",
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What to highlight in a shown line: the message words the query looks for (not the excluded ones). */
export function logHighlight(ast: QNode | null): RegExp | null {
    const parts: string[] = [];
    const walk = (n: QNode) => {
        if (n.k === "not") return;
        if (n.k !== "term") return n.items.forEach(walk);
        if (n.field !== null && n.field !== "message") return;
        for (const v of n.values) {
            if (v.regex) parts.push(v.text);
            else {
                const text = !v.raw.startsWith('"') && v.text.startsWith("=") ? v.text.slice(1) : v.text;
                const wild = !v.quoted && text.includes("*");
                if (text.replace(/\*/g, "")) parts.push(wild ? text.split("*").filter(Boolean).map(escapeRe).join(".*?") : escapeRe(text));
            }
        }
    };
    if (ast) walk(ast);
    if (!parts.length) return null;
    try {
        return new RegExp(parts.join("|"), "i");
    } catch {
        return null;
    }
}
