// Folders + JSON data files: path-aware import resolution, JSON imports,
// dependants, stacking order, path validation, settings.yaml keys with `/`
// and bundles.
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";
import { compileWithLibs } from "../src/shared/compile";
import { dependantsOf, importPath, importResolver, makeLibRequire, missingImports } from "../src/shared/scriptImports";
import { stackingOrder, allFolders, movedPath, isInFolder } from "../src/shared/folders";
import { cleanScriptName, dataFilePathProblem, folderPathProblem, scriptFileName, scriptNameProblem } from "../src/shared/scriptName";
import { parseSettings, planSettings, renderSettings, type ScriptSettingsState } from "../src/shared/settingsYaml";
import { patchSettings, renameSettingsSection } from "../src/shared/settingsYamlPatch";
import { buildSettingsSchema } from "../src/shared/settingsSchema";
import { errorPosition } from "../src/ui/problems";
import { buildBundle, parseBundleText, pickBundle } from "../src/ui/bundle";

describe("import paths", () => {
    it("resolves relative to the importer's folder, bare from the root", () => {
        expect(importPath("main", "./utils")).toBe("utils");
        expect(importPath("main", "./mock/rate-limits.json")).toBe("mock/rate-limits.json");
        expect(importPath("mock/helpers", "./data.json")).toBe("mock/data.json");
        expect(importPath("mock/api/x", "../lib/y")).toBe("mock/lib/y");
        expect(importPath("mock/helpers", "../utils")).toBe("utils");
        expect(importPath("mock/helpers", "utils")).toBe("utils");
        expect(importPath("mock/helpers", "lib/x")).toBe("lib/x");
        expect(importPath("main", "../x")).toBeNull();
    });

    it("matches scripts by path or legacy key, data files by path, case-insensitively", () => {
        const r = importResolver(["My Utils", "mock/Helpers", "lib/a b"], ["mock/Rate-Limits.json"]);
        expect(r("main", "./My_Utils")).toEqual({ kind: "script", name: "My Utils" });
        expect(r("main", "./my utils.ts")).toEqual({ kind: "script", name: "My Utils" });
        expect(r("mock/x", "./helpers")).toEqual({ kind: "script", name: "mock/Helpers" });
        expect(r("mock/x", "../lib/a_b.js")).toEqual({ kind: "script", name: "lib/a b" });
        expect(r("main", "./mock/rate-limits.json")).toEqual({ kind: "data", path: "mock/Rate-Limits.json" });
        expect(r("mock/x", "./rate-limits.json")).toEqual({ kind: "data", path: "mock/Rate-Limits.json" });
        expect(r("main", "./rate-limits.json")).toBeUndefined();
        expect(r("main", "./helpers")).toBeUndefined();
    });
});

const LIMIT_SCRIPT = `import limits from "./mock/rate-limits.json";
import { max } from "./mock/rate-limits.json";
export const both = [limits.max, max];
wt.onRequest("*://a.test/*", () => {});`;

