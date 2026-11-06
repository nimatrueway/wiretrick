/**
 * `ctx.evaluate(fn)` sends `fn` to the page world as source, without its
 * closure. What it uses from its module comes along: per `ctx.evaluate`
 * function in a module's runnable JS, the module's top-level declarations
 * it uses — functions, variables, classes and imports (`var _x =
 * require(…)`), with what they use in turn — as a prelude the page runs
 * before `fn` (shared/pageEval.ts). The handler's own locals can't come
 * along (their values live here): `evaluateProblems` flags them.
 *
 * Background only: it parses with acorn.
 */
import { parse } from "acorn";
import { toRunnableJs } from "./compile";

/** what a `ctx.evaluate` function needs from its module */
export interface EvalCapture {
    /** the function's source, as `String(fn)` gives it */
    fn: string;
    /** the module's top-level declarations it uses (also through each other), in source order */
    prelude: string;
    /** the prelude imports: the page needs the module's libraries */
    libs?: true;
}

type Node = any;

interface Scope {
    names: Set<string>;
    /** functions declared here by name (`function f`, `const f = () => …`) */
    fns: Map<string, Node>;
    parent: Scope | null;
    /** the module's top level */
    top?: true;
}

interface Visitor {
    ref?(name: string, scope: Scope): void;
    call?(node: Node, scope: Scope): void;
}

const EVALUATE = /\bevaluate\b/;
const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const isFn = (n: Node) => !!n && FN_TYPES.has(n.type);
const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw", "regex", "bigint"]);

function scope(parent: Scope | null, names: Iterable<string> = [], fns = new Map<string, Node>()): Scope {
    return { names: new Set(names), fns, parent };
}

function resolve(name: string, s: Scope | null): Scope | null {
    for (; s; s = s.parent) if (s.names.has(name)) return s;
    return null;
}

/** the names a binding pattern declares */
function patternNames(p: Node, out: string[] = []): string[] {
    if (!p) return out;
    if (p.type === "Identifier") out.push(p.name);
    else if (p.type === "ObjectPattern") for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out);
    else if (p.type === "ArrayPattern") for (const e of p.elements) patternNames(e, out);
    else if (p.type === "RestElement") patternNames(p.argument, out);
    else if (p.type === "AssignmentPattern") patternNames(p.left, out);
    return out;
}

function noteFn(d: Node, fns: Map<string, Node>): void {
    if (d.id?.type === "Identifier" && isFn(d.init)) fns.set(d.id.name, d.init);
}

/** `var`s anywhere in these statements (not in nested functions): they belong to the enclosing function */
function hoistVars(n: Node, names: string[], fns: Map<string, Node>): void {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => hoistVars(x, names, fns));
    if (n.type === "VariableDeclaration") {
        if (n.kind === "var")
            for (const d of n.declarations) {
                patternNames(d.id, names);
                noteFn(d, fns);
            }
        return;
    }
    if (isFn(n) || n.type === "ClassDeclaration" || n.type === "ClassExpression") return;
    for (const k of ["body", "consequent", "alternate", "block", "handler", "finalizer", "cases", "init", "left"]) hoistVars(n[k], names, fns);
}

/** what these statements declare in their block: `let`, `const`, classes and functions */
function lexical(stmts: Node[], names: string[], fns: Map<string, Node>): void {
    for (const st of stmts) {
        if (st.type === "VariableDeclaration" && st.kind !== "var")
            for (const d of st.declarations) {
                patternNames(d.id, names);
                noteFn(d, fns);
            }
        else if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) {
            names.push(st.id.name);
            if (st.type === "FunctionDeclaration") fns.set(st.id.name, st);
        }
    }
}

