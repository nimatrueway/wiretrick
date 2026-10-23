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

const CODE = `
const cfg = wt.params({
    origin: { type: "string", default: "https://a.com", parse: (s) => new URL(s) },
    n: { type: "number", default: 2, parse: (sec) => sec * 1000 },
    plain: { type: "boolean" },
});
const hosts = wt.defineParam("hosts", { type: "stringList", default: ["a.com"], parse: (l) => new Set(l) });
const mode = wt.defineParam("mode", { type: "enum", choices: ["x", "y"], parse: (c) => c.toUpperCase() });
wt.log(cfg.origin.host, cfg.n, cfg.plain, [...hosts].join("+"), mode);
wt.onRequest(\`*://\${cfg.origin.host}/*\`, () => {});
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
        compileScript(`wt.defineParam("l", { type: "stringList", parse: (l) => { l.push("x"); return l; } });`, { paramValues: stored });
        expect(stored.l).toEqual(["a"]);
    });

    it("a throwing parser is a script error naming the param and value", () => {
        const { c } = logged(CODE, { origin: "xyz" });
        expect(c.error).toMatch(/^Error: param "origin": parse failed for value "xyz": Invalid URL/);
        expect(c.meta.active).toBe(false);
        expect(c.paramDefs!.origin).toBeDefined(); // the ⚙ dialog can still fix the value
        expect(formatScriptError("my script", c.error).split("\n")[0]).toMatch(/^\[my script\] Error: param "origin": parse failed for value "xyz": Invalid URL/);
        expect(compileScript(`wt.defineParam("a", { type: "number", parse: () => { throw "nope"; } });`).error).toMatch(/param "a": parse failed for value 0: nope/);
        expect(compileScript(`wt.defineParam("a", { type: "number", parse: 5 });`).error).toMatch(/param "a": parse must be a function/);
    });

    it("helpers: serializableParamDef / parseParamValue", () => {
        const def = { type: "string" as const, parse: (s: string) => s.length };
        expect(serializableParamDef(def)).toEqual({ type: "string" });
        expect(def.parse).toBeTypeOf("function"); // original untouched
        expect(serializableParamDef({ type: "number" })).toEqual({ type: "number" });
        expect(parseParamValue("k", def, "abc")).toBe(3);
        expect(parseParamValue("k", { type: "string" }, "abc")).toBe("abc");
    });

    it("page (onDom) shim parses the raw bundle values", () => {
        const { wt } = makePageShim({ params: { origin: "https://p.dev", hosts: ["h"] }, log: () => {}, storage: { get: () => undefined, set: () => undefined } });
        const cfg = wt.params({ origin: { type: "string", parse: (s: string) => new URL(s) } });
        expect(cfg.origin).toBeInstanceOf(URL);
        expect(cfg.origin.host).toBe("p.dev");
        expect(wt.defineParam("hosts", { type: "stringList", parse: (l: string[]) => new Set(l) })).toEqual(new Set(["h"]));
        expect(() => wt.params({ origin: { type: "string", parse: () => { throw new Error("bad"); } } })).toThrow('param "origin": parse failed for value "https://p.dev": bad');
    });
});

describe("param parse (settings keep raw values)", () => {
    it("settings.yaml export/import and the schema see raw values only", () => {
        const { c } = logged(CODE, { origin: "https://b.org" });
        const state = { name: "s", declared: true, enabled: true, defs: c.paramDefs!, values: { origin: "https://b.org", hosts: ["p"] } };
        const G = { logLevel: "info", logCap: 500, defaultStrategy: "helper" } as const;
        const yaml = renderSettings(G, [state]);
        expect(yaml).toContain("origin: https://b.org");
        expect(yaml).not.toMatch(/parse|=>/);
        const plan = planSettings(parseSettings(yaml.replace("https://b.org", "https://c.net")), G, [state]);
        expect(plan.scripts).toEqual([{ name: "s", params: { origin: "https://c.net" } }]);
        const schema = JSON.stringify(buildSettingsSchema([state]));
        expect(schema).not.toContain("parse");
    });
});

// ---- typings: run the TS compiler over wt-api.d.ts + snippets ----

const DTS = readFileSync(new URL("../src/types/wt-api.d.ts", import.meta.url), "utf8");

function typesOf(snippet: string): { errors: string[]; types: Record<string, string> } {
    const files: Record<string, string> = { "/wt-api.d.ts": DTS, "/snippet.ts": snippet };
    const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], types: [], skipLibCheck: true };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, lang, ...rest) => (name in files ? ts.createSourceFile(name, files[name], lang) : getSourceFile.call(host, name, lang, ...rest));
    host.fileExists = ((exists) => (name: string) => name in files || exists(name))(host.fileExists);
    host.readFile = ((read) => (name: string) => files[name] ?? read(name))(host.readFile);
    const program = ts.createProgram(["/wt-api.d.ts", "/snippet.ts"], options, host);
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
const cfg = wt.params({
    origin: { type: "string", default: "https://a.com", parse: (s) => new URL(s) },
    n: { type: "number" },
    secs: { type: "number", parse: (sec) => sec * 1000 },
    on: { type: "boolean", parse: (b) => (b ? "yes" : "no") },
    mode: { type: "enum", choices: ["a", "b"], parse: (c) => ({ c }) },
    plainMode: { type: "enum", choices: ["a", "b"] },
    list: { type: "stringList" },
});
const origin = cfg.origin, n = cfg.n, secs = cfg.secs, on = cfg.on, mode = cfg.mode, plainMode = cfg.plainMode, list = cfg.list;
const hosts = wt.defineParam("hosts", { type: "stringList", parse: (l) => new Set(l) });
const host = wt.defineParam("host", { type: "string" });
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

    it("rejects a parser whose input doesn't match the param type", () => {
        const { errors } = typesOf(`wt.params({ n: { type: "number", parse: (s: string) => s } });`);
        expect(errors.join("\n")).toMatch(/not assignable/);
    });
});
