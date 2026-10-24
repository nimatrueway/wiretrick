/**
 * Network filter query language (the Advanced filter bar; Basic chips
 * build the same string). GitHub-search-like:
 *
 *   bare words      → URL contains (space = AND)
 *   field:value     → method:POST  status:4xx  res-header:content-type=json
 *   field:a,b       → either value (OR)
 *   -term, NOT term → exclude;  a OR b;  ( … ) groups
 *   "quoted words", * wildcard (whole value), /regex/, =exact,
 *   >, >=, <, <= on status / size / time (size:>10kb, time:>500ms)
 *   is:touched|observed|modified|missed|failed|pending|cached
 */
import type { NetEntry } from "../../shared/netTypes";
import { ALL_TYPES, TYPE_FILTERS, category, duration, touchState, typeLabel } from "./netFormat";

export type FieldKind = "text" | "enum" | "status" | "number" | "header" | "is";

export interface FieldDef {
    name: string;
    kind: FieldKind;
    help: string;
}

export const FIELDS: FieldDef[] = [
    { name: "url", kind: "text", help: "Full URL" },
    { name: "host", kind: "text", help: "Host name" },
    { name: "path", kind: "text", help: "Path and query string" },
    { name: "method", kind: "enum", help: "GET, POST…" },
    { name: "status", kind: "status", help: "200, 4xx, >=400" },
    { name: "type", kind: "enum", help: "fetch, doc, js, css, img…" },
    { name: "mime", kind: "text", help: "Response content type" },
    { name: "req-header", kind: "header", help: "Request header: name or name=value" },
    { name: "res-header", kind: "header", help: "Response header: name or name=value" },
    { name: "req-body", kind: "text", help: "Recorded request body" },
    { name: "res-body", kind: "text", help: "Recorded response body" },
    { name: "tab", kind: "text", help: "Tab title (or tab id)" },
    { name: "script", kind: "text", help: "Script that ran on the request" },
    { name: "size", kind: "number", help: "Bytes: >10kb, <1mb" },
    { name: "time", kind: "number", help: "Duration: >500ms, <2s" },
    { name: "is", kind: "is", help: "touched, modified, failed…" },
];
const FIELD_MAP = new Map(FIELDS.map((f) => [f.name, f]));

export const IS_VALUES: { name: string; help: string }[] = [
    { name: "touched", help: "A script observed or modified it" },
    { name: "observed", help: "A script ran without changing it" },
    { name: "modified", help: "A script changed it" },
    { name: "missed", help: "A body handler should have run but didn't" },
    { name: "failed", help: "Network error" },
    { name: "pending", help: "Still loading" },
    { name: "cached", help: "Served from cache" },
];

export interface QueryError {
    message: string;
    start: number;
    end: number;
}

export interface QValue {
    /** source text of this value (quotes included) */
    raw: string;
    /** unquoted text (regex: the pattern) */
    text: string;
    quoted: boolean;
    regex: boolean;
}

export interface QueryCtx {
    tabTitle(id: number): string | undefined;
}

type Test = (e: NetEntry, ctx: QueryCtx) => boolean;

export interface TermNode {
    k: "term";
    /** null = a bare word (URL contains) */
    field: string | null;
    values: QValue[];
    /** source text without a leading "-" */
    raw: string;
    start: number;
    end: number;
    test: Test;
}
export type QNode = TermNode | { k: "and"; items: QNode[] } | { k: "or"; items: QNode[] } | { k: "not"; item: QNode };

class QErr extends Error {
    constructor(
        message: string,
        public start: number,
        public end: number,
    ) {
        super(message);
    }
}

type Tok = { t: "(" | ")" | "OR" | "AND" | "NOT"; start: number; end: number } | { t: "term"; start: number; end: number; term: TermNode; neg: boolean };

const isSpace = (c: string) => /\s/.test(c);

