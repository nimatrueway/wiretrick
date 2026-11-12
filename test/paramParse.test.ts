/**
 * Param `parse`: the script sees the parser's result, typed as its return
 * type; storage, settings.yaml, the schema and messaging keep the raw
 * value and never see the function.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import "../src/shared/transpile";
import { compileScript, compileWithLibs } from "../src/shared/compile";
import { makePageShim } from "../src/shared/pageShim";
import { parseParamValue, serializableParamDef } from "../src/shared/scriptDef";
import { formatScriptError } from "../src/shared/scriptError";
import { renderSettings, parseSettings, planSettings } from "../src/shared/settingsYaml";
import { buildSettingsSchema } from "../src/shared/settingsSchema";
import { settingsDiagnostics } from "../src/shared/settingsAssist";

const CODE = `
const cfg = tt.params({
    origin: { type: "string", default: "https://a.com", parse: (s) => new URL(s) },
    n: { type: "number", default: 2, parse: (sec) => sec * 1000 },
    plain: { type: "boolean" },
});
const hosts = tt.defineParam("hosts", { type: "stringList", default: ["a.com"], parse: (l) => new Set(l) });
const mode = tt.defineParam("mode", { type: "enum", choices: ["x", "y"], parse: (c) => c.toUpperCase() });
tt.log(cfg.origin.host, cfg.n, cfg.plain, [...hosts].join("+"), mode);
tt.onRequest({ url: \`*://\${cfg.origin.host}/*\`, strategy: "helper" }, () => {});
`;

function logged(code: string, paramValues?: Record<string, any>) {
    const lines: string[] = [];
    const c = compileScript(code, { paramValues, logSink: (_l, _s, text) => lines.push(text) });
    return { c, lines };
}

describe("param parse (runtime)", () => {
    it("the script receives parsed values (defaults and stored values)", () => {
        expect(logged(CODE).lines).toEqual(["a.com 2000 false a.com X"]);
        const { c, lines } = logged(CODE, { origin: "https://b.org/x", n: 3, hosts: ["p", "q"], mode: "y" });
        expect(c.error).toBeNull();
        expect(lines).toEqual(["b.org 3000 false p+q Y"]);
        expect(c.meta.match).toEqual(["*://b.org/*"]);
    });

    it("an invalid stored value falls back to the default before parsing", () => {
        expect(logged(CODE, { origin: 42, mode: "nope" }).lines).toEqual(["a.com 2000 false a.com X"]);
    });

    it("strips parse from the collected defs (structured-clone / JSON safe)", () => {
        const { c } = logged(CODE);
        for (const d of Object.values(c.paramDefs!)) expect("parse" in d).toBe(false);
        expect(c.paramDefs!.origin).toEqual({ type: "string", default: "https://a.com" });
        expect(() => structuredClone(c.paramDefs)).not.toThrow();
        // the save-time compile (scriptStore / sandbox compileOne) too
        const w = compileWithLibs({ id: "s", name: "s", code: CODE }, []);
        expect(JSON.stringify(w.paramDefs)).not.toContain("parse");
        expect(() => structuredClone({ meta: w.meta, paramDefs: w.paramDefs, error: w.error, deps: w.deps })).not.toThrow();
    });

    it("the parser gets a copy of list values", () => {
        const stored = { l: ["a"] };
        compileScript(`tt.defineParam("l", { type: "stringList", parse: (l) => { l.push("x"); return l; } });`, { paramValues: stored });
        expect(stored.l).toEqual(["a"]);
    });

    it("a throwing parser is a script error naming the param and value", () => {
        const { c } = logged(CODE, { origin: "xyz" });
        expect(c.error).toMatch(/^Error: param "origin": parse failed for value "xyz": Invalid URL/);
        expect(c.meta.active).toBe(false);
        expect(c.paramDefs!.origin).toBeDefined(); // the ⚙ dialog can still fix the value
        expect(formatScriptError("my script", c.error).split("\n")[0]).toMatch(/^\[my script\] Error: param "origin": parse failed for value "xyz": Invalid URL/);
        expect(compileScript(`tt.defineParam("a", { type: "number", parse: () => { throw "nope"; } });`).error).toMatch(/param "a": parse failed for value 0: nope/);
        expect(compileScript(`tt.defineParam("a", { type: "number", parse: 5 });`).error).toMatch(/param "a": parse must be a function/);
    });

    it("helpers: serializableParamDef / parseParamValue", () => {
        const def = { type: "string" as const, parse: (s: string) => s.length };
        expect(serializableParamDef(def)).toEqual({ type: "string" });
        expect(def.parse).toBeTypeOf("function"); // original untouched
        expect(serializableParamDef({ type: "number" })).toEqual({ type: "number" });
        expect(parseParamValue("k", def, "abc")).toBe(3);
        expect(parseParamValue("k", { type: "string" }, "abc")).toBe("abc");
    });

    it("page (onDocument) shim parses the raw bundle values", () => {
        const { tt } = makePageShim({ params: { origin: "https://p.dev", hosts: ["h"] }, log: () => {}, storage: { get: () => undefined, set: () => undefined } });
        const cfg = tt.params({ origin: { type: "string", parse: (s: string) => new URL(s) } });
        expect(cfg.origin).toBeInstanceOf(URL);
        expect(cfg.origin.host).toBe("p.dev");
        expect(tt.defineParam("hosts", { type: "stringList", parse: (l: string[]) => new Set(l) })).toEqual(new Set(["h"]));
        expect(() => tt.params({ origin: { type: "string", parse: () => { throw new Error("bad"); } } })).toThrow('param "origin": parse failed for value "https://p.dev": bad');
    });
});

describe("param parse (settings keep raw values)", () => {
    it("settings.yaml export/import and the schema see raw values only", () => {
        const { c } = logged(CODE, { origin: "https://b.org" });
        const state = { name: "s", declared: true, enabled: true, defs: c.paramDefs!, values: { origin: "https://b.org", hosts: ["p"] } };
        const G = { logLevel: "info", logCap: 500 } as const;
        const yaml = renderSettings(G, [state]);
        expect(yaml).toContain("origin: https://b.org");
        expect(yaml).not.toMatch(/parse|=>/);
        const plan = planSettings(parseSettings(yaml.replace("https://b.org", "https://c.net")), G, [state]);
        expect(plan.scripts).toEqual([{ name: "s", params: { origin: "https://c.net" } }]);
        const schema = JSON.stringify(buildSettingsSchema([state]));
        expect(schema).not.toContain("parse");
    });
});

// ---- typings: run the TS compiler over tt-api.d.ts + snippets ----

const DTS = readFileSync(new URL("../src/types/tt-api.d.ts", import.meta.url), "utf8");

function typesOf(snippet: string): { errors: string[]; types: Record<string, string> } {
    const files: Record<string, string> = { "/tt-api.d.ts": DTS, "/snippet.ts": snippet };
    const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], types: [], skipLibCheck: true };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, lang, ...rest) => (name in files ? ts.createSourceFile(name, files[name], lang) : getSourceFile.call(host, name, lang, ...rest));
    host.fileExists = ((exists) => (name: string) => name in files || exists(name))(host.fileExists);
    host.readFile = ((read) => (name: string) => files[name] ?? read(name))(host.readFile);
    const program = ts.createProgram(["/tt-api.d.ts", "/snippet.ts"], options, host);
    const sf = program.getSourceFile("/snippet.ts")!;
    const errors = ts.getPreEmitDiagnostics(program, sf).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    const checker = program.getTypeChecker();
    const types: Record<string, string> = {};
    const visit = (n: ts.Node) => {
        if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) types[n.name.text] = checker.typeToString(checker.getTypeAtLocation(n.name));
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { errors, types };
}

describe("param parse (typings)", () => {
    it("contextually types the parser and resolves to its return type", () => {
        const { errors, types } = typesOf(`export {};
const cfg = tt.params({
    origin: { type: "string", default: "https://a.com", parse: (s) => new URL(s) },
    n: { type: "number" },
    secs: { type: "number", parse: (sec) => sec * 1000 },
    on: { type: "boolean", parse: (b) => (b ? "yes" : "no") },
    mode: { type: "enum", choices: ["a", "b"], parse: (c) => ({ c }) },
    plainMode: { type: "enum", choices: ["a", "b"] },
    list: { type: "stringList" },
});
const origin = cfg.origin, n = cfg.n, secs = cfg.secs, on = cfg.on, mode = cfg.mode, plainMode = cfg.plainMode, list = cfg.list;
const hosts = tt.defineParam("hosts", { type: "stringList", parse: (l) => new Set(l) });
const host = tt.defineParam("host", { type: "string" });
`);
        expect(errors).toEqual([]);
        expect(types).toMatchObject({
            s: "string",
            sec: "number",
            b: "boolean",
            c: "string",
            l: "string[]",
            origin: "URL",
            n: "number",
            secs: "number",
            on: '"yes" | "no"',
            mode: "{ c: string; }",
            plainMode: '"a" | "b"',
            list: "string[]",
            hosts: "Set<string>",
            host: "string",
        });
    });

    it("params without parse are assignable, with their raw type; with parse, read-only", () => {
        const ok = typesOf(`export {};
const cfg = tt.params({ on: { type: "boolean" }, mode: { type: "enum", choices: ["a", "b"] }, list: { type: "stringList" } });
cfg.on = false;
cfg.mode = "b";
cfg.list.push("x");
`);
        expect(ok.errors).toEqual([]);
        const bad = typesOf(`export {};
const cfg = tt.params({ mode: { type: "enum", choices: ["a", "b"] }, url: { type: "string", parse: (s) => new URL(s) } });
cfg.mode = "c";
cfg.url = new URL("https://a.com");
`);
        expect(bad.errors.join("\n")).toMatch(/"c"' is not assignable/);
        expect(bad.errors.join("\n")).toMatch(/read-only property/);
    });

    it("rejects a parser whose input doesn't match the param type", () => {
        const { errors } = typesOf(`tt.params({ n: { type: "number", parse: (s: string) => s } });`);
        expect(errors.join("\n")).toMatch(/not assignable/);
    });
});

describe("shortcut params", () => {
    const CODE = `const k = tt.defineParam("toggle", { type: "shortcut", default: "Alt+Shift+H", description: "Hide the box" });
tt.log(JSON.stringify(k));
tt.onRequest({ url: "*://a.com/*", strategy: "helper" }, () => {});`;

    it("the script gets the keys: the default, a stored value, \"\" when cleared; invalid stored keys fall back", () => {
        expect(logged(CODE).lines).toEqual(['"Alt+Shift+H"']);
        expect(logged(CODE, { toggle: "Mod+K" }).lines).toEqual(['"Mod+K"']);
        expect(logged(CODE, { toggle: "" }).lines).toEqual(['""']);
        expect(logged(CODE, { toggle: "Hyper+K" }).lines).toEqual(['"Alt+Shift+H"']);
        expect(logged(CODE).c.paramDefs).toEqual({ toggle: { type: "shortcut", default: "Alt+Shift+H", description: "Hide the box" } });
    });

    it("a default that isn't a shortcut is a script error", () => {
        const { c } = logged(`tt.params({ k: { type: "shortcut", default: "Hyper+K" } });`);
        expect(c.error).toMatch(/shortcut parameter "k": "Hyper\+K" has an unknown modifier "Hyper"/);
    });

    it("settings.yaml: documented with an example, typed as a string in the schema, bad keys flagged", () => {
        const defs = { toggle: { type: "shortcut", default: "Alt+Shift+H", description: "Hide the box" } } as const;
        const text = renderSettings({ logLevel: "warn", logCap: 500 }, [{ name: "s", enabled: true, declared: true, defs, values: { toggle: "Mod+K" } }]);
        expect(text).toMatch(/Hide the box \(keys, e\.g\. Mod\+Shift\+K\)/);
        expect(text).toMatch(/toggle: Mod\+K/);
        const schema: any = buildSettingsSchema([{ name: "s", enabled: true, declared: true, defs, values: {} }]);
        expect(schema.properties.params.properties.s.properties.toggle).toMatchObject({ type: "string", default: "Alt+Shift+H" });
        const bad = 'params:\n  s:\n    toggle: "Hyper+K"\n';
        expect(settingsDiagnostics(bad, [{ name: "s", declared: true, defs }]).map((d) => d.message)).toEqual(['Expected keys like "Mod+Shift+K" (or "" for none) — this value is ignored']);
        expect(settingsDiagnostics('params:\n  s:\n    toggle: ""\n', [{ name: "s", declared: true, defs }])).toEqual([]);
    });
});
