/**
 * What `tt.params` returns: the script's param values, assignable like a
 * valtio proxy. `cfg.on = false` (or `cfg.hosts.push("a")` on a list) is
 * checked against the param's type, seen right away by the code, and saved
 * like a change in the ⚙ panel — the script then hot-reloads with it.
 * Changes made in one turn are sent once per param (the last value).
 */
import { isParamDef, isParamGroup, isValidParamValue, parseParamValue, type ParamDef, type ParamTree } from "./scriptDef";

export interface ParamWriter {
    /** why params can't be changed right now (thrown), or undefined */
    blocked(): string | undefined;
    /** save `value` (raw) for `key` */
    send(key: string, value: any): void;
}

export const PARAM_AT_TOP = "tt.params: change a param from a handler, not from the script's top level (each change re-runs the script)";
export const PARAM_ON_SITE = "tt.params: onSite code can't change params (it runs in the site's world, where the site's code could too) — change them from onPage, onOverlay or network handlers";
export const PARAM_NOT_HERE = "tt.params: params can't be changed here";

const LIST_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const hasParse = (d: ParamDef) => (d as { parse?: unknown }).parse !== undefined;
const own = (o: object, k: PropertyKey) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const shown = (v: any) => {
    const s = JSON.stringify(v) ?? String(v);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
};

function expected(d: ParamDef): string {
    switch (d.type) {
        case "enum":
            return `one of ${d.choices.map((c) => JSON.stringify(c)).join(", ")}`;
        case "stringList":
            return "an array of strings";
        case "shortcut":
            return 'a shortcut like "Alt+Shift+M" (or "")';
        case "number":
            return "a finite number";
        default:
            return `a ${d.type}`;
    }
}

/**
 * `defs`: the params or sections (with their `parse`), `raw`: their resolved
 * raw values, `unknown`: values read-only here (a stubbed import's).
 */
export function paramsProxy(defs: ParamTree, raw: Record<string, any>, unknown: Record<string, any>, w: ParamWriter): Record<string, any> {
    const pending = new Map<string, any>();
    const queue = (fullKey: string, next: any) => {
        if (!pending.size) {
            queueMicrotask(() => {
                const out = [...pending];
                pending.clear();
                for (const [pk, pv] of out) w.send(pk, pv);
            });
        }
        pending.set(fullKey, next);
    };
    const build = (group: ParamTree, rawObj: Record<string, any> | undefined, unkObj: Record<string, any> | undefined, prefix: string): Record<string, any> => {
        const cur: Record<string, any> = {};
        const target: Record<string, any> = {};
        const pathOf = (k: string) => (prefix ? `${prefix}.${k}` : k);
        for (const k of Object.keys(group)) {
            const node = group[k];
            const full = pathOf(k);
            if (isParamDef(node)) {
                cur[k] = rawObj?.[k];
                target[k] = parseParamValue(full, node, cur[k]);
            } else if (isParamGroup(node)) {
                target[k] = build(node, rawObj?.[k], unkObj?.[k], full);
            }
        }
        if (unkObj && typeof unkObj === "object") {
            for (const [k, v] of Object.entries(unkObj)) if (!(k in target)) target[k] = v;
        }
        const assign = (k: PropertyKey, v: any): void => {
            const key = String(k);
            const full = pathOf(key);
            if (!own(group, k)) throw new Error(`tt.params: there's no parameter ${JSON.stringify(full)}${unkObj && own(unkObj, k) ? " here (it comes from an import)" : ""}`);
            const node = group[key];
            if (isParamGroup(node)) throw new Error(`tt.params: "${full}" is a parameter section — assign its parameters instead`);
            if (!isParamDef(node)) throw new Error(`tt.params: there's no parameter ${JSON.stringify(full)}`);
            if (hasParse(node)) throw new Error(`tt.params: "${full}" has a parse function, so it can't be assigned — change it in ⚙ or settings.json`);
            const why = w.blocked();
            if (why) throw new Error(why);
            if (!isValidParamValue(node, v)) throw new TypeError(`tt.params: "${full}" can't be ${shown(v)}: it takes ${expected(node)}`);
            const next = Array.isArray(v) ? [...v] : v;
            if (JSON.stringify(next) === JSON.stringify(cur[key])) return;
            cur[key] = next;
            target[key] = next;
            queue(full, next);
        };
        const lists = new Map<string, string[]>();
        const listOf = (k: string): string[] => {
            let l = lists.get(k);
            if (!l) {
                const full = pathOf(k);
                // reads the current value, so a kept reference sees later changes too
                l = new Proxy([] as string[], {
                    get: (_t, p) => {
                        if (typeof p === "string" && LIST_METHODS.has(p)) {
                            return (...args: any[]) => {
                                const next = [...cur[k]];
                                const out = (Array.prototype as any)[p].apply(next, args);
                                assign(k, next);
                                return out === next ? l : out;
                            };
                        }
                        return Reflect.get(cur[k], p);
                    },
                    set: (_t, p, v) => {
                        const next: any = [...cur[k]];
                        next[p] = v;
                        assign(k, next);
                        return true;
                    },
                    deleteProperty: () => {
                        throw new Error(`tt.params: remove items from "${full}" with splice, pop or a new array`);
                    },
                    has: (_t, p) => Reflect.has(cur[k], p),
                    ownKeys: () => Reflect.ownKeys(cur[k]),
                    getOwnPropertyDescriptor: (_t, p) => Reflect.getOwnPropertyDescriptor(cur[k], p),
                });
                lists.set(k, l);
            }
            return l;
        };
        return new Proxy(target, {
            get: (t, p, r) => {
                const entry = own(group, p) ? group[p as string] : undefined;
                return isParamDef(entry) && entry.type === "stringList" && !hasParse(entry) ? listOf(p as string) : Reflect.get(t, p, r);
            },
            set: (_t, p, v) => {
                assign(p, v);
                return true;
            },
            deleteProperty: (_t, p) => {
                throw new Error(`tt.params: a param can't be deleted (${pathOf(String(p))})`);
            },
            defineProperty: (_t, p) => {
                throw new Error(`tt.params: assign a param instead of defining it (${pathOf(String(p))})`);
            },
        });
    };
    return build(defs, raw, unknown, "");
}
