/**
 * Script parameters: tt.params({...}) / tt.defineParam(name, def).
 * Values are edited in the manager / popup / settings.yaml.
 */
import { isShortcut } from "./shortcut";

export interface ParamDefBoolean {
    type: "boolean";
    default?: boolean;
    description?: string;
    /** turns the raw value into what the script receives; never stored or serialized */
    parse?: (raw: boolean) => unknown;
}
export interface ParamDefNumber {
    type: "number";
    default?: number;
    description?: string;
    /** optional bounds — the UI clamps typed values */
    min?: number;
    max?: number;
    /** step for the number input (default 1; use e.g. 0.1 for decimals) */
    step?: number;
    parse?: (raw: number) => unknown;
}
export interface ParamDefString {
    type: "string";
    /** edit in a textarea; values with newlines are written as YAML block scalars in settings.yaml */
    multiline?: boolean;
    default?: string;
    description?: string;
    parse?: (raw: string) => unknown;
}
export interface ParamDefEnum {
    type: "enum";
    choices: string[];
    default?: string;
    description?: string;
    parse?: (raw: string) => unknown;
}
export interface ParamDefStringList {
    type: "stringList";
    default?: string[];
    description?: string;
    parse?: (raw: string[]) => unknown;
}
export interface ParamDefShortcut {
    type: "shortcut";
    /** keys as ctx.shortcut takes them ("Mod+Shift+K"); "" (the default) is none */
    default?: string;
    description?: string;
    parse?: (raw: string) => unknown;
}
export const PARAM_TYPES = ["boolean", "number", "string", "enum", "stringList", "shortcut"] as const;

export type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList | ParamDefShortcut;

/** A nested section grouping parameters (or sub-sections) in the UI and settings.yaml. */
export interface ParamGroup {
    [key: string]: ParamNode;
}
export type ParamNode = ParamDef | ParamGroup;
export type ParamTree = Record<string, ParamNode>;

/** the stored/edited value type of a def (what `parse` receives) */
export type ParamRawValue<D extends ParamDef> = D extends ParamDefBoolean
    ? boolean
    : D extends ParamDefNumber
      ? number
      : D extends ParamDefString
        ? string
        : D extends ParamDefEnum
          ? D["choices"][number]
          : D extends ParamDefStringList
            ? string[]
            : D extends ParamDefShortcut
              ? string
              : never;

/** what the script sees: the parser's return type when `parse` is set, else the raw value */
export type ParamValue<D extends ParamDef> = D extends { parse: (raw: never) => infer R } ? R : ParamRawValue<D>;

type IsReadonlyParam<V> = V extends ParamDef ? (V extends { parse: Function } ? true : false) : true;
type ParamEntryValue<V> = V extends ParamDef ? ParamValue<V> : V extends ParamGroup ? ParamsOf<V> : never;

/** assignable from handler code (shared/paramsProxy), except params with `parse` and section objects themselves */
export type ParamsOf<T extends ParamGroup> = {
    -readonly [K in keyof T as IsReadonlyParam<T[K]> extends false ? K : never]: ParamEntryValue<T[K]>;
} & {
    readonly [K in keyof T as IsReadonlyParam<T[K]> extends true ? K : never]: ParamEntryValue<T[K]>;
};

const isPlainObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

export function isParamDef(v: unknown): v is ParamDef {
    return isPlainObj(v) && typeof v.type === "string" && (PARAM_TYPES as readonly string[]).includes(v.type);
}

export function isParamGroup(v: unknown): v is ParamGroup {
    return isPlainObj(v) && !isParamDef(v) && typeof v.type !== "string";
}

export function paramDefault(def: ParamDef): any {
    if (def.default !== undefined) return def.default;
    switch (def.type) {
        case "boolean":
            return false;
        case "number":
            return 0;
        case "string":
            return "";
        case "enum":
            return def.choices[0] ?? "";
        case "stringList":
            return [];
        case "shortcut":
            return "";
    }
}

