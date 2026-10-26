/**
 * Editor assistance for settings.yaml in the manager (diagnostics,
 * completion, hover). Mirrors settings.schema.json, plus what the schema
 * can't know: the per-script params each script defines (wt.params / wt.defineParam).
 * Pure (offsets in, offsets out) so Monaco wiring stays thin and testable.
 */
import { parseDocument, parse, isMap, isPair, isScalar, type Node } from "yaml";
import type { ParamDef } from "./scriptDef";
import { isValidParamValue, paramDefault } from "./scriptDef";
import { LOG_LEVELS, DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, yamlKey, isStrategy, isTextTypes, isBodyCap, DEFAULT_BODY_CAP, BODY_CAP_MIN, BODY_CAP_MAX, defaultStrategySetting } from "./settingsYaml";
import { DEFAULT_TEXT_TYPES } from "./bodyKind";
import { STRATEGIES } from "./route";
import { strategyMarkdown } from "./strategyInfo";
import { SETTINGS_SCHEMA } from "./settingsSchema";

export interface AssistScript {
    name: string;
    /** registers handlers (utilities have no enabled switch) */
    declared: boolean;
    defs: Record<string, ParamDef>;
}

export interface AssistDiag {
    start: number;
    end: number;
    severity: "error" | "warning";
    message: string;
}

const P = SETTINGS_SCHEMA.properties;
const GLOBAL_PROPS = P.settings.properties as Record<string, { type: string; description: string; default: any; enum?: string[]; minimum?: number; maximum?: number }>;

function typeLabel(d: ParamDef): string {
    switch (d.type) {
        case "enum":
            return d.choices.map((c) => JSON.stringify(c)).join(" | ");
        case "stringList":
            return "list of strings";
        case "number":
            return d.min !== undefined || d.max !== undefined ? `number (${d.min ?? "−∞"}…${d.max ?? "∞"})` : "number";
        default:
            return d.type;
    }
}

function globalValueError(key: string, v: any): string | null {
    if (key === "logLevel") return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v) ? null : `Expected one of ${LOG_LEVELS.join(" | ")}`;
    if (key === "logCap") return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 10000 ? null : "Expected an integer between 100 and 10000";
    if (key === "defaultStrategy") return isStrategy(v) ? null : `Expected one of ${STRATEGIES.join(" | ")}`;
    if (key === "bodyCap") return isBodyCap(v) ? null : `Expected an integer between ${BODY_CAP_MIN} and ${BODY_CAP_MAX} (kB)`;
    if (key === "textTypes") return isTextTypes(v) ? null : "Expected a non-empty list of Content-Type globs, e.g. [text/*, \"*json\"]";
    return null;
}

/** Problems in the document; invalid values are ignored on save, so they're errors here. */
export function settingsDiagnostics(text: string, scripts: AssistScript[]): AssistDiag[] {
    const out: AssistDiag[] = [];
    const doc = parseDocument(text, { prettyErrors: false });
    for (const e of doc.errors) out.push({ start: e.pos[0], end: Math.max(e.pos[1], e.pos[0] + 1), severity: "error", message: e.message.split("\n")[0] });
    if (doc.errors.length) return out;
    const at = (n: Node | null | undefined, severity: AssistDiag["severity"], message: string): void => {
        const r = n?.range;
        if (r) out.push({ start: r[0], end: Math.max(r[1], r[0] + 1), severity, message });
    };
    const root = doc.contents;
    if (root === null || (isScalar(root) && root.value === null)) return out;
    if (!isMap(root)) {
        at(root as Node, "error", "Expected a map with `settings` and `params`");
        return out;
    }
    const byName = new Map(scripts.map((s) => [s.name, s]));
    for (const pair of root.items) {
        if (!isPair(pair)) continue;
        const key = pair.key as Node;
        const k = isScalar(key) ? String(key.value) : "";
        const val = pair.value as Node | null;
        const empty = !val || (isScalar(val) && val.value === null);
        if (k === "settings") {
            if (empty) continue;
            if (!isMap(val)) {
                at(val, "error", "`settings` must be a map");
                continue;
            }
            for (const p of val.items) {
                const gk = isScalar(p.key) ? String(p.key.value) : "";
                if (!(gk in GLOBAL_PROPS)) {
                    at(p.key as Node, "warning", `Unknown setting "${gk}" (expected ${Object.keys(GLOBAL_PROPS).join(", ")})`);
                    continue;
                }
                const v = (p.value as any)?.toJSON?.() ?? null;
                const err = v === null ? null : globalValueError(gk, v);
                if (err) at(p.value as Node, "error", err);
            }
        } else if (k === "params") {
            if (empty) continue;
            if (!isMap(val)) {
                at(val, "error", "`params` must be a map of script names");
                continue;
            }
            for (const sp of val.items) {
                const name = isScalar(sp.key) ? String(sp.key.value) : "";
                const s = byName.get(name);
                if (!s) {
                    at(sp.key as Node, "warning", `No script named "${name}" — ignored`);
                    continue;
                }
                const sv = sp.value as Node | null;
                if (!sv || (isScalar(sv) && sv.value === null)) continue;
                if (!isMap(sv)) {
                    at(sv, "error", `Values for "${name}" must be a map`);
                    continue;
                }
                for (const p of sv.items) {
                    const pk = isScalar(p.key) ? String(p.key.value) : "";
                    const v = (p.value as any)?.toJSON?.() ?? null;
                    if (pk === "enabled") {
                        if (!s.declared) at(p.key as Node, "warning", `"${name}" is a library (registers no handlers) — it has no enabled switch`);
                        else if (v !== null && typeof v !== "boolean") at(p.value as Node, "error", "Expected true or false");
                        continue;
                    }
                    const d = s.defs[pk];
                    if (!d) {
                        const known = Object.keys(s.defs).filter((x) => x !== "enabled");
                        at(p.key as Node, "warning", `"${name}" declares no param "${pk}"${known.length ? ` (params: ${known.join(", ")})` : ""}`);
                        continue;
                    }
                    if (v === null) continue;
                    if (!isValidParamValue(d, v)) at(p.value as Node, "error", `Expected ${typeLabel(d)} — this value is ignored`);
                    else if (d.type === "number" && ((d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)))
                        at(p.value as Node, "warning", `Outside ${typeLabel(d)}`);
                }
            }
        } else {
            at(key, "warning", `Unknown top-level key "${k}" (expected settings, params)`);
        }
    }
    return out;
}

