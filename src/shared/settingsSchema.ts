/**
 * JSON schema for settings.json — used by Monaco's built-in JSON worker in
 * the Editor and written into the synced folder as settings.schema.json for
 * external editors.
 */
import { LOG_LEVELS, DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, TEXT_TYPES_DESC, DEFAULT_BODY_CAP, BODY_CAP_MIN, BODY_CAP_MAX, type ScriptSettingsState } from "./settingsJson";
import { DEFAULT_TEXT_TYPES } from "./bodyKind";
import { isParamDef, paramDefault, type ParamNode } from "./scriptDef";
import { GENERATED_NOTE } from "./generatedFiles";

export const SETTINGS_SCHEMA = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $comment: GENERATED_NOTE,
    title: "TangiTweak settings",
    description: "Extension settings and per-script enabled state & param overrides (settings.json). Omitted keys use their defaults.",
    type: "object",
    additionalProperties: false,
    properties: {
        $schema: {
            type: "string",
            description: "Optional JSON Schema URI (e.g. ./settings.schema.json)",
        },
        logLevel: {
            type: "string",
            enum: [...LOG_LEVELS],
            default: DEFAULT_LOG_LEVEL,
            description: "Minimum log level shown in the panel",
        },
        logCap: {
            type: "integer",
            minimum: 100,
            maximum: 10000,
            default: DEFAULT_LOG_CAP,
            description: "Log lines kept in the panel",
        },
        textTypes: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            default: [...DEFAULT_TEXT_TYPES],
            description: `${TEXT_TYPES_DESC} Replaces the defaults (see docs/scripting.md#binary-bodies)`,
        },
        bodyCap: {
            type: "integer",
            minimum: BODY_CAP_MIN,
            maximum: BODY_CAP_MAX,
            default: DEFAULT_BODY_CAP,
            description: "Network view: kB of each request/response body kept; longer bodies are cut",
        },
        scripts: {
            type: "object",
            description: "Per-script overrides keyed by script file name (`enabled` + declared `tt.params`)",
            additionalProperties: {
                type: "object",
                description: "Overrides for one script (`enabled` and params from its tt.params / tt.defineParam)",
                properties: {
                    enabled: { type: "boolean", default: true, description: "Run this script" },
                },
                additionalProperties: true,
            },
        },
    },
};

function paramSchema(d: ParamNode): Record<string, any> {
    if (!isParamDef(d)) {
        const properties: Record<string, any> = {};
        for (const [k, sub] of Object.entries(d)) properties[k] = paramSchema(sub);
        return { type: "object", properties, additionalProperties: false };
    }
    const base: Record<string, any> = { default: paramDefault(d) };
    if (d.description) base.description = d.description;
    switch (d.type) {
        case "boolean":
            return { type: "boolean", ...base };
        case "number":
            return { type: "number", ...base, ...(d.min !== undefined && { minimum: d.min }), ...(d.max !== undefined && { maximum: d.max }) };
        case "string":
            return { type: "string", ...base };
        case "enum":
            return { type: "string", enum: d.choices, ...base };
        case "stringList":
            return { type: "array", items: { type: "string" }, ...base };
        case "shortcut":
            return { type: "string", ...base, description: `${d.description ? d.description + " — " : ""}keys, e.g. "Mod+Shift+K" (Mod = Cmd on macOS, Ctrl elsewhere); "" for none` };
    }
}

/**
 * The schema for the current scripts: each script file name is a known key
 * under `scripts`, with its declared params typed (enum choices, bounds,
 * defaults, descriptions) — so Monaco and VS Code complete and validate them.
 */
export function buildSettingsSchema(scripts: ScriptSettingsState[]): typeof SETTINGS_SCHEMA {
    const props: Record<string, any> = {};
    for (const s of scripts) {
        const p: Record<string, any> = {};
        if (s.declared) p.enabled = SETTINGS_SCHEMA.properties.scripts.additionalProperties.properties.enabled;
        for (const [k, d] of Object.entries(s.defs)) if (k !== "enabled") p[k] = paramSchema(d);
        if (!Object.keys(p).length) continue;
        props[s.name] = { type: "object", description: `Settings and params for "${s.name}"`, properties: p, additionalProperties: false };
    }
    const scriptsProp = { ...SETTINGS_SCHEMA.properties.scripts, properties: props };
    return { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, scripts: scriptsProp } } as any;
}

/** pretty-printed, trailing newline — the exact bytes written to the synced folder */
export const settingsSchemaJson = (scripts: ScriptSettingsState[] = []): string => JSON.stringify(buildSettingsSchema(scripts), null, 2) + "\n";