/** a declaration's pattern: only its defaults and computed keys are expressions */
function walkDeclPattern(p: Node, s: Scope, v: Visitor): void {
    if (!p || p.type === "Identifier") return;
    if (p.type === "ObjectPattern")
        for (const q of p.properties) {
            if (q.type === "RestElement") walkDeclPattern(q.argument, s, v);
            else {
                if (q.computed) walk(q.key, s, v);
                walkDeclPattern(q.value, s, v);
            }
        }
    else if (p.type === "ArrayPattern") for (const e of p.elements) walkDeclPattern(e, s, v);
    else if (p.type === "RestElement") walkDeclPattern(p.argument, s, v);
    else if (p.type === "AssignmentPattern") {
        walkDeclPattern(p.left, s, v);
        walk(p.right, s, v);
    } else walk(p, s, v);
}

function walkStatements(stmts: Node[], s: Scope, v: Visitor): void {
    const names: string[] = [];
    const fns = new Map<string, Node>();
    lexical(stmts, names, fns);
    const bs = names.length ? scope(s, names, fns) : s;
    for (const st of stmts) walk(st, bs, v);
}

function walkFunction(n: Node, s: Scope, v: Visitor): void {
    const names: string[] = n.type === "ArrowFunctionExpression" ? [] : ["arguments"];
    if (n.type === "FunctionExpression" && n.id) names.push(n.id.name);
    for (const p of n.params) patternNames(p, names);
    const fns = new Map<string, Node>();
    const block = n.body.type === "BlockStatement";
    if (block) {
        hoistVars(n.body.body, names, fns);
        lexical(n.body.body, names, fns);
    }
    const fs = scope(s, names, fns);
    for (const p of n.params) walkDeclPattern(p, fs, v);
    if (block) for (const st of n.body.body) walk(st, fs, v);
    else walk(n.body, fs, v);
}

/** visits `n`'s identifier references (with the scope they're in) and calls */
function walk(n: Node, s: Scope, v: Visitor): void {
    if (!n || typeof n.type !== "string") return;
    switch (n.type) {
        case "Identifier":
            return v.ref?.(n.name, s);
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
            return walkFunction(n, s, v);
        case "ClassDeclaration":
        case "ClassExpression": {
            const cs = n.type === "ClassExpression" && n.id ? scope(s, [n.id.name]) : s;
            walk(n.superClass, cs, v);
            for (const m of n.body.body) {
                if (m.type === "StaticBlock") walkStatements(m.body, cs, v);
                else {
                    if (m.computed) walk(m.key, cs, v);
                    walk(m.value, cs, v);
                }
            }
            return;
        }
        case "BlockStatement":
        case "StaticBlock":
            return walkStatements(n.body, s, v);
        case "ForStatement":
        case "ForInStatement":
        case "ForOfStatement": {
            const decl = n.type === "ForStatement" ? n.init : n.left;
            const fs = decl?.type === "VariableDeclaration" && decl.kind !== "var" ? scope(s, decl.declarations.flatMap((d: Node) => patternNames(d.id))) : s;
            for (const k of ["init", "test", "update", "left", "right", "body"]) walk(n[k], fs, v);
            return;
        }
        case "CatchClause": {
            const cs = scope(s, patternNames(n.param));
            walkDeclPattern(n.param, cs, v);
            return walk(n.body, cs, v);
        }
        case "SwitchStatement": {
            walk(n.discriminant, s, v);
            const all = n.cases.flatMap((c: Node) => c.consequent);
            const names: string[] = [];
            const fns = new Map<string, Node>();
            lexical(all, names, fns);
            const ss = names.length ? scope(s, names, fns) : s;
            for (const c of n.cases) {
                walk(c.test, ss, v);
                for (const st of c.consequent) walk(st, ss, v);
            }
            return;
        }
        case "VariableDeclaration":
            for (const d of n.declarations) {
                walkDeclPattern(d.id, s, v);
                walk(d.init, s, v);
            }
            return;
        case "MemberExpression":
            // the transpiled script reads its exported top-level names as `exports.x`
            if (!n.computed && n.object?.type === "Identifier" && n.object.name === "exports" && n.property?.type === "Identifier") v.ref?.(`exports.${n.property.name}`, s);
            walk(n.object, s, v);
            if (n.computed) walk(n.property, s, v);
            return;
        case "Property":
        case "PropertyDefinition":
        case "MethodDefinition":
            if (n.computed) walk(n.key, s, v);
            return walk(n.value, s, v);
        case "LabeledStatement":
            return walk(n.body, s, v);
        case "BreakStatement":
        case "ContinueStatement":
        case "MetaProperty":
            return;
        case "CallExpression":
            v.call?.(n, s);
            break;
    }
    for (const k of Object.keys(n)) {
        if (SKIP_KEYS.has(k)) continue;
        const c = n[k];
        if (Array.isArray(c)) for (const x of c) walk(x, s, v);
        else if (c && typeof c === "object") walk(c, s, v);
    }
}