/** One value starting at `i`: segments of plain text and "quoted text", or a whole /regex/. */
function readValue(src: string, i: number, list: boolean): { v: QValue; end: number } {
    const start = i;
    const stop = (c: string) => isSpace(c) || c === ")" || (list && c === ",");
    if (src[i] === "/") {
        let j = i + 1;
        while (j < src.length && src[j] !== "/") j += src[j] === "\\" ? 2 : 1;
        if (j < src.length && j > i + 1 && (j + 1 >= src.length || stop(src[j + 1]))) {
            return { v: { raw: src.slice(i, j + 1), text: src.slice(i + 1, j), quoted: false, regex: true }, end: j + 1 };
        }
    }
    let text = "";
    let quoted = false;
    while (i < src.length && !stop(src[i])) {
        if (src[i] === '"') {
            let j = i + 1;
            let s = "";
            while (j < src.length && src[j] !== '"') {
                if (src[j] === "\\" && j + 1 < src.length) j++;
                s += src[j++];
            }
            if (j >= src.length) throw new QErr("Unclosed quote", i, src.length);
            text += s;
            quoted = true;
            i = j + 1;
        } else text += src[i++];
    }
    return { v: { raw: src.slice(start, i), text, quoted, regex: false }, end: i };
}

function scan(src: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (isSpace(c)) {
            i++;
            continue;
        }
        if (c === "(" || c === ")") {
            toks.push({ t: c, start: i, end: ++i });
            continue;
        }
        const start = i;
        if (c === "-" && src[i + 1] === "(") {
            toks.push({ t: "NOT", start, end: ++i });
            continue;
        }
        let neg = false;
        if (c === "-" && i + 1 < src.length && !isSpace(src[i + 1]) && src[i + 1] !== ")") {
            neg = true;
            i++;
        }
        const body = i;
        let field: string | null = null;
        const m = /^([A-Za-z][\w-]*):/.exec(src.slice(i));
        if (m) {
            const name = m[1].toLowerCase();
            if (FIELD_MAP.has(name)) {
                field = name;
                i += m[0].length;
            } else if (!/^(\/\/|\d)/.test(src.slice(i + m[0].length))) {
                throw new QErr(`Unknown field "${m[1]}" — quote it to search the URL`, i, i + m[1].length);
            }
        }
        const values: QValue[] = [];
        const starts: number[] = [];
        if (field === null) {
            starts.push(i);
            const r = readValue(src, i, false);
            values.push(r.v);
            i = r.end;
            const word = src.slice(body, i);
            if (!neg && (word === "OR" || word === "AND" || word === "NOT")) {
                toks.push({ t: word, start, end: i });
                continue;
            }
        } else {
            for (;;) {
                starts.push(i);
                const r = readValue(src, i, true);
                if (!r.v.raw) throw new QErr(`"${field}:" needs a value`, start, Math.max(i, start + 1));
                values.push(r.v);
                i = r.end;
                if (src[i] !== ",") break;
                i++;
            }
        }
        const term: TermNode = { k: "term", field, values, raw: src.slice(body, i), start, end: i, test: () => true };
        term.test = buildTest(term, starts);
        toks.push({ t: "term", start, end: i, term, neg });
    }
    return toks;
}

function parseTokens(toks: Tok[], srcLen: number): QNode | null {
    if (!toks.length) return null;
    let p = 0;
    const end = () => (p < toks.length ? toks[p].start : srcLen);
    const parseOr = (): QNode => {
        const items = [parseAnd(null)];
        while (toks[p]?.t === "OR") {
            const or = toks[p++];
            items.push(parseAnd(or));
        }
        return items.length === 1 ? items[0] : { k: "or", items };
    };
    const parseAnd = (after: Tok | null): QNode => {
        const items: QNode[] = [];
        while (p < toks.length && toks[p].t !== ")" && toks[p].t !== "OR") {
            if (toks[p].t === "AND") {
                p++;
                continue;
            }
            items.push(parseUnary());
        }
        if (!items.length) {
            if (after) throw new QErr("OR needs a filter after it", after.start, after.end);
            const t = toks[p] ?? toks[p - 1];
            throw new QErr(t.t === ")" ? "Unmatched )" : "Expected a filter", t.start, t.end);
        }
        return items.length === 1 ? items[0] : { k: "and", items };
    };
    const parseUnary = (): QNode => {
        const t = toks[p++];
        if (t.t === "NOT") {
            if (p >= toks.length || toks[p].t === ")" || toks[p].t === "OR") throw new QErr("NOT needs a filter after it", t.start, t.end);
            return { k: "not", item: parseUnary() };
        }
        if (t.t === "(") {
            if (toks[p]?.t === ")") throw new QErr("Empty ( )", t.start, toks[p].end);
            const inner = parseOr();
            if (toks[p]?.t !== ")") throw new QErr("Missing )", t.start, end());
            p++;
            return inner;
        }
        if (t.t === "term") return t.neg ? { k: "not", item: t.term } : t.term;
        throw new QErr("Unexpected " + t.t, t.start, t.end);
    };
    const ast = parseOr();
    if (p < toks.length) throw new QErr("Unmatched )", toks[p].start, toks[p].end);
    return ast;
}

