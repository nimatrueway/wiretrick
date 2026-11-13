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
import { isParamDef, isParamGroup, resolveParamValues, paramDefault, type ParamTree } from "./scriptDef";
import {
    parseSettings, planSettings, scriptBlock, groupBlockLines, entryLines, commentedDefaultLines, renderedKeyText, globalOptionLines, yamlKey,
    DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, DEFAULT_BODY_CAP, isObj,
    type GlobalSettings, type ScriptSettingsState,
} from "./settingsYaml";
import { DEFAULT_TEXT_TYPES } from "./bodyKind";

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

/** does the section's source already document this key (a commented `# key:` entry at `indent` if given)? */
function documentedIn(srcSlice: string, key: string, indent?: number): boolean {
    const pad = indent !== undefined ? `[ ]{${indent}}` : `[ \\t]*`;
    const re = new RegExp(`^${pad}#[ \\t]*${escapeRegExp(renderedKeyText(key))}[ \\t]*:`, "m");
    return re.test(srcSlice);
}

/** does the section document its options at all (any commented `# key:` entry)? */
const DOCUMENTS_ENTRIES = /^[ \t]*#[ \t]*[^\s#][^:\n]*:/m;

/**
 * End offset (line content end) of the commented `# key: …` entry in the
 * section (at `indent` if given), consuming any more-indented comment continuation
 * lines (a commented block-scalar default spans several). null when not present.
 */
