/**
 * In-place patching of an existing settings.yaml.
 *
 * The yaml package's parseDocument gives every node's exact source range,
 * so edits are applied as minimal text splices: only the value of a changed
 * entry is rewritten (keeping the user's key style, spacing and trailing
 * comment), new entries are inserted after their map's last item, and
 * missing sections are appended. Comments, blank lines, key order,
 * indentation and line endings elsewhere are preserved byte-for-byte.
 *
 * (Document#setIn + toString would apply the same edits structurally, but
 * toString reprints the WHOLE document from the AST — normalizing all
 * whitespace — so it cannot meet the "untouched regions stay
 * byte-for-byte" contract. Ranges + splices can.)
 *
 * Anything the patcher can't express (unparsable text, non-map sections,
 * flow collections, …) makes patchSettings return null → the caller
 * regenerates canonically. A final parse-equivalence check guarantees the
 * patched text expresses exactly the target state; otherwise null.
 */
import { parseDocument, isMap, isScalar, Scalar, stringify, type YAMLMap } from "yaml";
import { resolveParamValues, paramDefault } from "./scriptDef";
import {
    parseSettings, planSettings, scriptKeys, scriptBlock, entryLines, commentedDefaultLines, renderedKeyText,
    DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, defaultStrategySetting,
    type GlobalSettings, type ScriptSettingsState,
} from "./settingsYaml";

const isMulti = (d: any): boolean => d?.type === "string" && !!d.multiline;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Edit {
    start: number;
    end: number;
    text: string;
    /** replacements sort after same-offset insertions (applied last → lands first) */
    replace?: boolean;
}

const same = (a: any, b: any): boolean => JSON.stringify(a) === JSON.stringify(b);
const eolOf = (src: string): string => (src.includes("\r\n") ? "\r\n" : "\n");

/** column (chars since line start) of an offset — the indent of a key there */
function columnOf(src: string, offset: number): number {
    const ls = src.lastIndexOf("\n", offset - 1);
    return offset - (ls + 1);
}

/** end of the line containing `offset`, before its \r?\n */
function lineContentEnd(src: string, offset: number): number {
    const nl = src.indexOf("\n", offset);
    if (nl < 0) return src.length;
    return nl > 0 && src[nl - 1] === "\r" ? nl - 1 : nl;
}

/**
 * `at` is right after a line break (or EOF) — back up over it. Note the
 * yaml parser absorbs the NEXT line's indent spaces into a preceding empty
 * section's range, so spaces/tabs are skipped first.
 */
function prevLineContentEnd(src: string, at: number): number {
    let p = at;
    while (p > 0 && (src[p - 1] === " " || src[p - 1] === "\t")) p--;
    if (p > 0 && src[p - 1] === "\n") p--;
    if (p > 0 && src[p - 1] === "\r") p--;
    return p;
}

/** the pair of `key` directly in a map node */
function findPair(map: YAMLMap, key: string): any {
    return map.items.find((p: any) => isScalar(p.key) && p.key.value === key);
}

/** the section's source slice: its key line + comment block + entries */
function sectionSource(src: string, pair: any): string {
    const v = pair.value;
    const end = v?.range ? v.range[2] : pair.key.range[1];
    return src.slice(pair.key.range[0], end);
}

/** does the section's source already document this key (a commented `# key:` entry)? */
function documentedIn(srcSlice: string, key: string): boolean {
    const re = new RegExp(`^[ \\t]*#[ \\t]*${escapeRegExp(renderedKeyText(key))}[ \\t]*:`, "m");
    return re.test(srcSlice);
}

/** does the section document its options at all (any commented `# key:` entry)? */
const DOCUMENTS_ENTRIES = /^[ \t]*#[ \t]*[^\s#][^:\n]*:/m;

/**
 * End offset (line content end) of the commented `# key: …` entry in the
 * section, consuming any more-indented comment continuation lines (a
 * commented block-scalar default spans several). null when not present.
 */
