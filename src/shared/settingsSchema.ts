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
import { LOG_LEVELS, DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL } from "./settingsYaml";

export const SETTINGS_SCHEMA = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "ResScript settings",
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
            },
        },
        params: {
            type: "object",
            description:
                "Per-script values keyed by script name: `enabled` toggles the script, other keys are its declared params",
            additionalProperties: {
                type: "object",
                description: "Values for one script (params declared by its res.declareScript call)",
                properties: {
                    enabled: { type: "boolean", default: true, description: "Run this script" },
                },
                additionalProperties: true,
            },
        },
    },
};

/** pretty-printed, trailing newline — the exact bytes written to the synced folder */
export const SETTINGS_SCHEMA_JSON = JSON.stringify(SETTINGS_SCHEMA, null, 2) + "\n";
