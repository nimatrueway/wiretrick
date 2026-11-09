/**
 * Hot refresh for script components (docs/scripting.md, "Component state
 * across saves"): a save keeps the state of every named function component,
 * nested ones too, on production React (React Refresh needs a development
 * build).
 *
 * Each script module gets its own `react` and `react/jsx-runtime`
 * (`HotCompile.module`). Their `jsx`/`createElement` swap a named function
 * component for its family's stand-in: one per (module, name), kept across
 * saves, rendering the latest version. So React sees the same type after a
 * save and keeps the state; the stand-ins re-render when a save brings a
 * new version (also under `memo`). Around the version, a key made of its
 * hook calls remounts it when they change, and an error boundary remounts
 * it once if a render after a save throws (a custom hook's hooks changed).
 *
 * Those modules' effect, memo and callback hooks get one more dependency,
 * the module's code: a save that changed it re-runs its effects and
 * recomputes its memos. `createContext` gives a module's n-th context the
 * same object on every save, so providers don't remount their subtree.
 *
 * Left alone (they remount on a save): anonymous functions, classes,
 * functions a downloaded package exports, and a name bound to two
 * functions in one compile (a component made inside another one, or two
 * imports of the same name).
 */
import { isPackageExport } from "./packageImports";

const MEMO = Symbol.for("react.memo");
const NOT_HOT = Symbol.for("wiretrick.notHot");

const DEP_HOOKS = ["useEffect", "useLayoutEffect", "useInsertionEffect", "useMemo", "useCallback"] as const;
/** contexts a module keeps across saves (more are made fresh: a context made while rendering) */
const MAX_CONTEXTS = 64;

interface Family {
    impl: Function;
    sig: string;
    /** the compile its version came from */
    epoch: number;
    /** a save replaced the first version */
    saved: boolean;
    /** the compile in which its error boundary remounted it */
    retried: number;
    /** two functions had its name in compile `epoch`: not hot until a new compile */
    local: boolean;
    Outer: Function;
    /** its mounted stand-ins' re-render */
    live: Set<() => void>;
}

interface HotModule {
    path: string;
    epoch: number;
    /** the module's code, as an extra hook dependency */
    token: string;
    contexts: number;
    react?: any;
    jsx?: any;
}

/** a function component that hot refresh leaves alone (Wiretrick's own wrappers) */
export function notHot<F extends Function>(fn: F): F {
    (fn as any)[NOT_HOT] = true;
    return fn;
}

/** the hook calls a component makes, in order: its state's shape */
export function hookSignature(fn: Function): string {
    let src: string;
    try {
        src = Function.prototype.toString.call(fn);
    } catch {
        return "";
    }
    return (src.match(/\buse[A-Z][\w$]*/g) || []).join(",");
}

function shallowEqual(a: any, b: any): boolean {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
    return true;
}

function named<F extends Function>(fn: F, name: string): F {
    try {
        Object.defineProperty(fn, "name", { value: name, configurable: true });
    } catch {}
    return fn;
}

/** one script's families in this realm, across its compiles */
export class HotRegistry {
    private readonly families = new Map<string, Family>();
    private readonly memos = new Map<string, { compare: any; type: any }>();
    private readonly contexts = new Map<string, any>();
    /** a version → what JSX renders for it (its stand-in, or itself) */
    private readonly byFn = new WeakMap<Function, Function>();
    private readonly byMemo = new WeakMap<object, any>();
    private epoch = 0;
    private R: any = null;
    private Boundary: any = null;
    private readonly dirty = new Set<Family>();

    /** a new compile of the script: its modules' React */
    begin(): HotCompile {
        return new HotCompile(this, ++this.epoch);
    }

    /** @internal */
    react(R: any): void {
        if (this.R === R) return;
        this.R = R;
        this.Boundary = makeBoundary(R);
    }

    /** @internal the type `jsx` renders for `t` */
    type(m: HotModule, t: any): any {
        if (typeof t === "function") return this.fn(m, t);
        if (t && typeof t === "object" && t.$$typeof === MEMO && typeof t.type === "function") return this.memo(m, t);
        return t;
    }

    /** @internal a context kept across saves */
    context(m: HotModule, R: any, args: any[]): any {
        if (m.contexts >= MAX_CONTEXTS) return R.createContext(...args);
        const key = m.path + "#context:" + m.contexts++;
        let c = this.contexts.get(key);
        if (!c) this.contexts.set(key, (c = R.createContext(...args)));
        return c;
    }

    private fn(m: HotModule, t: Function): Function {
        const known = this.byFn.get(t);
        if (known) return known;
        if (!t.name || (t as any)[NOT_HOT] || t.prototype?.isReactComponent || isPackageExport(t)) return t;
        const key = m.path + "#" + t.name;
        let f = this.families.get(key);
        if (!f) this.families.set(key, (f = this.family(t, m.epoch)));
        else if (m.epoch > f.epoch) {
            // a save: the new version
            f.impl = t;
            f.sig = hookSignature(t);
            f.epoch = m.epoch;
            f.saved = true;
            f.local = false;
            this.refresh(f);
        } else if (m.epoch === f.epoch && f.impl !== t) f.local = true;
        // (an older compile still rendering gets the family as it is)
        const out = f.local ? t : f.Outer;
        this.byFn.set(t, out);
        return out;
    }

