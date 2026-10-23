/**
 * The `rules` strategy's translation layer (pure, unit-tested against
 * URLPattern itself):
 *
 *   patternToRegex — a route's URLPattern string → one anchored RE2-safe
 *                    regex over the full URL (declarativeNetRequest
 *                    `regexFilter`), following URLPattern's semantics:
 *                    optionals, named groups, custom regexps, modifiers
 *   rulesForProbe  — a handler's one-time ("probe") result → rule specs,
 *                    or why it can't be a rule
 *
 * The URLPattern tokenizer/parser below follows
 * https://urlpattern.spec.whatwg.org (constructor string parser, pattern
 * parser, "generate a regular expression and name list"); the generated
 * per-component regexps are fenced in by the URL delimiters around them
 * so they can be joined into one full-URL regex.
 */
import { RESOURCE_TYPES, routeLabel, type NetKind, type RouteMeta } from "./route";

// ---- placeholders the probe hands to a rules handler ----

/** what ctx.groups[name] returns in the probe run (private-use + mixed case: survives only if used as-is) */
export function captureToken(name: string): string {
    return `\uE000Wt${name}x\uE001`;
}
/** what ctx.url returns in the probe run (U+E002 can't occur in a group name) */
export const URL_TOKEN = "\uE000Wt\uE002x\uE001";
const ANY_TOKEN = /\uE000Wt(?:\uE002|[^\uE000\uE001]*?)x\uE001/g;
const HAS_TOKEN = new RegExp(ANY_TOKEN.source);

// ---- URLPattern tokenizer ----

type TokType = "open" | "close" | "regexp" | "name" | "char" | "escaped-char" | "other-modifier" | "asterisk" | "end" | "invalid-char";
interface Tok {
    type: TokType;
    index: number;
    value: string;
}

const ID_START = /[$_\p{ID_Start}]/u;
const ID_PART = /[$_\u200C\u200D\p{ID_Continue}]/u;

function tokenize(cp: string[], strict: boolean): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    const bad = (msg: string): void => {
        if (strict) throw new TypeError(msg);
        out.push({ type: "invalid-char", index: i, value: cp[i] });
        i++;
    };
    while (i < cp.length) {
        const c = cp[i];
        if (c === "*") out.push({ type: "asterisk", index: i++, value: c });
        else if (c === "+" || c === "?") out.push({ type: "other-modifier", index: i++, value: c });
        else if (c === "\\") {
            if (i === cp.length - 1) {
                bad("trailing backslash");
                continue;
            }
            out.push({ type: "escaped-char", index: i, value: cp[i + 1] });
            i += 2;
        } else if (c === "{") out.push({ type: "open", index: i++, value: c });
        else if (c === "}") out.push({ type: "close", index: i++, value: c });
        else if (c === ":") {
            let p = i + 1;
            while (p < cp.length && (p === i + 1 ? ID_START : ID_PART).test(cp[p])) p++;
            if (p === i + 1) {
                bad("missing group name");
                continue;
            }
            out.push({ type: "name", index: i, value: cp.slice(i + 1, p).join("") });
            i = p;
        } else if (c === "(") {
            let depth = 1;
            let p = i + 1;
            const start = p;
            let error = false;
            while (p < cp.length) {
                const ch = cp[p];
                if (!/^[\x00-\x7f]$/.test(ch) || (p === start && ch === "?")) {
                    error = true;
                    break;
                }
                if (ch === "\\") {
                    if (p === cp.length - 1 || !/^[\x00-\x7f]$/.test(cp[p + 1])) {
                        error = true;
                        break;
                    }
                    p += 2;
                    continue;
                }
                if (ch === ")") {
                    depth--;
                    if (depth === 0) {
                        p++;
                        break;
                    }
                } else if (ch === "(") {
                    depth++;
                    if (p === cp.length - 1 || cp[p + 1] !== "?") {
                        error = true;
                        break;
                    }
                }
                p++;
            }
            if (error || depth !== 0 || p - start - 1 === 0) {
                bad("invalid regexp group");
                continue;
            }
            out.push({ type: "regexp", index: i, value: cp.slice(start, p - 1).join("") });
            i = p;
        } else out.push({ type: "char", index: i++, value: c });
    }
    out.push({ type: "end", index: cp.length, value: "" });
    return out;
}