/** the names `n` uses that it doesn't declare itself (`own`: names it declares at its own level) */
function freeNames(n: Node, own: string[] = []): Set<string> {
    const out = new Set<string>();
    walk(n, scope(null, own), { ref: (name, s) => !resolve(name, s) && out.add(name) });
    return out;
}

interface TopDecl {
    node: Node;
    names: string[];
    /** the top-level names it uses */
    uses: Set<string>;
}

interface EvaluateCall {
    call: Node;
    fn: Node;
    /** the module's top-level names `fn` uses */
    top: string[];
    /** names `fn` uses from the scopes around it, below the top level: not shippable */
    locals: string[];
}

interface Analysis {
    js: string;
    decls: TopDecl[];
    /** top-level name → the declarations that declare it */
    declOf: Map<string, TopDecl[]>;
    /** top-level names bound to a store or an overlay handle (`wt.pageStore(…)`, `wt.globalStore(…)`, `wt.onPage(…)`) */
    handles: Set<string>;
    calls: EvaluateCall[];
    /** `wt.onPage(…)` calls, in source order */
    onPages: Node[];
}

const isWt = (callee: Node, ...names: string[]) =>
    callee?.type === "MemberExpression" && !callee.computed && callee.object?.type === "Identifier" && callee.object.name === "wt" && names.includes(callee.property?.name);
const isWtOnPage = (callee: Node) => isWt(callee, "onPage");

