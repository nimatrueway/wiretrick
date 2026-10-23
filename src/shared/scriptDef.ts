/**
 * Script parameters: wt.params({...}) / wt.defineParam(name, def).
 * Values are edited in the manager / popup / settings.yaml.
 */

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
export type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList;

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
            : never;

/** what the script sees: the parser's return type when `parse` is set, else the raw value */
export type ParamValue<D extends ParamDef> = D extends { parse: (raw: never) => infer R } ? R : ParamRawValue<D>;

export type ParamsOf<T extends Record<string, ParamDef>> = {
    readonly [K in keyof T]: ParamValue<T[K]>;
};

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
    }
}

/** Merge user-provided values over defaults; invalid values fall back. */
export function resolveParamValues(defs: Record<string, ParamDef>, stored: Record<string, any> | undefined): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, def] of Object.entries(defs)) {
        const v = stored?.[key];
        out[key] = isValidParamValue(def, v) ? v : paramDefault(def);
    }
    return out;
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
    }
}

/** a def without its `parse` function — what gets stored, messaged and diffed */
export function serializableParamDef<D extends ParamDef>(def: D): D {
    if (!("parse" in def)) return def;
    const { parse: _parse, ...rest } = def;
    return rest as D;
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