/** Parse (and validate) a query; an empty query parses to `null` (match everything). */
export function parseQuery(src: string): { ast: QNode | null; error: QueryError | null } {
    try {
        return { ast: parseTokens(scan(src), src.length), error: null };
    } catch (err) {
        if (err instanceof QErr) return { ast: null, error: { message: err.message, start: err.start, end: Math.max(err.end, err.start + 1) } };
        throw err;
    }
}

export function compileQuery(ast: QNode | null, ctx: QueryCtx): (e: NetEntry) => boolean {
    const build = (n: QNode): ((e: NetEntry) => boolean) => {
        switch (n.k) {
            case "term":
                return (e) => n.test(e, ctx);
            case "not": {
                const f = build(n.item);
                return (e) => !f(e);
            }
            case "and": {
                const fs = n.items.map(build);
                return (e) => fs.every((f) => f(e));
            }
            case "or": {
                const fs = n.items.map(build);
                return (e) => fs.some((f) => f(e));
            }
        }
    };
    return ast ? build(ast) : () => true;
}

// ── value matchers ───────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function regex(pattern: string): RegExp {
    try {
        return new RegExp(pattern, "i");
    } catch {
        throw new QErr("Invalid regular expression", 0, 0);
    }
}

/** contains (default) / =exact / * wildcard (whole value) / /regex/ */
function strTest(v: QValue, exactByDefault: boolean): (s: string) => boolean {
    if (v.regex) {
        const re = regex(v.text);
        return (s) => re.test(s);
    }
    let text = v.text;
    let exact = exactByDefault;
    if (!v.raw.startsWith('"') && text.startsWith("=")) {
        exact = true;
        text = text.slice(1);
    }
    if (!v.quoted && text.includes("*")) {
        const re = new RegExp("^" + text.split("*").map(escapeRe).join(".*") + "$", "i");
        return (s) => re.test(s);
    }
    const needle = text.toLowerCase();
    return exact ? (s) => s.toLowerCase() === needle : (s) => s.toLowerCase().includes(needle);
}

const CMP = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)([a-z]*)$/i;
function cmpTest(op: string, n: number): (x: number) => boolean {
    switch (op) {
        case ">":
            return (x) => x > n;
        case ">=":
            return (x) => x >= n;
        case "<":
            return (x) => x < n;
        case "<=":
            return (x) => x <= n;
        default:
            return (x) => x === n;
    }
}

const SIZE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, kb: 1024, m: 1024 * 1024, mb: 1024 * 1024 };
const TIME_UNITS: Record<string, number> = { "": 1, ms: 1, s: 1000, m: 60000 };

function urlPart(url: string, part: "host" | "path"): string {
    try {
        const u = new URL(url);
        return part === "host" ? u.host : u.pathname + u.search;
    } catch {
        return part === "host" ? "" : url;
    }
}

function headerTest(v: QValue, which: "req" | "res"): Test {
    if (v.regex) throw new QErr("Use name=/regex/ to match a header value", 0, 0);
    const eq = v.text.indexOf("=");
    const name = (eq < 0 ? v.text : v.text.slice(0, eq)).trim();
    if (!name) throw new QErr("Header name missing (name or name=value)", 0, 0);
    const nameOk = strTest({ ...v, raw: name, text: name, quoted: false }, true);
    let valueOk: ((s: string) => boolean) | null = null;
    if (eq >= 0) {
        const value = v.text.slice(eq + 1);
        const m = /^\/(.+)\/$/.exec(value);
        valueOk = m ? ((re) => (s: string) => re.test(s))(regex(m[1])) : strTest({ raw: value, text: value, quoted: v.quoted, regex: false }, false);
    }
    return (e) => ((which === "req" ? e.requestHeaders : e.responseHeaders) ?? []).some(([n, val]) => nameOk(n) && (!valueOk || valueOk(val)));
}