    private memo(m: HotModule, t: any): any {
        const known = this.byMemo.get(t);
        if (known) return known;
        const inner = this.fn(m, t.type);
        if (inner === t.type) return t;
        const key = m.path + "#memo:" + t.type.name;
        let e = this.memos.get(key);
        if (!e) {
            const entry: { compare: any; type: any } = { compare: t.compare, type: null };
            entry.type = this.R.memo(inner, (a: any, b: any) => (entry.compare || shallowEqual)(a, b));
            this.memos.set(key, (e = entry));
        } else e.compare = t.compare;
        this.byMemo.set(t, e.type);
        return e.type;
    }

    private family(t: Function, epoch: number): Family {
        const R = this.R;
        const Boundary = this.Boundary;
        const f: Family = { impl: t, sig: hookSignature(t), epoch, saved: false, retried: 0, local: false, Outer: null as any, live: new Set() };
        // the version's hooks are this component's
        const Inner = notHot(named((props: any) => f.impl(props), t.name));
        f.Outer = notHot(named((props: any) => {
            const [, force] = R.useReducer((n: number) => n + 1, 0);
            R.useLayoutEffect(() => {
                f.live.add(force);
                return () => void f.live.delete(force);
            }, []);
            return R.createElement(Boundary, { f, key: f.sig }, R.createElement(Inner, props));
        }, t.name));
        return f;
    }

    /** re-render a family's mounted stand-ins (once, after this compile's JSX ran) */
    private refresh(f: Family): void {
        if (this.dirty.size === 0)
            queueMicrotask(() => {
                const fams = [...this.dirty];
                this.dirty.clear();
                for (const g of fams) for (const force of [...g.live]) force();
            });
        this.dirty.add(f);
    }
}

/** catches a render error right after a save once, and remounts the version; otherwise rethrows */
function makeBoundary(R: any): any {
    return class HotBoundary extends R.Component {
        state = { error: null as unknown, n: 0 };
        static getDerivedStateFromError(error: unknown) {
            return { error };
        }
        componentDidCatch() {
            const f: Family = (this as any).props.f;
            if (f.saved && f.retried !== f.epoch) {
                f.retried = f.epoch;
                (this as any).setState((s: { n: number }) => ({ error: null, n: s.n + 1 }));
            }
        }
        render() {
            const s = (this as any).state;
            const f: Family = (this as any).props.f;
            if (s.error) {
                if (f.saved && f.retried !== f.epoch) return null;
                throw s.error;
            }
            return R.createElement(R.Fragment, { key: s.n }, (this as any).props.children);
        }
    };
}

/** one compile of a script: its modules' `react` and `react/jsx-runtime` */
export class HotCompile {
    private readonly modules = new Map<string, HotModule>();

    constructor(
        private readonly reg: HotRegistry,
        private readonly epoch: number
    ) {}

    /** `name` (a built-in) as module `path` (whose code is `code`) imports it: React `R`'s modules hot, others as they are */
    wrap(name: string, mod: any, path: string, code: string, R: any): any {
        if (name !== "react" && name !== "react/jsx-runtime" && name !== "react/jsx-dev-runtime") return mod;
        this.reg.react(R);
        let m = this.modules.get(path);
        if (!m) this.modules.set(path, (m = { path, epoch: this.epoch, token: code, contexts: 0 }));
        if (name === "react") return (m.react ??= this.react(m, mod));
        return (m.jsx ??= this.jsx(m, mod));
    }

    private react(m: HotModule, R: any): any {
        const reg = this.reg;
        const out: any = { ...R };
        if ("default" in R) out.default = out;
        for (const h of DEP_HOOKS) {
            const orig = R[h];
            if (typeof orig === "function") out[h] = (fn: any, deps?: any[]) => orig(fn, Array.isArray(deps) ? [...deps, m.token] : deps);
        }
        if (typeof R.useImperativeHandle === "function") out.useImperativeHandle = (ref: any, fn: any, deps?: any[]) => R.useImperativeHandle(ref, fn, Array.isArray(deps) ? [...deps, m.token] : deps);
        out.createElement = (t: any, ...rest: any[]) => R.createElement(reg.type(m, t), ...rest);
        out.createContext = (...args: any[]) => reg.context(m, R, args);
        return out;
    }

    private jsx(m: HotModule, J: any): any {
        const reg = this.reg;
        const out: any = { ...J };
        if ("default" in J) out.default = out;
        for (const k of ["jsx", "jsxs", "jsxDEV"]) {
            const orig = J[k];
            if (typeof orig === "function") out[k] = (t: any, ...rest: any[]) => orig(reg.type(m, t), ...rest);
        }
        return out;
    }
}

const registries = new Map<string, HotRegistry>();

/** script `id`'s families in this realm */
export function hotRegistry(id: string): HotRegistry {
    let r = registries.get(id);
    if (!r) registries.set(id, (r = new HotRegistry()));
    return r;
}