// ---- pattern parser (one component) ----

type Modifier = "" | "?" | "*" | "+";
interface Part {
    type: "fixed" | "regexp" | "segment" | "full";
    value: string;
    modifier: Modifier;
    name: string;
    prefix: string;
    suffix: string;
}

interface CompOptions {
    delimiter: string;
    prefix: string;
}

const REGEX_SPECIAL = /[.+*?^${}()[\]|/\\]/g;
const escapeRegex = (s: string): string => s.replace(REGEX_SPECIAL, "\\$&");
const escapeClass = (s: string): string => s.replace(/[\\\]^\-[]/g, "\\$&");

function parsePattern(input: string, opts: CompOptions, encode: (s: string) => string): Part[] {
    const toks = tokenize([...input], true);
    const parts: Part[] = [];
    const segment = `[^${escapeRegex(opts.delimiter)}]+?`;
    let pending = "";
    let i = 0;
    let numeric = 0;
    const take = (type: TokType): Tok | null => (toks[i].type === type ? toks[i++] : null);
    const takeModifier = (): Tok | null => take("other-modifier") ?? take("asterisk");
    const takeRegexOrWildcard = (name: Tok | null): Tok | null => {
        const t = take("regexp");
        return t || name ? t : take("asterisk");
    };
    const text = (): string => {
        let s = "";
        for (;;) {
            const t = take("char") ?? take("escaped-char");
            if (!t) return s;
            s += t.value;
        }
    };
    const flush = (): void => {
        if (!pending) return;
        parts.push({ type: "fixed", value: encode(pending), modifier: "", name: "", prefix: "", suffix: "" });
        pending = "";
    };
    const add = (prefix: string, name: Tok | null, re: Tok | null, suffix: string, mod: Tok | null): void => {
        const modifier = (mod?.value ?? "") as Modifier;
        if (!name && !re && !modifier) {
            pending += prefix;
            return;
        }
        flush();
        if (!name && !re) {
            if (prefix) parts.push({ type: "fixed", value: encode(prefix), modifier, name: "", prefix: "", suffix: "" });
            return;
        }
        let value = !re ? segment : re.type === "asterisk" ? ".*" : re.value;
        let type: Part["type"] = "regexp";
        if (value === segment) {
            type = "segment";
            value = "";
        } else if (value === ".*") {
            type = "full";
            value = "";
        }
        const n = name ? name.value : String(numeric++);
        if (parts.some((p) => p.name === n)) throw new TypeError(`duplicate group name "${n}"`);
        parts.push({ type, value, modifier, name: n, prefix: encode(prefix), suffix: encode(suffix) });
    };
    while (i < toks.length) {
        const ch = take("char");
        const name = take("name");
        const re = takeRegexOrWildcard(name);
        if (name || re) {
            let prefix = ch?.value ?? "";
            if (prefix && prefix !== opts.prefix) {
                pending += prefix;
                prefix = "";
            }
            flush();
            add(prefix, name, re, "", takeModifier());
            continue;
        }
        const fixed = ch ?? take("escaped-char");
        if (fixed) {
            pending += fixed.value;
            continue;
        }
        if (take("open")) {
            const prefix = text();
            const n = take("name");
            const r = takeRegexOrWildcard(n);
            const suffix = text();
            if (!take("close")) throw new TypeError("expected }");
            add(prefix, n, r, suffix, takeModifier());
            continue;
        }
        flush();
        if (!take("end")) throw new TypeError(`unexpected "${toks[i].value}"`);
    }
    return parts;
}

// ---- constructor string parser ----

