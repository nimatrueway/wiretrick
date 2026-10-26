import { describe, it, expect } from "vitest";
import { settingsDiagnostics, settingsCompletions, settingsHover, type AssistScript } from "../src/shared/settingsAssist";

const scripts: AssistScript[] = [
    { name: "API mocker", declared: true, defs: { status: { type: "enum", choices: ["500", "503"], default: "500", description: "HTTP status" }, delay: { type: "number", min: 0, max: 10, description: "Seconds" } } },
    { name: "utils", declared: false, defs: {} },
];
const labels = (t: string, s = scripts) => {
    const i = t.indexOf("|");
    return settingsCompletions(t.replace("|", ""), i, s).items.map((x) => x.label);
};
const msgs = (t: string) => settingsDiagnostics(t, scripts).map((d) => `${d.severity}:${d.message}`);

describe("settings.yaml diagnostics", () => {
    it("clean doc has none", () => {
        expect(msgs(`settings:\n  logLevel: info\n  logCap: 500\nparams:\n  API mocker:\n    enabled: true\n    status: "503"\n    delay: 2\n`)).toEqual([]);
        expect(msgs(`settings:\nparams:\n  API mocker:\n`)).toEqual([]);
        expect(msgs(``)).toEqual([]);
    });
    it("flags syntax errors", () => {
        expect(msgs(`settings:\n  logLevel: [\n`)[0]).toMatch(/^error:/);
    });
    it("flags bad values, unknown keys and scripts", () => {
        const t = `settings:\n  logLevel: loud\n  logCap: 5\n  colour: red\nparams:\n  API mocker:\n    enabled: 1\n    status: "404"\n    delay: 99\n    nope: 1\n  Ghost:\n    x: 1\n  utils:\n    enabled: true\nextra: 1\n`;
        const m = msgs(t);
        expect(m).toContain("error:Expected one of debug | info | warn | error");
        expect(m).toContain("error:Expected an integer between 100 and 10000");
        expect(m.some((x) => x.startsWith('warning:Unknown setting "colour"'))).toBe(true);
        expect(m).toContain("error:Expected true or false");
        expect(m.some((x) => x.startsWith('error:Expected "500" | "503"'))).toBe(true);
        expect(m.some((x) => x.startsWith("warning:Outside number (0…10)"))).toBe(true);
        expect(m.some((x) => x.startsWith('warning:"API mocker" declares no param "nope"'))).toBe(true);
        expect(m).toContain('warning:No script named "Ghost" — ignored');
        expect(m.some((x) => x.includes("is a library"))).toBe(true);
        expect(m.some((x) => x.startsWith('warning:Unknown top-level key "extra"'))).toBe(true);
    });
    it("ranges point at the offending node", () => {
        const t = `settings:\n  logLevel: loud\n`;
        const [d] = settingsDiagnostics(t, scripts);
        expect(t.slice(d.start, d.end)).toBe("loud");
    });
});

describe("settings.yaml completion", () => {
    it("top level, skipping present keys", () => {
        expect(labels(`|`)).toEqual(["settings", "params"]);
        expect(labels(`settings:\n  logCap: 500\n|`)).toEqual(["params"]);
    });
    it("global keys and values", () => {
        expect(labels(`settings:\n  |`)).toEqual(["logLevel", "logCap", "defaultStrategy", "textTypes", "bodyCap"]);
        expect(labels(`settings:\n  logCap: 500\n  |`)).toEqual(["logLevel", "defaultStrategy", "textTypes", "bodyCap"]);
        expect(labels(`settings:\n  defaultStrategy: |`)).toEqual(["helper", "page", "extension", "debugger", "rules"]);
        expect(labels(`settings:\n  logLevel: |`)).toEqual(["debug", "info", "warn", "error"]);
        expect(labels(`settings:\n  logLevel: in|`)).toEqual(["debug", "info", "warn", "error"]);
    });
    it("script names, params and enum values", () => {
        expect(labels(`params:\n  |`)).toEqual(["API mocker", "utils"]);
        expect(labels(`params:\n  API mocker:\n    |`)).toEqual(["enabled", "status", "delay"]);
        expect(labels(`params:\n  utils:\n    |`)).toEqual([]);
        expect(labels(`params:\n  API mocker:\n    status: |`)).toEqual(['"500"', '"503"']);
        expect(labels(`params:\n  API mocker:\n    enabled: |`)).toEqual(["true", "false"]);
    });
    it("replaces the partially typed word", () => {
        const t = `settings:\n  logL`;
        expect(settingsCompletions(t, t.length, scripts).replaceFrom).toBe(t.length - 4);
    });
});

describe("settings.yaml hover", () => {
    it("describes globals, scripts and params", () => {
        const t = `settings:\n  logCap: 500\nparams:\n  API mocker:\n    status: "500"\n`;
        expect(settingsHover(t, t.indexOf("logCap") + 2, scripts)?.markdown).toMatch(/Log lines kept/);
        expect(settingsHover(t, t.indexOf("API mocker") + 2, scripts)?.markdown).toMatch(/`status`: "500" \| "503" — HTTP status/);
        const h = settingsHover(t, t.indexOf("status") + 1, scripts)!;
        expect(h.markdown).toMatch(/HTTP status/);
        expect(t.slice(h.start, h.end)).toBe("status");
    });
});