// ---- line-based context (works on half-typed, unparsable text) ----

interface LineCtx {
    /** keys of the enclosing maps, outermost first */
    path: string[];
    /** cursor is after `key:` on this line → completing that key's value */
    valueOf: string | null;
    /** sibling keys already present at this level */
    siblings: Set<string>;
    /** start offset of the word being typed */
    wordStart: number;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;
const isBlank = (l: string): boolean => !l.trim() || l.trimStart().startsWith("#");

function keyOfLine(l: string): string | null {
    const m = /^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#\s-][^#]*?)\s*:(?:\s|$)/.exec(l);
    if (!m) return null;
    try {
        const o = parse(m[0].trim().replace(/:$/, ": null"));
        const k = o && typeof o === "object" ? Object.keys(o)[0] : null;
        return k ?? null;
    } catch {
        return null;
    }
}

function lineContext(text: string, offset: number): LineCtx {
    const lines = text.split("\n");
    let row = 0;
    let acc = 0;
    while (row < lines.length - 1 && acc + lines[row].length < offset) acc += lines[row++].length + 1;
    const col = offset - acc;
    const cur = lines[row];
    const before = cur.slice(0, col);
    const ind = indentOf(cur.trim() ? cur : before);
    const path: string[] = [];
    let need = ind;
    let parentRow = -1;
    for (let r = row - 1; r >= 0 && need > 0; r--) {
        if (isBlank(lines[r])) continue;
        const i = indentOf(lines[r]);
        if (i < need) {
            const k = keyOfLine(lines[r]);
            if (k === null) break;
            path.unshift(k);
            if (parentRow < 0) parentRow = r;
            need = i;
        }
    }
    const siblings = new Set<string>();
    for (let r = parentRow + 1; r < lines.length; r++) {
        if (r === row || isBlank(lines[r])) continue;
        const i = indentOf(lines[r]);
        if (i < ind) break;
        if (i === ind) {
            const k = keyOfLine(lines[r]);
            if (k !== null) siblings.add(k);
        }
    }
    const valueKey = /:\s+\S*$|:$/.test(before) ? keyOfLine(before.replace(/:\s*\S*$/, ":")) : null;
    const word = /[^\s:]*$/.exec(before)![0];
    return { path, valueOf: valueKey, siblings, wordStart: offset - word.length };
}

export interface AssistCompletion {
    /** nested-map keys end in "\n  " — indent relative to the current line (Monaco re-indents) */
    label: string;
    insertText: string;
    kind: "property" | "value" | "module";
    detail?: string;
    documentation?: string;
}

function valueChoices(d: { type: string; choices?: string[]; enum?: string[] }): string[] {
    if (d.type === "boolean") return ["true", "false"];
    const c = d.choices ?? d.enum;
    return c ? c.map((x) => (/^[\w.-]+$/.test(x) && !/^(true|false|null|~|yes|no|on|off|-?\d)/i.test(x) ? x : JSON.stringify(x))) : [];
}

export function settingsCompletions(text: string, offset: number, scripts: AssistScript[]): { items: AssistCompletion[]; replaceFrom: number } {
    const c = lineContext(text, offset);
    const items: AssistCompletion[] = [];
    const key = (k: string, detail: string, documentation?: string, kind: AssistCompletion["kind"] = "property", block = false) => {
        if (!c.siblings.has(k)) items.push({ label: k, insertText: `${yamlKey(k)}:${block ? "\n  " : " "}`, kind, detail, documentation });
    };
    const values = (vs: string[], detail?: string) => vs.forEach((v) => items.push({ label: v, insertText: v, kind: "value", detail }));
    const [a, b] = c.path;
    const s = b !== undefined ? scripts.find((x) => x.name === b) : undefined;
    if (c.valueOf !== null) {
        if (c.path.length === 1 && a === "settings" && GLOBAL_PROPS[c.valueOf]) values(valueChoices(GLOBAL_PROPS[c.valueOf]), GLOBAL_PROPS[c.valueOf].description);
        else if (c.path.length === 2 && a === "params" && s) {
            if (c.valueOf === "enabled") values(["true", "false"], "Run this script");
            else if (s.defs[c.valueOf]) values(valueChoices(s.defs[c.valueOf] as any), s.defs[c.valueOf].description);
        }
        return { items, replaceFrom: c.wordStart };
    }
    if (c.path.length === 0) {
        key("settings", "Global extension settings", P.settings.description, "property", true);
        key("params", "Per-script values", P.params.description, "property", true);
    } else if (c.path.length === 1 && a === "settings") {
        for (const [k, d] of Object.entries(GLOBAL_PROPS)) key(k, `${d.type}, default ${JSON.stringify(d.default)}`, d.description);
    } else if (c.path.length === 1 && a === "params") {
        for (const x of scripts) key(x.name, x.declared ? "script" : "library", paramSummary(x), "module", true);
    } else if (c.path.length === 2 && a === "params" && s) {
        if (s.declared) key("enabled", "boolean, default true", "Run this script");
        for (const [k, d] of Object.entries(s.defs)) if (k !== "enabled") key(k, `${typeLabel(d)}, default ${JSON.stringify(paramDefault(d))}`, d.description);
    }
    return { items, replaceFrom: c.wordStart };
}

function paramSummary(s: AssistScript): string {
    const ks = Object.entries(s.defs).filter(([k]) => k !== "enabled");
    const head = s.declared ? "" : "Library (registers no handlers): no enabled switch.\n\n";
    return head + (ks.length ? ks.map(([k, d]) => `- \`${k}\`: ${typeLabel(d)}${d.description ? " — " + d.description : ""}`).join("\n") : "No params.");
}

/** Markdown hover for the key (or value) under the cursor. */
export function settingsHover(text: string, offset: number, scripts: AssistScript[]): { markdown: string; start: number; end: number } | null {
    const ls = text.lastIndexOf("\n", offset - 1) + 1;
    let le = text.indexOf("\n", offset);
    if (le < 0) le = text.length;
    const line = text.slice(ls, le);
    const k = keyOfLine(line);
    if (k === null) return null;
    const colon = line.search(/:(\s|$)/);
    const keyStart = ls + indentOf(line);
    if (offset < keyStart || offset > ls + line.length) return null;
    const c = lineContext(text, keyStart);
    const [a, b] = c.path;
    const span = { start: keyStart, end: ls + (colon < 0 ? line.length : colon) };
    let md: string | null = null;
    if (c.path.length === 0) {
        if (k === "settings") md = `**settings** — ${P.settings.description}`;
        else if (k === "params") md = `**params** — ${P.params.description}`;
    } else if (c.path.length === 1 && a === "settings" && GLOBAL_PROPS[k]) {
        const d = GLOBAL_PROPS[k];
        const range = d.enum ? d.enum.join(" | ") : d.minimum !== undefined ? `${d.type} ${d.minimum}…${d.maximum}` : d.type === "array" ? "list of strings" : d.type;
        const def = k === "logLevel" ? DEFAULT_LOG_LEVEL : k === "defaultStrategy" ? defaultStrategySetting() : k === "textTypes" ? DEFAULT_TEXT_TYPES : k === "bodyCap" ? DEFAULT_BODY_CAP : DEFAULT_LOG_CAP;
        md = k === "defaultStrategy" ? `**defaultStrategy** — ${strategyMarkdown()}` : `**${k}** — ${d.description}\n\n\`${range}\` · default \`${JSON.stringify(def)}\``;
    } else if (c.path.length === 1 && a === "params") {
        const s = scripts.find((x) => x.name === k);
        md = s ? `**${k}**\n\n${paramSummary(s)}` : `No script named **${k}** — ignored`;
    } else if (c.path.length === 2 && a === "params") {
        const s = scripts.find((x) => x.name === b);
        if (s && k === "enabled") md = s.declared ? "**enabled** — Run this script\n\n`boolean` · default `true`" : `"${b}" is a library — it has no enabled switch`;
        else if (s?.defs[k]) {
            const d = s.defs[k];
            md = `**${k}**${d.description ? " — " + d.description : ""}\n\n\`${typeLabel(d)}\` · default \`${JSON.stringify(paramDefault(d))}\``;
        }
    }
    return md ? { markdown: md, ...span } : null;
}
