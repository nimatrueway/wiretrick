import { describe, it, expect } from "vitest";
import { buildSettingsSchema, settingsSchemaJson, SETTINGS_SCHEMA } from "../src/shared/settingsSchema";

describe("settings schema from scripts", () => {
    const schema: any = buildSettingsSchema([
        {
            name: "API mocker",
            declared: true,
            enabled: true,
            values: {},
            defs: {
                status: { type: "enum", choices: ["500", "503"], default: "500", description: "Status" },
                delay: { type: "number", min: 0, max: 10 },
                hosts: { type: "stringList" },
                on: { type: "boolean", default: true },
                note: { type: "string", multiline: true },
            },
        },
        { name: "utils", declared: false, enabled: true, values: {}, defs: {} },
    ]);
    const s = schema.properties.params.properties["API mocker"];

    it("types each declared param", () => {
        expect(s.additionalProperties).toBe(false);
        expect(s.properties.enabled.type).toBe("boolean");
        expect(s.properties.status).toEqual({ type: "string", enum: ["500", "503"], default: "500", description: "Status" });
        expect(s.properties.delay).toMatchObject({ type: "number", minimum: 0, maximum: 10, default: 0 });
        expect(s.properties.hosts).toMatchObject({ type: "array", items: { type: "string" }, default: [] });
        expect(s.properties.on).toMatchObject({ type: "boolean", default: true });
        expect(s.properties.note).toMatchObject({ type: "string", default: "" });
    });

    it("skips libraries, keeps unknown names allowed, leaves the base schema untouched", () => {
        expect(schema.properties.params.properties.utils).toBeUndefined();
        expect(schema.properties.params.additionalProperties.type).toBe("object");
        expect((SETTINGS_SCHEMA.properties.params as any).properties).toBeUndefined();
        expect(settingsSchemaJson()).toMatch(/\n$/);
    });
});