function valueTest(field: string, v: QValue): Test {
    const def = FIELD_MAP.get(field)!;
    const anyStr = (get: (e: NetEntry, ctx: QueryCtx) => (string | undefined)[], exact = false): Test => {
        const ok = strTest(v, exact);
        return (e, ctx) => get(e, ctx).some((s) => s !== undefined && ok(s));
    };
    switch (def.kind) {
        case "is": {
            const k = v.text.toLowerCase();
            const tests: Record<string, (e: NetEntry) => boolean> = {
                touched: (e) => touchState(e) !== "none",
                observed: (e) => touchState(e) === "observed",
                modified: (e) => touchState(e) === "modified",
                missed: (e) => e.outcomes.some((o) => o.kind === "missed"),
                failed: (e) => e.state === "failed",
                pending: (e) => e.state === "pending",
                cached: (e) => e.fromCache,
            };
            if (!tests[k]) throw new QErr(`is: expects ${IS_VALUES.map((x) => x.name).join(", ")}`, 0, 0);
            return tests[k];
        }
        case "status": {
            const t = v.text.trim();
            const cls = /^([1-5])xx$/i.exec(t);
            if (cls) return (e) => e.status !== null && Math.floor(e.status / 100) === Number(cls[1]);
            const range = /^(\d+)\.\.(\d+)$/.exec(t);
            if (range) return (e) => e.status !== null && e.status >= Number(range[1]) && e.status <= Number(range[2]);
            const m = CMP.exec(t);
            if (!m || m[3]) throw new QErr("status: expects a code (200), a class (4xx) or a comparison (>=400)", 0, 0);
            const ok = cmpTest(m[1] ?? "", Number(m[2]));
            return (e) => e.status !== null && ok(e.status);
        }
        case "number": {
            const units = field === "size" ? SIZE_UNITS : TIME_UNITS;
            const m = CMP.exec(v.text.trim());
            const unit = m?.[3].toLowerCase() ?? "";
            if (!m || !(unit in units)) throw new QErr(field === "size" ? "size: expects bytes like >10kb or <1mb" : "time: expects a duration like >500ms or <2s", 0, 0);
            const ok = cmpTest(m[1] ?? "", Number(m[2]) * units[unit]);
            const get = field === "size" ? (e: NetEntry) => e.size : duration;
            return (e) => {
                const x = get(e);
                return x !== null && ok(x);
            };
        }
        case "header":
            return headerTest(v, field === "req-header" ? "req" : "res");
    }
    switch (field) {
        case "host":
            return anyStr((e) => [urlPart(e.url, "host")]);
        case "path":
            return anyStr((e) => [urlPart(e.url, "path")]);
        case "method":
            return anyStr((e) => [e.method], true);
        case "type":
            return anyStr((e) => [category(e), typeLabel(e), e.type], true);
        case "mime":
            return anyStr((e) => [e.mime]);
        case "req-body":
            return anyStr((e) => [e.requestBody?.text]);
        case "res-body":
            return anyStr((e) => [e.responseBody?.text, e.originalResponseBody?.text]);
        case "script":
            return anyStr((e) => e.outcomes.map((o) => o.scriptName));
        case "tab": {
            const title = anyStr((e, ctx) => [ctx.tabTitle(e.tabId)]);
            const id = /^\d+$/.test(v.text) ? Number(v.text) : null;
            return (e, ctx) => e.tabId === id || title(e, ctx);
        }
        default:
            return anyStr((e) => [e.url]);
    }
}