function commentedEntryEnd(src: string, sectionPair: any, key: string): number | null {
    const slice = sectionSource(src, sectionPair);
    const re = new RegExp(`^[ \\t]*#[ \\t]*${escapeRegExp(renderedKeyText(key))}[ \\t]*:.*$`, "m");
    const m = re.exec(slice);
    if (!m || m.index === undefined) return null;
    let end = lineContentEnd(src, sectionPair.key.range[0] + m.index);
    for (;;) {
        const nl = src.indexOf("\n", end);
        if (nl < 0) break;
        const nextEnd = lineContentEnd(src, nl + 1);
        if (!/^[ \t]*#[ \t][ \t]/.test(src.slice(nl + 1, nextEnd))) break; // not an indented comment continuation
        end = nextEnd;
    }
    return end;
}

/** comment out a stale live entry (its param is no longer declared, or its script is gone) */
function commentOutEdit(src: string, pair: any, eol: string, why = "no longer declared in the script"): Edit | null {
    const keyNode = pair.key;
    if (!keyNode?.range) return null;
    const v = pair.value;
    const endNode = v ?? keyNode;
    if (!endNode.range) return null;
    const indent = columnOf(src, keyNode.range[0]);
    const start = keyNode.range[0] - indent; // line start (incl. indent)
    const end = endNode.range[1] > 0 && src[endNode.range[1] - 1] === "\n"
        ? prevLineContentEnd(src, endNode.range[1])
        : lineContentEnd(src, endNode.range[1]);
    const pad = " ".repeat(indent);
    const commented = src
        .slice(start, end)
        .split("\n")
        .map((l) => pad + "# " + l.slice(indent))
        .join(eol);
    const note = `${pad}# ${why} — kept for reference:`;
    return { start, end, text: note + eol + commented, replace: true };
}

/** render a value as it would appear after `key: ` (one element per line) */
function renderValue(value: any, flow: boolean): string[] {
    const text = stringify({ v: value }, { lineWidth: 0, ...(flow ? { collectionStyle: "flow" as const, flowCollectionPadding: false } : {}) }).trimEnd();
    const lines = text.split("\n");
    lines[0] = lines[0].startsWith("v: ") ? lines[0].slice(3) : "";
    return lines;
}

/**
 * Text replacing the source range of the pair's value so the entry reads as
 * `value`. Single-line values render inline (keeping the existing quote
 * style); multi-line strings become block scalars with content re-indented
 * under the key; arrays render as one-line flow sequences.
 */
function valueReplacement(src: string, pair: any, value: any, eol: string): string | null {
    const v = pair.value;
    if (Array.isArray(value)) {
        if (!value.every((x) => typeof x === "string")) return null;
        return renderValue(value, true)[0];
    }
    if (typeof value === "string" && value.includes("\n") && isScalar(v)) {
        const lines = renderValue(value, false);
        if (lines.length > 1) {
            // block scalar: header stays on the key line, content re-indented
            const keyIndent = columnOf(src, pair.key.range[0]);
            return lines[0] + eol + lines.slice(1).map((l) => " ".repeat(keyIndent) + l).join(eol);
        }
        return lines[0]; // library chose a quoted one-liner
    }
    if (typeof value === "string" && isScalar(v)) {
        if (v.type === Scalar.QUOTE_DOUBLE) return JSON.stringify(value);
        if (v.type === Scalar.QUOTE_SINGLE) return `'${value.replace(/'/g, "''")}'`;
    }
    const lines = renderValue(value, false);
    return lines.length === 1 ? lines[0] : null;
}

/** Replace the value of an existing pair. */
function replaceValueEdit(src: string, pair: any, value: any, eol: string): Edit | null {
    const v = pair.value;
    if (v == null || (!isScalar(v) && !isCollectionNode(v))) return null; // map/alias/missing → regen
    if (!v.range) return null;
    let text = valueReplacement(src, pair, value, eol);
    if (text === null) return null;
    const [start, end] = [v.range[0], v.range[1]];
    // a block scalar/seq range includes its last line's newline — keep it
    if (end > start && src[end - 1] === "\n" && !text.endsWith("\n")) text += eol;
    if (text.includes("\n")) {
        // a multi-line replacement must not swallow a trailing comment into
        // the block scalar's content — move it onto the header line
        let comment: string | null = null;
        let newEnd = end;
        if (isScalar(v) && (v.type === Scalar.BLOCK_LITERAL || v.type === Scalar.BLOCK_FOLDED)) {
            // old block scalar: the header line (inside the replaced range) may carry a comment
            const m = src.slice(start, lineContentEnd(src, start)).match(/\s(#.*)$/);
            if (m) comment = m[1];
        } else {
            const lineEnd = lineContentEnd(src, end);
            const m = src.slice(end, lineEnd).match(/^\s*(#.*)$/);
            if (m) {
                comment = m[1];
                newEnd = lineEnd;
            }
        }
        if (comment) text = text.replace(/^[^\n]*/, (h) => `${h} ${comment}`);
        return { start, end: newEnd, text, replace: true };
    }
    // an empty value sitting right before a trailing comment needs a space
    if (start === end && src[start] === "#") return { start, end, text: text + " ", replace: true };
    return { start, end, text, replace: true };
}

const isCollectionNode = (n: any): boolean => !isScalar(n) && n != null && typeof n === "object" && "items" in n;

/**
 * Offset right after a pair's last line (before the line break):
 * - scalar value: after its trailing comment (range[2] is past the newline)
 * - map/seq value: after its last item, before any trailing comment lines
 * - valueless pair (`key:`): the end of the key's line
 */
function pairInsertAt(src: string, pair: any): number | null {
    const key = pair.key;
    const v = pair.value;
    if (v == null) return key?.range ? lineContentEnd(src, key.range[1]) : null;
    if (!v.range) return null;
    if (isScalar(v)) {
        // an empty section's null-scalar range[2] covers its comment block —
        // insert after it so live entries land below the commented defaults
        return prevLineContentEnd(src, v.range[2]);
    }
    // map/seq value: after its last item AND any trailing comment lines
    // (range[2] covers them), so a new section doesn't split the previous
    // section's documentation tail
    const at = v.range[2];
    return at > 0 && src[at - 1] === "\n" ? prevLineContentEnd(src, at) : lineContentEnd(src, at);
}

/** append a whole section at the document end (keeps one blank line before it) */
function appendSectionEdit(src: string, lines: string[], eol: string): Edit {
    let text = "";
    if (src.length && !src.endsWith("\n")) text += eol;
    if (!/(^|\n)[ \t]*(\r?\n)$/.test(src)) text += eol;
    text += lines.join(eol) + eol;
    return { start: src.length, end: src.length, text };
}

type MapTarget =
    | { kind: "map"; node: YAMLMap }
    | { kind: "empty"; pair: any } // `key:` with no map value (all commented out)
    | { kind: "missing" }; // no such key — caller appends at doc end

function classify(root: YAMLMap, key: string): MapTarget | null {
    const pair = findPair(root, key);
    if (!pair) return { kind: "missing" };
    const v = pair.value;
    if (isMap(v)) return { kind: "map", node: v };
    if (v == null || (isScalar(v) && v.value == null)) return { kind: "empty", pair };
    return null; // scalar/seq/alias section → caller regenerates
}

/** Minimal edit of `existing` so it expresses the state; null if it can't be patched. */
export function patchSettings(existing: string, g: GlobalSettings, scripts: ScriptSettingsState[]): string | null {
    let doc: any;
    try {
        doc = parseDocument(existing);
    } catch {
        return null;
    }
    if (doc.errors.length) return null;
    const root = doc.contents;
    if (!isMap(root)) return null; // empty / scalar / seq document → canonical regen
    let current: ReturnType<typeof parseSettings>;
    try {
        current = parseSettings(existing);
    } catch {
        return null;
    }
    const eol = eolOf(existing);
    const edits: Edit[] = [];
    const insertions = new Map<number, string[]>(); // offset → fully-indented lines
    const appended: string[] = [];

    /** queue inserting `lines` (relative indent 0) at an offset with a given indent */
    const queueAt = (at: number, indent: number, lines: string[]): void => {
        const arr = insertions.get(at) ?? [];
        arr.push(...lines.map((l) => (l === "" ? "" : " ".repeat(indent) + l)));
        insertions.set(at, arr);
    };

    /** queue inserting `lines` (relative indent 0) into a map target */
    const insertInto = (target: MapTarget & { kind: "map" | "empty" }, lines: string[]): boolean => {
        let at: number | null;
        let indent: number;
        if (target.kind === "map") {
            const map = target.node;
            if ((map as any).flow) return false; // flow collection → regen
            const items = map.items;
            if (!items.length) return false; // empty flow map (`{}`) → regen
            const last: any = items[items.length - 1];
            if (!last.key?.range) return false;
            indent = columnOf(existing, last.key.range[0]);
            at = pairInsertAt(existing, last);
        } else {
            if (!target.pair.key?.range) return false;
            indent = columnOf(existing, target.pair.key.range[0]) + 2;
            at = pairInsertAt(existing, target.pair);
        }
        if (at === null) return false;
        queueAt(at, indent, lines);
        return true;
    };

    /** queue inserting a live entry for `key` — right under its commented default when the section documents one */
    const insertEntry = (sectionPair: any, target: MapTarget & { kind: "map" | "empty" }, key: string, lines: string[]): boolean => {
        const underDoc = commentedEntryEnd(existing, sectionPair, key);
        if (underDoc !== null) {
            queueAt(underDoc, columnOf(existing, sectionPair.key.range[0]) + 2, lines);
            return true;
        }
        return insertInto(target, lines);
    };

    // --- globals ---
    const globals: [string, any, any][] = [
        ["logLevel", g.logLevel, DEFAULT_LOG_LEVEL],
        ["logCap", g.logCap, DEFAULT_LOG_CAP],
        ["strategy", g.strategy, defaultStrategySetting()],
    ];
    const settingsTarget = classify(root, "settings");
    if (settingsTarget === null) return null;
    if (settingsTarget.kind === "missing") {
        const needed = globals.filter(([, v, d]) => !same(v, d));
        if (needed.length) {
            appended.push("settings:");
            for (const [k, v] of needed) appended.push(...entryLines(k, v).map((l) => "  " + l));
        }
    } else {
        for (const [k, want, def] of globals) {
            if (same((current.settings as any)?.[k] ?? def, want)) continue;
            const pair = settingsTarget.kind === "map" ? findPair(settingsTarget.node, k) : undefined;
            if (pair) {
                const edit = replaceValueEdit(existing, pair, want, eol);
                if (!edit) return null;
                edits.push(edit);
            } else if (!insertInto(settingsTarget, entryLines(k, want))) return null;
        }
    }

    // --- scripts ---
    const paramsTarget = classify(root, "params");
    if (paramsTarget === null) return null;
    const missingBlocks: string[][] = []; // canonical blocks of scripts with no section yet
    for (const s of scripts) {
        const want: [string, any, any][] = s.declared ? [["enabled", s.enabled, true]] : [];
        const vals = resolveParamValues(s.defs, s.values);
        for (const k of scriptKeys(s)) want.push([k, vals[k], paramDefault(s.defs[k])]);
        const scriptPair = paramsTarget.kind === "map" ? findPair(paramsTarget.node, s.name) : undefined;
        const scriptNode = scriptPair?.value;
        const scriptMissing = !scriptPair && paramsTarget.kind !== "missing";
        const scriptEmpty = !!scriptPair && (scriptNode == null || (isScalar(scriptNode) && scriptNode.value == null));
        if (scriptPair && !scriptEmpty && !isMap(scriptNode)) return null; // weird shape → regen

        if (paramsTarget.kind === "missing" || scriptMissing) {
            // no section at all: insert the full canonical block (documented
            // entries) so the file stays a complete options document
            const block = scriptBlock(s, 0);
            if (block) missingBlocks.push(block);
            continue;
        }
        if (scriptEmpty) {
            // an all-commented section: insert live entries for non-default
            // values (right under their commented default when present), and
            // document params the file doesn't mention yet (a newly declared
            // param must appear even at its default)
            const srcSlice = sectionSource(existing, scriptPair);
            const batch: string[] = [];
            for (const [k, v, d] of want) {
                if (!same(v, d)) {
                    const lines = entryLines(k, v, { block: isMulti(s.defs[k]) });
                    if (!insertEntry(scriptPair, { kind: "empty", pair: scriptPair }, k, lines)) return null;
                } else if (!documentedIn(srcSlice, k)) {
                    batch.push(...commentedDefaultLines(k, s.defs[k]));
                }
            }
            if (batch.length && !insertInto({ kind: "empty", pair: scriptPair }, batch)) return null;
            continue;
        }
        // existing map section: patch entry-wise
        const docTable = current.params[s.name];
        const srcSlice = sectionSource(existing, scriptPair);
        const sectionDocuments = DOCUMENTS_ENTRIES.test(srcSlice); // follow the section's own convention
        for (const [k, v, d] of want) {
            const pair = findPair(scriptNode, k);
            if (pair) {
                if (!same(docTable?.[k] ?? d, v)) {
                    const edit = replaceValueEdit(existing, pair, v, eol);
                    if (!edit) return null;
                    edits.push(edit);
                }
                continue;
            }
            if (!same(docTable?.[k] ?? d, v)) {
                // no live entry, non-default value → insert a live line
                if (!insertEntry(scriptPair, { kind: "map", node: scriptNode }, k, entryLines(k, v, { block: isMulti(s.defs[k]) }))) return null;
            } else if (sectionDocuments && !documentedIn(srcSlice, k)) {
                // newly declared param at its default in a documented section
                if (!insertInto({ kind: "map", node: scriptNode }, commentedDefaultLines(k, s.defs[k]))) return null;
            }
        }
        // params removed from the script: comment out their stale live
        // entries (a live value would otherwise silently map to nothing)
        for (const pair of scriptNode.items) {
            const k = isScalar(pair.key) ? pair.key.value : undefined;
            if (typeof k !== "string") continue;
            const stale = k === "enabled" ? !s.declared : !Object.prototype.hasOwnProperty.call(s.defs, k);
            if (!stale) continue;
            const edit = commentOutEdit(existing, pair, eol);
            if (!edit) return null;
            edits.push(edit);
        }
    }

    // sections of scripts that no longer exist: comment them out whole
    if (paramsTarget.kind === "map") {
        const names = new Set(scripts.map((s) => s.name));
        for (const pair of paramsTarget.node.items) {
            const k = isScalar(pair.key) ? pair.key.value : undefined;
            if (typeof k !== "string" || names.has(k)) continue;
            const edit = commentOutEdit(existing, pair, eol, `script "${k}" no longer exists`);
            if (!edit) return null;
            edits.push(edit);
        }
    }

    // scripts without a section: insert their canonical blocks (one params:
    // header at most; blank line between sections, as in renderSettings)
    if (missingBlocks.length) {
        if (paramsTarget.kind === "missing") {
            if (appended.length) appended.push("");
            appended.push("params:");
            let first = true;
            for (const b of missingBlocks) {
                if (!first) appended.push("");
                first = false;
                appended.push(...b.map((l) => "  " + l));
            }
        } else {
            for (const b of missingBlocks) {
                const lines = paramsTarget.kind === "map" ? ["", ...b] : b;
                if (!insertInto(paramsTarget, lines)) return null;
            }
        }
    }

    if (!edits.length && !insertions.size && !appended.length) return existing; // byte-for-byte no-op

    for (const [at, lines] of insertions) edits.push({ start: at, end: at, text: eol + lines.join(eol) });
    if (appended.length) edits.push(appendSectionEdit(existing, appended, eol));
    edits.sort((a, b) => b.start - a.start || b.end - a.end || Number(a.replace ?? false) - Number(b.replace ?? false));
    let out = existing;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    // safety net: the result must parse and express exactly the target state
    try {
        const plan = planSettings(parseSettings(out), g, scripts);
        if (plan.globals.logLevel !== undefined || plan.globals.logCap !== undefined || plan.globals.strategy !== undefined || plan.scripts.length) return null;
    } catch {
        return null;
    }
    return out;
}

/**
 * A script was renamed: rename its params section key in place, so its
 * values and comments follow it (instead of the old section being
 * commented out as deleted and a fresh default block appended). No-op when
 * the text doesn't parse, has no such section, or already has one for the
 * new name.
 */
export function renameSettingsSection(text: string, oldName: string, newName: string): string {
    if (oldName === newName) return text;
    let doc;
    try {
        doc = parseDocument(text);
    } catch {
        return text;
    }
    if (doc.errors.length || !isMap(doc.contents)) return text;
    const params = findPair(doc.contents, "params")?.value;
    if (!isMap(params) || findPair(params, newName)) return text;
    const range = findPair(params, oldName)?.key?.range;
    if (!range) return text;
    return text.slice(0, range[0]) + stringify(newName).trimEnd() + text.slice(range[1]);
}
