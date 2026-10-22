/**
 * JSON schema for settings.yaml — written into the synced folder as
 * settings.schema.json. The generated settings file's first line points at
 * it:
 *
 *   # yaml-language-server: $schema=./settings.schema.json
 *
 * which the VS Code YAML extension (redhat) picks up for validation and
 * completion. The browser manager enforces the same rules in code
 * (parseSettings shape checks + planSettings value validation) — keep both
 * in sync when the settings shape changes.
 */
import { LOG_LEVELS, DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, type ScriptSettingsState } from "./settingsYaml";
import { paramDefault, type ParamDef } from "./scriptDef";
import { builtinStrategy, STRATEGIES } from "./route";
import { strategyMarkdown, strategyEnumMarkdown } from "./strategyInfo";
import { GENERATED_NOTE } from "./generatedFiles";

export const SETTINGS_SCHEMA = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $comment: GENERATED_NOTE,
    title: "Wiretrick settings",
    description: "Extension settings + per-script params & enabled state (settings.yaml)",
    type: "object",
    additionalProperties: false,
    properties: {
        settings: {
            type: "object",
            description: "Global extension settings",
            additionalProperties: false,
            properties: {
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
                defaultStrategy: {
                    type: "string",
                    enum: [...STRATEGIES],
                    default: builtinStrategy(),
                    description: "Default interception strategy for handlers whose route doesn't set `strategy` (see docs/strategies.md#compatibility)",
                    markdownDescription: strategyMarkdown(),
                    markdownEnumDescriptions: strategyEnumMarkdown(),
                },
            },
        },
        params: {
            type: "object",
            description:
                "Per-script values keyed by script name: `enabled` toggles the script, other keys are its declared params",
            additionalProperties: {
                type: "object",
                description: "Values for one script (params from its wt.params / wt.defineParam)",
                properties: {
                    enabled: { type: "boolean", default: true, description: "Run this script" },
                },
                additionalProperties: true,
            },
        },
    },
};

function paramSchema(d: ParamDef): Record<string, any> {
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
    }
}

/**
 * The schema for the current scripts: each script name is a known key
 * under `params`, with its declared params typed (enum choices, bounds,
 * defaults, descriptions) — so VS Code completes and validates them like
 * the manager does. Unknown script names stay allowed (generic shape).
 */
export function buildSettingsSchema(scripts: ScriptSettingsState[]): typeof SETTINGS_SCHEMA {
    const props: Record<string, any> = {};
    for (const s of scripts) {
        const p: Record<string, any> = {};
        if (s.declared) p.enabled = SETTINGS_SCHEMA.properties.params.additionalProperties.properties.enabled;
        for (const [k, d] of Object.entries(s.defs)) if (k !== "enabled") p[k] = paramSchema(d);
        if (!Object.keys(p).length) continue;
        props[s.name] = { type: "object", description: `Values for the "${s.name}" script`, properties: p, additionalProperties: false };
    }
    const params = { ...SETTINGS_SCHEMA.properties.params, properties: props };
    return { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, params } } as any;
}

/** pretty-printed, trailing newline — the exact bytes written to the synced folder */
export const settingsSchemaJson = (scripts: ScriptSettingsState[] = []): string => JSON.stringify(buildSettingsSchema(scripts), null, 2) + "\n";