function commentedEntryEnd(src: string, sectionPair: any, key: string, indent?: number): number | null {
    const slice = sectionSource(src, sectionPair);
    const pad = indent !== undefined ? `[ ]{${indent}}` : `[ \\t]*`;
    const re = new RegExp(`^${pad}#[ \\t]*${escapeRegExp(renderedKeyText(key))}[ \\t]*:.*$`, "m");
    const m = re.exec(slice);
    if (!m || m.index === undefined) return null;
    let end = lineContentEnd(src, sectionPair.key.range[0] + m.index);
    const contIndent = indent !== undefined ? `[ ]{${indent}}#[ \\t][ \\t]` : `^[ \\t]*#[ \\t][ \\t]`;
    const contRe = new RegExp(`^${contIndent.replace(/^\^/, "")}`);
    for (;;) {
        const nl = src.indexOf("\n", end);
        if (nl < 0) break;
        const nextEnd = lineContentEnd(src, nl + 1);
        if (!contRe.test(src.slice(nl + 1, nextEnd))) break; // not an indented comment continuation
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
    // flow: render the value alone (a flow wrapper map would read "{v: [...]}")
    if (flow) return [stringify(value, { lineWidth: 0, collectionStyle: "flow", flowCollectionPadding: false }).trimEnd()];
    const text = stringify({ v: value }, { lineWidth: 0 }).trimEnd();
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

    const childIndentOf = (sectionPair: any, target: MapTarget & { kind: "map" | "empty" }): number => {
        if (target.kind === "map" && target.node.items.length) {
            const first: any = target.node.items[0];
            if (first?.key?.range) return columnOf(existing, first.key.range[0]);
        }
        return columnOf(existing, sectionPair.key.range[0]) + 2;
    };

    /** queue inserting a live entry for `key` — right under its commented default when the section documents one */
    const insertEntry = (sectionPair: any, target: MapTarget & { kind: "map" | "empty" }, key: string, lines: string[]): boolean => {
        const indent = childIndentOf(sectionPair, target);
        const underDoc = commentedEntryEnd(existing, sectionPair, key, indent);
        if (underDoc !== null) {
            queueAt(underDoc, indent, lines);
            return true;
        }
        return insertInto(target, lines);
    };

    // --- globals ---
    const globals: [string, any, any][] = [
        ["logLevel", g.logLevel, DEFAULT_LOG_LEVEL],
        ["logCap", g.logCap, DEFAULT_LOG_CAP],
        ["textTypes", g.textTypes ?? [...DEFAULT_TEXT_TYPES], [...DEFAULT_TEXT_TYPES]],
        ["bodyCap", g.bodyCap ?? DEFAULT_BODY_CAP, DEFAULT_BODY_CAP],
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
        const settingsPair = findPair(root, "settings");
        const settingsSrc = sectionSource(existing, settingsPair);
        const documents = settingsTarget.kind === "empty" || DOCUMENTS_ENTRIES.test(settingsSrc);
        const undocumented: string[] = [];
        for (const [k, want, def] of globals) {
            const pair = settingsTarget.kind === "map" ? findPair(settingsTarget.node, k) : undefined;
            if (same((current.settings as any)?.[k] ?? def, want)) {
                // a setting the file doesn't mention yet (added by an update): document it
                if (!pair && documents && !documentedIn(settingsSrc, k)) undocumented.push(...globalOptionLines(k as any, g));
                continue;
            }
            if (pair) {
                const edit = replaceValueEdit(existing, pair, want, eol);
                if (!edit) return null;
                edits.push(edit);
            } else if (!insertInto(settingsTarget, entryLines(k, want))) return null;
        }
        if (undocumented.length && !insertInto(settingsTarget, undocumented)) return null;
    }

    const patchParamMap = (
        sectionPair: any,
        target: MapTarget & { kind: "map" | "empty" },
        defs: ParamTree,
        vals: Record<string, any> | undefined,
        docTable: Record<string, any> | undefined,
        rootScript?: { declared: boolean; enabled: boolean }
    ): boolean => {
        const srcSlice = sectionSource(existing, sectionPair);
        const childIndent = childIndentOf(sectionPair, target);
        const sectionDocuments = target.kind === "empty" || DOCUMENTS_ENTRIES.test(srcSlice);
        const leaves: [string, any, any, any][] = rootScript?.declared ? [["enabled", rootScript.enabled, true, undefined]] : [];
        const groups: [string, ParamTree][] = [];
        for (const [k, node] of Object.entries(defs)) {
            if (rootScript && k === "enabled") continue;
            if (isParamDef(node)) leaves.push([k, vals?.[k], paramDefault(node), node]);
            else if (isParamGroup(node)) groups.push([k, node]);
        }

        if (target.kind === "empty") {
            const batch: string[] = [];
            for (const [k, v, d, def] of leaves) {
                if (!same(v, d)) {
                    if (!insertEntry(sectionPair, target, k, entryLines(k, v, { block: isMulti(def) }))) return false;
                } else if (!documentedIn(srcSlice, k, childIndent)) {
                    batch.push(...commentedDefaultLines(k, def));
                }
            }
            for (const [k, group] of groups) batch.push(...groupBlockLines(k, group, vals?.[k]));
            if (batch.length && !insertInto(target, batch)) return false;
            return true;
        }

        const mapNode = target.node;
        for (const [k, v, d, def] of leaves) {
            const pair = findPair(mapNode, k);
            if (pair) {
                if (!same(docTable?.[k] ?? d, v)) {
                    const edit = replaceValueEdit(existing, pair, v, eol);
                    if (!edit) return false;
                    edits.push(edit);
                }
                continue;
            }
            if (!same(docTable?.[k] ?? d, v)) {
                if (!insertEntry(sectionPair, target, k, entryLines(k, v, { block: isMulti(def) }))) return false;
            } else if (sectionDocuments && !documentedIn(srcSlice, k, childIndent)) {
                if (!insertInto(target, commentedDefaultLines(k, def))) return false;
            }
        }

        for (const [k, group] of groups) {
            const pair = findPair(mapNode, k);
            if (!pair) {
                if (!insertInto(target, groupBlockLines(k, group, vals?.[k]))) return false;
                continue;
            }
            const subNode = pair.value;
            const subEmpty = subNode == null || (isScalar(subNode) && subNode.value == null);
            if (!subEmpty && !isMap(subNode)) return false;
            const subDoc = isObj(docTable?.[k]) ? docTable![k] : {};
            if (!patchParamMap(pair, subEmpty ? { kind: "empty", pair } : { kind: "map", node: subNode }, group, vals?.[k], subDoc)) return false;
        }

        // params or sections removed from the script: comment out their stale live entries
        for (const pair of mapNode.items) {
            const k = isScalar(pair.key) ? pair.key.value : undefined;
            if (typeof k !== "string") continue;
            const stale = rootScript && k === "enabled" ? !rootScript.declared : !Object.prototype.hasOwnProperty.call(defs, k);
            if (!stale) continue;
            const edit = commentOutEdit(existing, pair, eol);
            if (!edit) return false;
            edits.push(edit);
        }
        return true;
    };

    // --- scripts ---
    const paramsTarget = classify(root, "params");
    if (paramsTarget === null) return null;
    const missingBlocks: string[][] = []; // canonical blocks of scripts with no section yet
    for (const s of scripts) {
        const vals = resolveParamValues(s.defs, s.values);
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
        if (!patchParamMap(scriptPair, scriptEmpty ? { kind: "empty", pair: scriptPair } : { kind: "map", node: scriptNode }, s.defs, vals, current.params[s.name], { declared: s.declared, enabled: s.enabled })) {
            return null;
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
        if (plan.globals.logLevel !== undefined || plan.globals.logCap !== undefined || plan.globals.textTypes !== undefined || plan.globals.bodyCap !== undefined || plan.scripts.length) return null;
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
    return text.slice(0, range[0]) + yamlKey(newName) + text.slice(range[1]);
}

/** Upgrade legacy extensionless `.ts` section keys in place so user comments and values survive. */
export function migrateLegacySettingsKeys(text: string, scripts: readonly { name: string }[]): string {
    let out = text;
    for (const s of scripts) {
        if (s.name.endsWith(".ts")) out = renameSettingsSection(out, s.name.slice(0, -3), s.name);
    }
    return out;
}