function analyze(js: string): Analysis | null {
    let program: Node;
    try {
        program = parse(js, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
    } catch {
        return null;
    }
    const decls: TopDecl[] = [];
    const declOf = new Map<string, TopDecl[]>();
    const handles = new Set<string>();
    for (const st of program.body) {
        if (st.type === "VariableDeclaration")
            for (const d of st.declarations) if (d.init?.type === "CallExpression" && isWt(d.init.callee, "pageStore", "globalStore", "onPage")) patternNames(d.id).forEach((x) => handles.add(x));
        const names =
            st.type === "VariableDeclaration"
                ? st.declarations.flatMap((d: Node) => patternNames(d.id))
                : (st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id
                  ? [st.id.name]
                  : [];
        if (!names.length) continue;
        const d: TopDecl = { node: st, names, uses: freeNames(st, names) };
        decls.push(d);
        for (const name of names) {
            declOf.set(name, [...(declOf.get(name) || []), d]);
            declOf.set(`exports.${name}`, declOf.get(name)!);
        }
    }
    const topNames: string[] = [];
    const topFns = new Map<string, Node>();
    hoistVars(program.body, topNames, topFns);
    lexical(program.body, topNames, topFns);
    const top = scope(null, topNames, topFns);
    top.top = true;
    const calls: EvaluateCall[] = [];
    const onPages: Node[] = [];
    const call = (n: Node, s: Scope) => {
        if (isWtOnPage(n.callee)) onPages.push(n);
        const callee = n.callee;
        // `ctx.evaluate(…)`, or a destructured `evaluate(…)`
        const named = callee?.type === "MemberExpression" ? !callee.computed && callee.property?.name === "evaluate" : callee?.type === "Identifier" && callee.name === "evaluate";
        if (!named) return;
        const arg = n.arguments[0];
        let fn: Node = null;
        let at: Scope | null = s;
        if (isFn(arg)) fn = arg;
        else if (arg?.type === "Identifier") {
            at = resolve(arg.name, s);
            fn = at?.fns.get(arg.name);
        }
        if (!fn || !at) return;
        const own = fn.type === "FunctionDeclaration" ? [fn.id.name] : [];
        const tops: string[] = [];
        const locals: string[] = [];
        for (const name of freeNames(fn, own)) {
            if (name.startsWith("exports.")) {
                if (declOf.has(name) && !resolve("exports", at)) tops.push(name);
                continue;
            }
            const where = resolve(name, at);
            if (!where) continue;
            if (where.top && declOf.has(name)) tops.push(name);
            else locals.push(name);
        }
        calls.push({ call: n, fn, top: tops, locals });
    };
    for (const st of program.body) walk(st, top, { call });
    return { js, decls, declOf, handles, calls, onPages };
}

/** the top-level declarations `names` need, transitively, in source order (what's read as `exports.x` gets that too) */
function preludeOf(a: Analysis, names: string[]): string {
    const picked = new Set<TopDecl>();
    const exported = new Set<string>();
    const queue = [...names];
    while (queue.length) {
        const name = queue.pop()!;
        if (name.startsWith("exports.")) exported.add(name.slice(8));
        for (const d of a.declOf.get(name) || []) {
            if (picked.has(d)) continue;
            picked.add(d);
            for (const u of d.uses) if (a.declOf.has(u)) queue.push(u);
        }
    }
    return a.decls
        .filter((d) => picked.has(d))
        .map((d) => a.js.slice(d.node.start, d.node.end) + d.names.filter((n) => exported.has(n)).map((n) => ` exports.${n} = ${n};`).join(""))
        .join("\n");
}

const memo = new Map<string, EvalCapture[]>();

/** a module's `ctx.evaluate` functions that use its top-level declarations, with what to run before them in the page */
export function evalCaptures(js: string): EvalCapture[] {
    if (!EVALUATE.test(js)) return [];
    const hit = memo.get(js);
    if (hit) return hit;
    const a = analyze(js);
    const out: EvalCapture[] = [];
    const seen = new Set<string>();
    for (const c of a?.calls || []) {
        if (!c.top.length) continue;
        const fn = js.slice(c.fn.start, c.fn.end);
        if (seen.has(fn)) continue;
        seen.add(fn);
        const prelude = preludeOf(a!, c.top);
        out.push(/\brequire\s*\(/.test(prelude) ? { fn, prelude, libs: true } : { fn, prelude });
    }
    if (memo.size > 200) memo.clear();
    memo.set(js, out);
    return out;
}

/**
 * Warnings ("onPage #N: …", Problems view) for `ctx.evaluate` functions
 * in `wt.onPage` handlers that use the handler's own variables (its
 * parameters, locals, enclosing functions'): they don't come along to the
 * page world. The script's top-level declarations and imports do.
 */
export function evaluateProblems(code: string): string[] {
    if (!EVALUATE.test(code)) return [];
    const a = analyze(toRunnableJs(code));
    if (!a) return [];
    const out: string[] = [];
    const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");
    for (const c of a.calls) {
        const handles = [...new Set(c.top.map((x) => x.replace(/^exports\./, "")))].filter((x) => a.handles.has(x));
        if (!c.locals.length && !handles.length) continue;
        let nth = -1;
        a.onPages.forEach((p, i) => p.start <= c.call.start && c.call.end <= p.end && (nth = i));
        if (nth < 0) continue;
        const used = c.locals;
        if (used.length)
            out.push(
                `onPage #${nth + 1}: ctx.evaluate's function uses ${list(used)} from the handler, but it runs in the page world, where only your script's top-level declarations and imports come along — pass ${used.length > 1 ? "them" : "it"} as an argument: ctx.evaluate((${used[0]}) => …, ${used[0]}) (functions become callbacks)`
            );
        if (handles.length)
            out.push(
                `onPage #${nth + 1}: ctx.evaluate's function uses ${list(handles)}, but stores and overlay handles don't work in the page world — read what you need from ${handles.length > 1 ? "them" : "it"} in the handler and pass it as an argument`
            );
    }
    return out;
}