function buildTest(term: TermNode, starts: number[]): Test {
    const tests = term.values.map((v, i) => {
        try {
            return valueTest(term.field ?? "url", v);
        } catch (err) {
            // value errors are raised position-less; point them at the value
            if (err instanceof QErr && err.start === 0 && err.end === 0) throw new QErr(err.message, starts[i], starts[i] + v.raw.length);
            throw err;
        }
    });
    return tests.length === 1 ? tests[0] : (e, ctx) => tests.some((t) => t(e, ctx));
}

// ── Basic chips ⇄ query ──────────────────────────────────────────────

/** One Basic-mode chip: `field:v1,v2` (values OR'd); `values` are raw value syntax (">=400", "\"a b\"", "/re/"). */
export interface Chip {
    field: string;
    negate: boolean;
    values: string[];
}
export interface BasicFilter {
    /** free text: bare words (URL contains; "-word" excludes) */
    text: string;
    chips: Chip[];
}

export function chipToString(c: Chip): string {
    return `${c.negate ? "-" : ""}${c.field}:${c.values.join(",")}`;
}

export function fromBasic(b: BasicFilter): string {
    return [b.text.trim(), ...b.chips.map(chipToString)].filter(Boolean).join(" ");
}

export function nodeToString(n: QNode): string {
    switch (n.k) {
        case "term":
            return n.raw;
        case "not":
            return n.item.k === "term" ? "-" + n.item.raw : `-(${nodeToString(n.item)})`;
        case "and":
            return n.items.map((i) => (i.k === "or" ? `(${nodeToString(i)})` : nodeToString(i))).join(" ");
        case "or":
            return n.items.map((i) => (i.k === "and" ? `(${nodeToString(i)})` : nodeToString(i))).join(" OR ");
    }
}

/** The query as Basic text + chips, or null when it needs Advanced (OR across fields, groups, NOT of groups…). */
export function toBasic(ast: QNode | null): BasicFilter | null {
    const items = !ast ? [] : ast.k === "and" ? ast.items : [ast];
    const text: string[] = [];
    const chips: Chip[] = [];
    for (const n of items) {
        const neg = n.k === "not";
        const inner = n.k === "not" ? n.item : n;
        if (inner.k === "term") {
            if (inner.field === null) text.push((neg ? "-" : "") + inner.raw);
            else chips.push({ field: inner.field, negate: neg, values: inner.values.map((v) => v.raw) });
            continue;
        }
        const field = inner.k === "or" && inner.items[0].k === "term" ? inner.items[0].field : null;
        if (inner.k !== "or" || field === null || !inner.items.every((i) => i.k === "term" && i.field === field)) return null;
        chips.push({ field, negate: neg, values: inner.items.flatMap((i) => (i as TermNode).values.map((v) => v.raw)) });
    }
    return { text: text.join(" "), chips };
}