export const COMPONENTS = ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"] as const;
type Comp = (typeof COMPONENTS)[number];
type State = Comp | "init" | "authority" | "done";

const SPECIAL_SCHEMES = ["ftp", "file", "http", "https", "ws", "wss"];
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };

function protocolIsSpecial(protocol: string): boolean {
    try {
        const re = new RegExp(`^(?:${partsToRegex(parsePattern(protocol, NO_OPTIONS, (s) => s.toLowerCase()), NO_OPTIONS, "", () => false, { n: 0 }, {})})$`);
        return SPECIAL_SCHEMES.some((s) => re.test(s));
    } catch {
        return false;
    }
}

function parseConstructorString(input: string): Partial<Record<Comp, string>> {
    const cp = [...input];
    const toks = tokenize(cp, false);
    const result: Partial<Record<Comp, string>> = {};
    let state: State = "init";
    let start = 0;
    let idx = 0;
    let inc = 1;
    let depth = 0;
    let v6 = 0;
    let special = false;
    const safe = (i: number): Tok => toks[Math.min(i, toks.length - 1)];
    const isChar = (i: number, v: string): boolean => {
        const t = safe(i);
        return t.value === v && (t.type === "char" || t.type === "escaped-char" || t.type === "invalid-char");
    };
    const isSearchPrefix = (i: number): boolean => {
        if (isChar(i, "?")) return true;
        if (toks[i].value !== "?") return false;
        if (i - 1 < 0) return true;
        return !["name", "regexp", "close", "asterisk"].includes(safe(i - 1).type);
    };
    const componentString = (): string => cp.slice(safe(start).index, toks[idx].index).join("");
    const change = (next: State, skip: number): void => {
        if (state !== "init" && state !== "authority" && state !== "done") result[state] = componentString();
        if (state !== "init" && next !== "done") {
            const before = (list: State[]) => list.includes(state);
            if (before(["protocol", "authority", "username", "password"]) && ["port", "pathname", "search", "hash"].includes(next) && result.hostname === undefined) result.hostname = "";
            if (before(["protocol", "authority", "username", "password", "hostname", "port"]) && (next === "search" || next === "hash") && result.pathname === undefined) result.pathname = special ? "/" : "";
            if (before(["protocol", "authority", "username", "password", "hostname", "port", "pathname"]) && next === "hash" && result.search === undefined) result.search = "";
        }
        state = next;
        idx += skip;
        start = idx;
        inc = 0;
    };
    const rewind = (): void => {
        idx = start;
        inc = 0;
    };
    const rewindTo = (s: State): void => {
        rewind();
        state = s;
    };
    while (idx < toks.length) {
        inc = 1;
        if (toks[idx].type === "end") {
            if (state === "init") {
                rewind();
                if (isChar(idx, "#")) change("hash", 1);
                else if (isSearchPrefix(idx)) change("search", 1);
                else change("pathname", 0);
                idx += inc;
                continue;
            }
            if (state === "authority") {
                rewindTo("hostname");
                idx += inc;
                continue;
            }
            change("done", 0);
            break;
        }
        if (depth > 0) {
            if (toks[idx].type === "close") depth--;
            else {
                idx += inc;
                continue;
            }
        }
        if (toks[idx].type === "open") {
            depth++;
            idx += inc;
            continue;
        }
        switch (state as State) {
            case "init":
                if (isChar(idx, ":")) rewindTo("protocol");
                break;
            case "protocol":
                if (isChar(idx, ":")) {
                    special = protocolIsSpecial(componentString());
                    if (isChar(idx + 1, "/") && isChar(idx + 2, "/")) change("authority", 3);
                    else if (special) change("authority", 1);
                    else change("pathname", 1);
                }
                break;
            case "authority":
                if (isChar(idx, "@")) rewindTo("username");
                else if (isChar(idx, "/") || isSearchPrefix(idx) || isChar(idx, "#")) rewindTo("hostname");
                break;
            case "username":
                if (isChar(idx, ":")) change("password", 1);
                else if (isChar(idx, "@")) change("hostname", 1);
                break;
            case "password":
                if (isChar(idx, "@")) change("hostname", 1);
                break;
            case "hostname":
                if (isChar(idx, "[")) v6++;
                else if (isChar(idx, "]")) v6--;
                else if (isChar(idx, ":") && v6 === 0) change("port", 1);
                else if (isChar(idx, "/")) change("pathname", 0);
                else if (isSearchPrefix(idx)) change("search", 1);
                else if (isChar(idx, "#")) change("hash", 1);
                break;
            case "port":
                if (isChar(idx, "/")) change("pathname", 0);
                else if (isSearchPrefix(idx)) change("search", 1);
                else if (isChar(idx, "#")) change("hash", 1);
                break;
            case "pathname":
                if (isSearchPrefix(idx)) change("search", 1);
                else if (isChar(idx, "#")) change("hash", 1);
                break;
            case "search":
                if (isChar(idx, "#")) change("hash", 1);
                break;
        }
        idx += inc;
    }
    if (result.hostname !== undefined && result.port === undefined) result.port = "";
    if (result.protocol === undefined) throw new TypeError("not a full URL pattern (no protocol)");
    return result;
}