/** Merge user-provided values over defaults (recursively across parameter sections); invalid values fall back. */
export function resolveParamValues(defs: ParamTree, stored: Record<string, any> | undefined): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, node] of Object.entries(defs)) {
        if (isParamDef(node)) {
            const v = stored?.[key];
            out[key] = isValidParamValue(node, v) ? v : paramDefault(node);
        } else if (isParamGroup(node)) {
            out[key] = resolveParamValues(node, isPlainObj(stored?.[key]) ? stored[key] : undefined);
        }
    }
    return out;
}

/** Resolve a leaf parameter by key or `"."`-joined section path (`"network.host"`). */
export function findParamDef(defs: ParamTree | undefined, key: string, prefix: string[] = []): { path: string[]; def: ParamDef } | undefined {
    if (!defs) return undefined;
    if (Object.prototype.hasOwnProperty.call(defs, key)) {
        const node = defs[key];
        if (isParamDef(node)) return { path: [...prefix, key], def: node };
    }
    for (const [k, node] of Object.entries(defs)) {
        if (isParamGroup(node) && key.startsWith(k + ".")) {
            const hit = findParamDef(node, key.slice(k.length + 1), [...prefix, k]);
            if (hit) return hit;
        }
    }
    return undefined;
}

export function getParamAtPath(values: Record<string, any> | undefined, path: readonly string[]): any {
    let cur: any = values;
    for (const seg of path) {
        if (!isPlainObj(cur)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

export function setParamAtPath(values: Record<string, any> | undefined, path: readonly string[], value: any): Record<string, any> {
    const base = isPlainObj(values) ? values : {};
    if (!path.length) return base;
    const [head, ...rest] = path;
    return { ...base, [head]: rest.length === 0 ? value : setParamAtPath(isPlainObj(base[head]) ? base[head] : undefined, rest, value) };
}

export function isValidParamValue(def: ParamDef, v: any): boolean {
    if (v === undefined || v === null) return false;
    switch (def.type) {
        case "boolean":
            return typeof v === "boolean";
        case "number":
            return typeof v === "number" && isFinite(v);
        case "string":
            return typeof v === "string";
        case "enum":
            return typeof v === "string" && def.choices.includes(v);
        case "stringList":
            return Array.isArray(v) && v.every((x) => typeof x === "string");
        case "shortcut":
            return isShortcut(v);
    }
}

/** a def without its `parse` function — what gets stored, messaged and diffed */
export function serializableParamDef<D extends ParamDef>(def: D): D {
    if (!("parse" in def)) return def;
    const { parse: _parse, ...rest } = def;
    return rest as D;
}

/** a tree of defs/sections with `parse` functions stripped from every leaf */
export function serializableParamTree(defs: ParamTree): ParamTree {
    const out: ParamTree = {};
    for (const [k, node] of Object.entries(defs)) {
        out[k] = isParamDef(node) ? serializableParamDef(node) : serializableParamTree(node);
    }
    return out;
}

/**
 * Run the def's `parse` (if any) over a resolved raw value. A throwing
 * parser becomes an error naming the param and the value.
 */
export function parseParamValue(key: string, def: ParamDef, raw: any): any {
    const parse = (def as { parse?: unknown }).parse;
    if (parse === undefined) return raw;
    if (typeof parse !== "function") throw new Error(`param "${key}": parse must be a function`);
    try {
        return parse(Array.isArray(raw) ? [...raw] : raw);
    } catch (e: any) {
        let shown = JSON.stringify(raw) ?? String(raw);
        if (shown.length > 200) shown = shown.slice(0, 200) + "…";
        throw new Error(`param "${key}": parse failed for value ${shown}: ${e && typeof e.message === "string" ? e.message : String(e)}`);
    }
}

/** Run `parseParamValue` across every leaf in a parameter tree. */
export function parseParamTree(defs: ParamTree, raw: Record<string, any> | undefined, prefix = ""): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, node] of Object.entries(defs)) {
        const path = prefix ? `${prefix}.${k}` : k;
        out[k] = isParamDef(node) ? parseParamValue(path, node, raw?.[k]) : parseParamTree(node, isPlainObj(raw?.[k]) ? raw[k] : undefined, path);
    }
    return out;
}