describe("JSON data file imports", () => {
    const data = [{ path: "mock/rate-limits.json", text: '{ "max": 7 }' }];

    it("default import is the whole object, a named import a property", () => {
        const c = compileWithLibs({ id: "m", name: "main", code: LIMIT_SCRIPT }, [], {}, data);
        expect(c.error).toBeNull();
        expect(c.deps).toEqual(["mock/rate-limits.json"]);
        expect(c.meta.routes).toHaveLength(1);
    });

    it("libraries in folders import relative to their own folder", () => {
        const lib = { id: "l", name: "mock/helpers", code: `import d from "./rate-limits.json"; export const max = d.max;` };
        const main = { id: "m", name: "main", code: `import { max } from "./mock/helpers";\nwt.params({ n: { type: "number", default: max } });` };
        const c = compileWithLibs(main, [lib], {}, data);
        expect(c.error).toBeNull();
        expect(c.paramDefs?.n.default).toBe(7);
        expect(c.deps.sort()).toEqual(["mock/helpers", "mock/rate-limits.json"]);
    });

    it("parses fresh per import: a mutation doesn't leak", () => {
        const lib = { id: "l", name: "a", code: `import d from "./mock/rate-limits.json"; d.max = 99; export const x = 1;` };
        const main = { id: "m", name: "main", code: `import "./a";\nimport d from "./mock/rate-limits.json";\nwt.params({ n: { type: "number", default: d.max } });` };
        expect(compileWithLibs(main, [lib], {}, data).paramDefs?.n.default).toBe(7);
    });

    it("invalid JSON is the importer's compile error, naming the file and position, at the import line", () => {
        const bad = [{ path: "mock/rate-limits.json", text: '{\n  "max": 7,\n}' }];
        const c = compileWithLibs({ id: "m", name: "main", code: "// x\n" + LIMIT_SCRIPT }, [], {}, bad);
        expect(c.error).toMatch(/cannot import "\.\/mock\/rate-limits\.json": mock\/rate-limits\.json:3:1 is not valid JSON/);
        expect(errorPosition(c.error!)?.line).toBe(2);
    });

    it("a missing data file is a compile error too (never a stub)", () => {
        const c = compileWithLibs({ id: "m", name: "main", code: LIMIT_SCRIPT }, [], {}, []);
        expect(c.error).toMatch(/no data file "mock\/rate-limits\.json"/);
        expect(errorPosition(c.error!)?.line).toBe(1);
    });

    it("a library's data file error surfaces at the importer's import of the library", () => {
        const lib = { id: "l", name: "mock/helpers", code: `import d from "./nope.json"; export const x = d;` };
        const c = compileWithLibs({ id: "m", name: "main", code: `\n\nimport { x } from "./mock/helpers";\nconsole.log(x);` }, [lib], {}, data);
        expect(c.error).toMatch(/no data file "mock\/nope\.json"/);
        expect(errorPosition(c.error!)?.line).toBe(3);
    });

    it("the page-side require resolves the same way", () => {
        const ran: string[] = [];
        const requireFrom = makeLibRequire(
            [
                { name: "mock/helpers", src: "" },
                { name: "mock/rate-limits.json", json: '{"max":3}' },
            ],
            (lib, require, m) => {
                ran.push(lib.name);
                m.exports.max = require("./rate-limits.json").max;
            }
        );
        expect(requireFrom("main")("./mock/helpers").max).toBe(3);
        expect(requireFrom("mock/x")("./helpers.ts").max).toBe(3);
        expect(ran).toEqual(["mock/helpers"]);
        expect(() => requireFrom("main")("./missing.json")).toThrow(/data file/);
    });
});

describe("dependants and missing imports through folders and data files", () => {
    const s = [
        { id: "h", name: "mock/helpers", code: `import d from "./rate-limits.json"; export const x = d;` },
        { id: "a", name: "app", code: `import { x } from "./mock/helpers";` },
        { id: "b", name: "mock/b", code: `import d from "../other.json";` },
        { id: "c", name: "c", code: `import d from "mock/rate-limits.json";` },
    ];
    it("finds importers of a data file, transitively", () => {
        expect(dependantsOf("mock/rate-limits.json", s, "data").sort()).toEqual(["a", "c", "h"]);
        expect(dependantsOf("Other.json", s, "data")).toEqual(["b"]);
        expect(dependantsOf("mock/helpers", s)).toEqual(["a"]);
    });
    it("counts a picked script's data files as dependencies", () => {
        const items = [
            { name: "mock/helpers", code: s[0].code },
            { name: "app", code: s[1].code },
            { name: "mock/rate-limits.json", code: "{}", data: true },
            { name: "other.json", code: "{}", data: true },
        ];
        expect(missingImports([1], items)).toEqual([0, 2]);
        expect(missingImports([0, 1, 2], items)).toEqual([]);
    });
});

describe("stacking order with folders", () => {
    const n = (name: string) => ({ name });
    it("is unchanged for root-only setups", () => {
        const list = [n("b"), n("a"), n("c")];
        expect(stackingOrder(list, (x) => x.name)).toBe(list);
    });
    it("is depth-first: subfolders (alphabetical) before a folder's scripts (stored order)", () => {
        const list = [n("z"), n("mock/b"), n("a"), n("Lib/x"), n("mock/a"), n("mock/api/q"), n("lib/y")];
        expect(stackingOrder(list, (x) => x.name).map((x) => x.name)).toEqual(["Lib/x", "lib/y", "mock/api/q", "mock/b", "mock/a", "z", "a"]);
    });
    it("knows explicit (empty) folders and moves paths", () => {
        expect(allFolders(["e/f"], ["a/b/c", "x"])).toEqual(["a", "a/b", "e", "e/f"]);
        expect(movedPath("Mock/a/b", "mock", "fixtures")).toBe("fixtures/a/b");
        expect(isInFolder("mockery/a", "mock")).toBe(false);
    });
});