/** Quote a suggested/typed text value when it would not survive as a plain word (operator values like ">=400" pass through). */
export function quoteValue(s: string, field = "url"): string {
    const kind = FIELD_MAP.get(field)?.kind;
    if (kind === "status" || kind === "number" || kind === "is") return s;
    return s && !/[\s(),"\\]/.test(s) && !/^[=/]/.test(s) ? s : `"${s.replace(/["\\]/g, "\\$&")}"`;
}

// ── autocomplete ─────────────────────────────────────────────────────

export interface SuggestData {
    methods: string[];
    statuses: string[];
    hosts: string[];
    mimes: string[];
    scripts: string[];
    tabs: string[];
    reqHeaders: string[];
    resHeaders: string[];
}

const COMMON_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

export function suggestData(entries: NetEntry[], tabTitle: (id: number) => string | undefined): SuggestData {
    const sets = { methods: new Set(COMMON_METHODS), statuses: new Set<string>(), hosts: new Set<string>(), mimes: new Set<string>(), scripts: new Set<string>(), tabs: new Set<string>(), reqHeaders: new Set<string>(), resHeaders: new Set<string>() };
    for (const e of entries) {
        sets.methods.add(e.method);
        if (e.status !== null) sets.statuses.add(String(e.status));
        const host = urlPart(e.url, "host");
        if (host) sets.hosts.add(host);
        if (e.mime) sets.mimes.add(e.mime);
        for (const o of e.outcomes) sets.scripts.add(o.scriptName);
        const t = tabTitle(e.tabId);
        if (t) sets.tabs.add(t);
        for (const [n] of e.requestHeaders ?? []) sets.reqHeaders.add(n.toLowerCase());
        for (const [n] of e.responseHeaders ?? []) sets.resHeaders.add(n.toLowerCase());
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return {
        methods: [...sets.methods],
        statuses: sorted(sets.statuses),
        hosts: sorted(sets.hosts),
        mimes: sorted(sets.mimes),
        scripts: sorted(sets.scripts),
        tabs: sorted(sets.tabs),
        reqHeaders: sorted(sets.reqHeaders),
        resHeaders: sorted(sets.resHeaders),
    };
}

export interface Suggestion {
    label: string;
    /** replaces text[from, to) */
    insert: string;
    detail?: string;
}
export interface Completion {
    from: number;
    to: number;
    items: Suggestion[];
}

/** Value suggestions for one field (also used by the Basic "+ Filter" picker). */
export function fieldValues(field: string, data: SuggestData): { value: string; detail?: string }[] {
    const plain = (xs: string[]) => xs.map((value) => ({ value }));
    switch (field) {
        case "method":
            return plain(data.methods);
        case "status":
            return [...plain(data.statuses), ...["2xx", "3xx", "4xx", "5xx", ">=400"].map((value) => ({ value, detail: "range" }))];
        case "type":
            return ALL_TYPES.map((value) => ({ value, detail: TYPE_FILTERS.find((t) => t.id === value)!.label }));
        case "is":
            return IS_VALUES.map((x) => ({ value: x.name, detail: x.help }));
        case "host":
            return plain(data.hosts);
        case "mime":
            return plain(data.mimes);
        case "script":
            return plain(data.scripts);
        case "tab":
            return plain(data.tabs);
        case "req-header":
            return plain(data.reqHeaders);
        case "res-header":
            return plain(data.resHeaders);
        case "size":
            return [">10kb", ">1mb", "<1kb"].map((value) => ({ value }));
        case "time":
            return [">500ms", ">1s", "<100ms"].map((value) => ({ value }));
        default:
            return [];
    }
}

function rank<T>(items: T[], key: (t: T) => string, prefix: string): T[] {
    const p = prefix.toLowerCase();
    if (!p) return items;
    const starts = items.filter((i) => key(i).toLowerCase().startsWith(p));
    const has = items.filter((i) => !key(i).toLowerCase().startsWith(p) && key(i).toLowerCase().includes(p));
    return [...starts, ...has];
}

/** Suggestions for the word at `cursor`: field names, then values after `field:`. */
export function complete(src: string, cursor: number, data: SuggestData): Completion | null {
    if ((src.slice(0, cursor).match(/"/g)?.length ?? 0) % 2) return null; // inside a quoted value
    let from = cursor;
    while (from > 0 && !isSpace(src[from - 1]) && src[from - 1] !== "(") from--;
    let to = cursor;
    while (to < src.length && !isSpace(src[to]) && src[to] !== ")") to++;
    let word = src.slice(from, cursor);
    if (word.startsWith("-")) {
        from++;
        word = word.slice(1);
    }
    const colon = word.indexOf(":");
    if (colon < 0) {
        const items = rank(FIELDS, (f) => f.name, word).map((f) => ({ label: f.name + ":", insert: f.name + ":", detail: f.help }));
        return items.length ? { from, to, items } : null;
    }
    const field = word.slice(0, colon).toLowerCase();
    if (!FIELD_MAP.has(field)) return null;
    const valueStart = from + colon + 1 + word.slice(colon + 1).lastIndexOf(",") + 1;
    const prefix = src.slice(valueStart, cursor);
    if (FIELD_MAP.get(field)!.kind === "header" && prefix.includes("=")) return null;
    let valueEnd = cursor;
    while (valueEnd < to && src[valueEnd] !== ",") valueEnd++;
    const items = rank(fieldValues(field, data), (x) => x.value, prefix)
        .filter((x) => x.value !== prefix)
        .slice(0, 50)
        .map((x) => ({ label: x.value, insert: quoteValue(x.value, field), detail: x.detail }));
    return items.length ? { from: valueStart, to: valueEnd, items } : null;
}