// ---- per-component canonicalization of fixed text (the spec's encoding callbacks) ----

function viaUrl(fn: () => string, fallback: string): string {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

function encoderFor(c: Comp, special: boolean): (s: string) => string {
    switch (c) {
        case "protocol":
            return (s) => s.toLowerCase();
        case "username":
            return (s) => viaUrl(() => Object.assign(new URL("http://d.test"), { username: s }).username, s);
        case "password":
            return (s) => viaUrl(() => Object.assign(new URL("http://d.test"), { password: s }).password, s);
        case "hostname":
            return (s) => (/^[\x00-\x7f]*$/.test(s) ? s.toLowerCase() : viaUrl(() => new URL(`http://${s}`).hostname, s.toLowerCase()));
        case "port":
            return (s) => s;
        case "pathname":
            if (!special) return (s) => s.replace(/[\s"<>`#?{}]/g, (ch) => encodeURIComponent(ch));
            return (s) => {
                if (!s) return s;
                const lead = s.startsWith("/");
                const out = viaUrl(() => new URL("http://d.test" + (lead ? s : "/-" + s).replace(/[?#]/g, encodeURIComponent)).pathname, s);
                return lead ? out : out.slice(2);
            };
        case "search":
            return (s) => (s ? viaUrl(() => new URL("http://d.test/?" + s.replace(/#/g, "%23")).search.slice(1), s) : s);
        case "hash":
            return (s) => (s ? viaUrl(() => new URL("http://d.test/#" + s).hash.slice(1), s) : s);
    }
}

const NO_OPTIONS: CompOptions = { delimiter: "", prefix: "" };

function optionsFor(c: Comp, special: boolean): CompOptions {
    if (c === "hostname") return { delimiter: ".", prefix: "" };
    if (c === "pathname" && special) return { delimiter: "/", prefix: "/" };
    return NO_OPTIONS;
}

/**
 * characters that end each component in a request URL: a component's regex
 * may not cross them. Request URLs have no fragment, so "#" never needs
 * excluding (each excluded character costs RE2 memory).
 */
const TERMINATORS: Record<Comp, string> = {
    protocol: ":/?",
    username: ":@/?",
    password: "@/?",
    hostname: ":/?@",
    port: "/?",
    pathname: "?",
    search: "",
    hash: "",
};

// ---- regex generation ----

/** a user's custom group regexp, fenced in by the component's terminators */
function fenceUserRegex(v: string, term: string): string {
    if (!term) return v;
    const t = escapeClass(term);
    const classOf: Record<string, string> = { D: "0-9", W: "A-Za-z0-9_", S: "\\s" };
    let out = "";
    let inClass = false;
    for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (ch === "\\") {
            const next = v[i + 1] ?? "";
            if (!inClass && classOf[next]) out += `[^${classOf[next]}${t}]`;
            else out += ch + next;
            i++;
            continue;
        }
        if (inClass) {
            if (ch === "]") inClass = false;
            out += ch;
            continue;
        }
        if (ch === "[") {
            inClass = true;
            if (v[i + 1] === "^") {
                out += `[^${t}`;
                i++;
            } else out += ch;
            continue;
        }
        out += ch === "." ? `[^${t}]` : ch;
    }
    return out;
}

function partsToRegex(parts: Part[], opts: CompOptions, term: string, capture: (name: string) => boolean, counter: { n: number }, index: Record<string, number>, leadingSlash = false): string {
    const fence = escapeClass(opts.delimiter + term);
    const segment = fence ? `[^${fence}]+?` : ".+?";
    const full = term ? `[^${escapeClass(term)}]*` : ".*";
    let out = "";
    for (const p of parts) {
        if (p.type === "fixed") {
            out += p.modifier ? `(?:${escapeRegex(p.value)})${p.modifier}` : escapeRegex(p.value);
            continue;
        }
        // a special URL's path starts with "/": a leading bare "*" must not reach back over ":port"
        const lead = leadingSlash && p === parts[0] && p.type === "full" && !p.prefix && !p.modifier;
        const value = lead ? `/${full}` : p.type === "segment" ? segment : p.type === "full" ? full : fenceUserRegex(p.value, term);
        const open = capture(p.name) ? "(" : "(?:";
        if (open === "(") index[p.name] = ++counter.n;
        const many = p.modifier === "*" || p.modifier === "+";
        if (!p.prefix && !p.suffix) {
            out += many ? `${open}(?:${value})${p.modifier})` : `${open}${value})${p.modifier}`;
            continue;
        }
        const pre = escapeRegex(p.prefix);
        const suf = escapeRegex(p.suffix);
        if (!many) {
            out += `(?:${pre}${open}${value})${suf})${p.modifier}`;
            continue;
        }
        out += `(?:${pre}${open}(?:${value})(?:${suf}${pre}(?:${value}))*)${suf})`;
        if (p.modifier === "*") out += "?";
    }
    return out;
}

/** "<all_urls>" and "*" match every URL (as in matcher.ts) */
const ALL_URLS = new Set(["<all_urls>", "*"]);

interface ParsedPattern {
    comps: Record<Comp, string>;
    parts: Record<Comp, Part[]>;
    options: Record<Comp, CompOptions>;
    /** group name → the component whose value ctx.groups[name] carries (the last one defining it) */
    owner: Map<string, Comp>;
    special: boolean;
}

function parse(pattern: string): ParsedPattern {
    const given: Partial<Record<Comp, string>> = ALL_URLS.has(pattern) ? {} : parseConstructorString(pattern);
    const comps = Object.fromEntries(COMPONENTS.map((c) => [c, given[c] ?? "*"])) as Record<Comp, string>;
    comps.protocol = comps.protocol.toLowerCase();
    if (DEFAULT_PORTS[comps.protocol] === comps.port) comps.port = "";
    const special = protocolIsSpecial(comps.protocol);
    const parts = {} as Record<Comp, Part[]>;
    const options = {} as Record<Comp, CompOptions>;
    const owner = new Map<string, Comp>();
    for (const c of COMPONENTS) {
        options[c] = optionsFor(c, special);
        parts[c] = parsePattern(comps[c], options[c], encoderFor(c, special));
        for (const p of parts[c]) if (p.type !== "fixed") owner.set(p.name, c);
    }
    return { comps, parts, options, owner, special };
}

export interface PatternGroup {
    name: string;
    /** may be missing (undefined in ctx.groups): a `?` / `*` group */
    optional: boolean;
}

/** the ctx.groups names a pattern yields (last-component-wins, as matchGroups merges them) */
export function patternGroups(pattern: string): PatternGroup[] {
    const p = parse(pattern);
    return [...p.owner].map(([name, c]) => {
        const part = p.parts[c].find((x) => x.name === name)!;
        return { name, optional: part.modifier === "?" || part.modifier === "*" };
    });
}

export interface PatternRegex {
    /** anchored, case-sensitive; RE2 syntax except inside custom group regexps */
    regex: string;
    /** capture name → its group number in `regex` (only the requested ones capture) */
    index: Record<string, number>;
}

/**
 * A URLPattern string (constructor syntax, or an all-URLs alias) → one
 * regex over a request URL (which never has a fragment) that matches
 * exactly what URLPattern.test does.
 * `capture` lists the ctx.groups names that should be numbered groups;
 * everything else is non-capturing. Throws on an invalid pattern.
 */
export function patternToRegex(pattern: string, capture: string[] = []): PatternRegex {
    const p = parse(pattern);
    const counter = { n: 0 };
    const index: Record<string, number> = {};
    const body = (c: Comp): string => partsToRegex(p.parts[c], p.options[c], TERMINATORS[c], (name) => capture.includes(name) && p.owner.get(name) === c, counter, index, c === "pathname" && p.special);
    const emptyOk = (c: Comp): boolean => {
        try {
            return new RegExp(`^(?:${partsToRegex(p.parts[c], p.options[c], TERMINATORS[c], () => false, { n: 0 }, {})})$`).test("");
        } catch {
            return false;
        }
    };
    // RE2's memory limit (2KB in Chrome) is spent mostly on character
    // classes, so parts that can't change the outcome are left out or merged
    const captured = (c: Comp): boolean => capture.some((n) => p.owner.get(n) === c);
    const wild = (c: Comp): boolean => p.comps[c] === "*" && !captured(c);
    let re = `^${body("protocol")}://`;
    if (wild("username") && wild("password")) re += "(?:[^@/?]*@)?"; // user(:pass)?@ in one class
    else if (p.comps.username !== "" || p.comps.password !== "") {
        const userOpt = emptyOk("username");
        const passOpt = emptyOk("password");
        const user = body("username");
        const pass = body("password");
        const info = `${user}${passOpt ? `(?::${pass})?` : `:${pass}`}@`;
        re += userOpt && passOpt ? `(?:${info})?` : info;
    }
    re += body("hostname");
    if (p.comps.port !== "") re += emptyOk("port") ? `(?::${body("port")})?` : `:${body("port")}`;
    re += body("pathname");
    // request URLs never carry a fragment: a hash that may be empty always matches
    const noHash = !captured("hash") && (p.comps.hash === "" || emptyOk("hash"));
    if (noHash && wild("search")) return { regex: `${re}(?:\\?|$)`, index };
    if (p.comps.search === "") re += "\\??";
    else re += emptyOk("search") ? `(?:\\?${body("search")})?` : `\\?${body("search")}`;
    if (!noHash) re += p.comps.hash === "" ? "#?" : emptyOk("hash") ? `(?:#${body("hash")})?` : `#${body("hash")}`;
    return { regex: re + "$", index };
}

// ---- probe result → rule specs ----

/** a rules handler's one-time run, as reported by the probe (serializable) */
export interface RuleProbe {
    kind: NetKind;
    route: RouteMeta;
    /** threw / timed out / can't run on rules at all */
    error?: string;
    /** ctx properties read besides groups and url */
    forbidden?: string[];
    /** ctx.groups names read */
    captures: string[];
    urlRead: boolean;
    /** optional captures whose fallback differs from "" (what a rule substitutes for a missing one) */
    optionalMismatch?: string[];
    result?: ProbeResult | null;
}

export interface ProbeResult {
    replaceResponse?: boolean;
    redirect?: string;
    block?: boolean;
    headers?: { set?: Record<string, string>; remove?: string[] };
}

export interface RuleSpec {
    /** block / redirect (first script wins) vs modifyHeaders (later handlers win) */
    final: boolean;
    /** the url pattern this rule came from */
    pattern: string;
    action: any;
    condition: any;
    /** network-view line: "block", "redirect → …", "request headers (set x)" */
    summary: string;
}

/** declarativeNetRequest's request methods */
const DNR_METHODS = ["connect", "delete", "get", "head", "options", "patch", "post", "put", "other"];

export const AS_IS = "on `rules`, captures can only be inserted into the redirect URL as-is";

function hasHeaderMods(h: ProbeResult["headers"]): boolean {
    return !!h && ((!!h.set && Object.keys(h.set).length > 0) || (!!h.remove && h.remove.length > 0));
}

function headerOps(h: NonNullable<ProbeResult["headers"]>): any[] {
    return [
        ...Object.entries(h.set || {}).map(([header, value]) => ({ header, operation: "set", value })),
        ...(h.remove || []).map((header) => ({ header, operation: "remove" })),
    ];
}

function headerSummary(kind: NetKind, h: NonNullable<ProbeResult["headers"]>): string {
    if (kind === "onResponseHeaders") return `${Object.keys(h.set || {}).length} set, ${(h.remove || []).length} removed`;
    const parts: string[] = [];
    if (h.set && Object.keys(h.set).length) parts.push(`set ${Object.keys(h.set).join(", ")}`);
    if (h.remove && h.remove.length) parts.push(`remove ${h.remove.join(", ")}`);
    return `request headers (${parts.join("; ")})`;
}

/**
 * A probed rules handler → its rule specs (one per url pattern), or why it
 * can't be a rule. The reason is shown as "onRequest #2: <reason>".
 */
export function rulesForProbe(o: RuleProbe): { rules: RuleSpec[] } | { error: string } {
    const fail = (error: string) => ({ error });
    if (o.error) return fail(o.error);
    if (o.kind === "onResponseBody" || o.kind === "replaceResponse") return fail(`${o.kind} is not supported on rules — use another strategy for this handler`);
    if (o.forbidden?.length) return fail(`rules are fixed: the handler must return the same result for every request (it reads ${o.forbidden.map((f) => `ctx.${f}`).join(", ")})`);
    const route = o.route;
    if (route.exclude.length) return fail("`exclude` is not supported on rules — narrow the url pattern instead");
    const r = o.result || {};
    if (o.kind === "onRequest" && r.replaceResponse) return fail("a `replaceResponse` result is not supported on rules — use another strategy for this handler");
    const redirect = o.kind === "onRequest" && r.redirect ? r.redirect : undefined;
    const block = o.kind === "onRequest" && !redirect && !!r.block;
    // a final action drops header edits (as at runtime)
    const headers = redirect || block ? undefined : r.headers;
    if (!redirect && !block && !hasHeaderMods(headers)) return fail("does nothing on `rules` (rules can't just observe requests)");
    if (headers && HAS_TOKEN.test(JSON.stringify(headers))) return fail(AS_IS);
    const used = new Set(redirect ? [...redirect.matchAll(ANY_TOKEN)].map((m) => m[0]) : []);
    const lost = o.captures.filter((n) => !used.has(captureToken(n)));
    if (lost.length || (o.urlRead && !used.has(URL_TOKEN))) return fail(`${AS_IS} (${[...lost.map((n) => `ctx.groups.${n}`), ...(o.urlRead && !used.has(URL_TOKEN) ? ["ctx.url"] : [])].join(", ")} used otherwise)`);
    for (const t of used) if (t !== URL_TOKEN && !o.captures.some((n) => captureToken(n) === t)) return fail(AS_IS);
    if (o.optionalMismatch?.length) {
        const n = o.optionalMismatch[0];
        return fail(`ctx.groups.${n} can be missing, and a rule puts "" there — write \`ctx.groups.${n} ?? ""\` (a rule can't fall back to another value)`);
    }
    const captured = o.captures.filter((n) => used.has(captureToken(n)));
    // the redirect, with placeholders swapped for sample text, must be a URL
    if (redirect) {
        const sample = redirect.replace(ANY_TOKEN, (t) => (t === URL_TOKEN ? "https://example.com/" : "x"));
        try {
            new URL(sample);
        } catch {
            return fail(`redirect "${redirect.replace(ANY_TOKEN, (t) => (t === URL_TOKEN ? "${ctx.url}" : "${…}"))}" is not an absolute URL`);
        }
    }
    let requestMethods: string[] | undefined;
    if (route.methods) {
        requestMethods = route.methods.map((m) => m.toLowerCase());
        const bad = requestMethods.find((m) => !DNR_METHODS.includes(m));
        if (bad) return fail(`method "${bad.toUpperCase()}" can't be matched by a rule — one of ${DNR_METHODS.map((m) => m.toUpperCase()).join(", ")}`);
    }
    const rules: RuleSpec[] = [];
    for (const pattern of route.url) {
        let pr: PatternRegex;
        try {
            pr = patternToRegex(pattern, captured);
        } catch (e: any) {
            return fail(`url pattern "${pattern}" can't be a rule: ${e?.message || e}`);
        }
        const missing = captured.find((n) => pr.index[n] === undefined);
        if (missing) return fail(`ctx.groups.${missing} isn't a group of url pattern "${pattern}"`);
        if (captured.length > 9) return fail(`a redirect can insert at most 9 captures (it uses ${captured.length})`);
        const condition: any = {
            regexFilter: pr.regex,
            isUrlFilterCaseSensitive: true,
            resourceTypes: [...(route.resourceTypes ?? RESOURCE_TYPES)],
        };
        if (requestMethods) condition.requestMethods = requestMethods;
        let action: any;
        let summary: string;
        if (redirect) {
            summary = "redirect";
            if (!used.size) action = { type: "redirect", redirect: { url: redirect } };
            else {
                const sub = redirect.replace(/\\/g, "\\\\").replace(ANY_TOKEN, (t) => (t === URL_TOKEN ? "\\0" : `\\${pr.index[o.captures.find((n) => captureToken(n) === t)!]}`));
                action = { type: "redirect", redirect: { regexSubstitution: sub } };
            }
        } else if (block) {
            summary = "block";
            action = { type: "block" };
        } else {
            summary = headerSummary(o.kind, headers!);
            action = { type: "modifyHeaders", [o.kind === "onResponseHeaders" ? "responseHeaders" : "requestHeaders"]: headerOps(headers!) };
        }
        rules.push({ final: !!(redirect || block), pattern, action, condition, summary });
    }
    return { rules };
}

/** where a regexSubstitution redirect sends `url` (network view) */
export function substitute(regex: string, substitution: string, url: string): string | null {
    let re: RegExp;
    try {
        re = new RegExp(regex);
    } catch {
        return null;
    }
    const m = re.exec(url);
    if (!m) return null;
    return substitution.replace(/\\(\\|\d)/g, (_, d) => (d === "\\" ? "\\" : m[Number(d)] ?? ""));
}

/** "onRequest #2: reason" */
export function ruleErrorLine(route: RouteMeta, reason: string): string {
    return `${routeLabel(route)}: ${reason}`;
}

/** what drives a regex's compiled size: character classes (incl. `.`) and groups */
export function regexCost(regex: string): { classes: number; groups: number; captures: number } {
    let classes = 0, groups = 0, captures = 0, inClass = false;
    for (let i = 0; i < regex.length; i++) {
        const c = regex[i];
        if (c === "\\") { i++; continue; }
        if (inClass) { if (c === "]") inClass = false; continue; }
        if (c === "[") { inClass = true; classes++; }
        else if (c === ".") classes++;
        else if (c === "(") { groups++; if (regex[i + 1] !== "?") captures++; }
    }
    return { classes, groups, captures };
}
