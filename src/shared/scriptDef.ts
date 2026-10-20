/**
 * Declarative script definition: res.declareScript({...}).
 * The only way to activate a script — sources without it are libraries.
 */

export interface ParamDefBoolean {
    type: "boolean";
    default?: boolean;
    description?: string;
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
}
export interface ParamDefString {
    type: "string";
    /** edit in a textarea; values with newlines are written as YAML block scalars in settings.yaml */
    multiline?: boolean;
    default?: string;
    description?: string;
}
export interface ParamDefEnum {
    type: "enum";
    choices: string[];
    default?: string;
    description?: string;
}
export interface ParamDefStringList {
    type: "stringList";
    default?: string[];
    description?: string;
}
export type ParamDef = ParamDefBoolean | ParamDefNumber | ParamDefString | ParamDefEnum | ParamDefStringList;

export type ParamValue<D extends ParamDef> = D extends ParamDefBoolean
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

export type ParamsOf<T extends Record<string, ParamDef>> = {
    readonly [K in keyof T]: ParamValue<T[K]>;
};

export interface ScriptDef<T extends Record<string, ParamDef> = Record<string, ParamDef>> {
    /** URL patterns the script activates on */
    match?: string[];
    include?: string[];
    /** which interception events run (default: both) */
    phase?: ("request" | "response")[];
    /** interception tier priority list, e.g. ["hook", "cdp"] */
    strategy?: ("auto" | "hook" | "cdp" | "webrequest" | "process")[];
    runAt?: "document_start" | "document_end" | "document_idle" | "DOMContentLoaded";
    params?: T;
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