describe("names are paths", () => {
    it("validates each segment", () => {
        expect(scriptNameProblem("mock/helpers")).toBe("");
        expect(scriptNameProblem("mock/api/My helpers (v2)")).toBe("");
        expect(scriptNameProblem("/x")).toMatch(/empty/);
        expect(scriptNameProblem("x/")).toMatch(/empty/);
        expect(scriptNameProblem("a//b")).toMatch(/empty/);
        expect(scriptNameProblem("../x")).toMatch(/"\.\."/);
        expect(scriptNameProblem("a/./x")).toMatch(/"\."/);
        expect(scriptNameProblem(".hidden/x")).toMatch(/dot/);
        expect(scriptNameProblem("a:b/x")).toMatch(/contain/);
        expect(scriptNameProblem("con/x")).toMatch(/reserved/);
        expect(scriptNameProblem("a /x")).toMatch(/end with/);
        expect(scriptNameProblem("x".repeat(101))).toMatch(/at most/);
        expect(scriptNameProblem(("x".repeat(90) + "/").repeat(5) + "x")).toMatch(/paths are at most/);
    });
    it("validates data file and folder paths", () => {
        expect(dataFilePathProblem("mock/rate-limits.json")).toBe("");
        expect(dataFilePathProblem("mock/rate-limits")).toMatch(/\.json/);
        expect(dataFilePathProblem("mock/.json")).toMatch(/just/);
        expect(dataFilePathProblem("package.json")).toMatch(/reserved/);
        expect(dataFilePathProblem("a/tsconfig.base.json")).toMatch(/reserved/);
        expect(dataFilePathProblem("settings.schema.json")).toMatch(/reserved/);
        expect(dataFilePathProblem("a/settings.schema.json")).toBe("");
        expect(folderPathProblem("mock/api")).toBe("");
        expect(folderPathProblem("mock/.git")).toMatch(/dot/);
        expect(folderPathProblem("")).toMatch(/empty/);
    });
    it("keeps / when cleaning typed names and maps paths to files", () => {
        expect(cleanScriptName("mock/a:b")).toBe("mock/ab");
        expect(scriptFileName("mock/helpers")).toBe("mock/helpers.ts");
        expect(scriptFileName("a:b/c?")).toBe("a_b/c_.ts");
    });
});

describe("settings.yaml keys with /", () => {
    const s: ScriptSettingsState = { name: "mock/helpers", declared: true, enabled: true, defs: { n: { type: "number", default: 1 } } as any, values: {} };
    const G = { logLevel: "info", logCap: 500, defaultStrategy: "helper" } as any;
    it("renders, parses and plans a path-named section", () => {
        const t = renderSettings(G, [{ ...s, enabled: false, values: { n: 3 } }]);
        expect(t).toContain("  mock/helpers:\n");
        expect(parseSettings(t).params["mock/helpers"]).toEqual({ enabled: false, n: 3 });
        expect(planSettings(parseSettings(t), G, [{ ...s, enabled: false, values: { n: 3 } }])).toEqual({ globals: {}, scripts: [] });
    });
    it("patches and renames it in place", () => {
        const t = "params:\n  mock/helpers:\n    n: 2\n";
        expect(patchSettings(t, G, [{ ...s, values: { n: 4 } }])).toBe("params:\n  mock/helpers:\n    n: 4\n");
        expect(renameSettingsSection(t, "mock/helpers", "fixtures/helpers")).toBe("params:\n  fixtures/helpers:\n    n: 2\n");
    });
    it("is a schema property name", () => {
        const schema: any = buildSettingsSchema([s]);
        expect(Object.keys(schema.properties.params.properties)).toContain("mock/helpers");
    });
});

describe("bundles carry data files and folders", () => {
    it("round-trips them and picks a subset", () => {
        const text = buildBundle({ settings: null, params: {} }, [{ name: "mock/a", code: "x" }], [{ path: "mock/d.json", text: '{"a":1}' }], ["empty"]);
        const b = parseBundleText(text)!;
        expect(b.scripts).toEqual([{ name: "mock/a", code: "x" }]);
        expect(b.dataFiles).toEqual([{ path: "mock/d.json", text: '{"a":1}' }]);
        expect(b.folders).toEqual(["empty"]);
        expect(pickBundle(b, false, [], [0])).toEqual({ scripts: [], dataFiles: b.dataFiles, folders: ["empty"] });
        expect(pickBundle(b, false, [0])).toEqual({ scripts: b.scripts, folders: ["empty"] });
    });
});
