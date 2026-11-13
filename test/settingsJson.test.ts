import { describe, expect, it } from "vitest";
import { DEFAULT_LOG_CAP, DEFAULT_LOG_LEVEL, parseSettings, planSettings, renderSettings, type GlobalSettings, type ScriptSettingsState } from "../src/shared/settingsJson";

const G: GlobalSettings = { logLevel: DEFAULT_LOG_LEVEL, logCap: DEFAULT_LOG_CAP };

describe("settings.json", () => {
    it("renders {} when all globals and scripts are at their defaults", () => {
        const scripts: ScriptSettingsState[] = [
            {
                name: "A.ts",
                declared: true,
                enabled: true,
                defs: {
                    host: { type: "string", default: "a.com" },
                    network: { retries: { type: "number", default: 3 } },
                },
                values: {},
            },
            { name: "lib.ts", declared: false, enabled: true, defs: {}, values: {} },
        ];
        expect(renderSettings(G, scripts)).toBe("{}\n");
    });

    it("renders only non-default globals, disabled scripts, and overridden params (including nested groups)", () => {
        const scripts: ScriptSettingsState[] = [
            {
                name: "A.ts",
                declared: true,
                enabled: false,
                defs: {
                    host: { type: "string", default: "a.com" },
                    network: {
                        retries: { type: "number", default: 3 },
                        env: { type: "enum", choices: ["dev", "prod"], default: "dev" },
                    },
                },
                values: { network: { retries: 3, env: "prod" } },
            },
            {
                name: "B.tsx",
                declared: true,
                enabled: true,
                defs: { flag: { type: "boolean", default: true } },
                values: {},
            },
        ];
        const text = renderSettings({ logLevel: "debug", logCap: 500, bodyCap: 4096 }, scripts);
        expect(JSON.parse(text)).toEqual({
            logLevel: "debug",
            bodyCap: 4096,
            scripts: {
                "A.ts": {
                    enabled: false,
                    network: { env: "prod" },
                },
            },
        });
    });

    it("full-file plan resets omitted globals, enabled state, and params back to defaults", () => {
        const scripts: ScriptSettingsState[] = [
            {
                name: "A.ts",
                declared: true,
                enabled: false,
                defs: { host: { type: "string", default: "a.com" }, n: { type: "number", default: 1 } },
                values: { host: "b.com", n: 9 },
            },
        ];
        const plan = planSettings(parseSettings("{}"), { logLevel: "debug", logCap: 1000, bodyCap: 4096 }, scripts);
        expect(plan).toEqual({
            globals: { logLevel: "info", logCap: 500, bodyCap: 2048 },
            scripts: [{ name: "A.ts", enabled: true, params: { host: "a.com", n: 1 } }],
        });
    });

    it("rejects non-object JSON roots and invalid JSON syntax", () => {
        expect(() => parseSettings("{bad")).toThrow(/invalid JSON/);
        expect(() => parseSettings("[]")).toThrow(/JSON object/);
        expect(() => parseSettings("123")).toThrow(/JSON object/);
    });
});
