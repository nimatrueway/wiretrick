// Package imports type-check like in the editor (Monaco's TS worker: files
// are extra libs keyed file:///…, no directoryExists, every lib a root
// file) and in the synced folder (real tsc with the generated tsconfig).
import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { editorCompilerOptions } from "../src/ui/monacoSetup";
import { tsconfigText } from "../src/shared/generatedFiles";
import { TYPINGS_ROOT, type StoredTypings } from "../src/shared/packageImports";
import { fakeUnpkg, REGISTRY } from "./fakeUnpkg";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

const SCRIPT = `import twice, { add } from "https://unpkg.com/esm-lib@1.0.0";
import { add as add2 } from "https://unpkg.com/esm-lib@1.0.0/math.js";
import { go } from "https://unpkg.com/exp-lib@1.0.0";
import { sub } from "https://unpkg.com/exp-lib@1.0.0/sub";
import { shout } from "https://unpkg.com/cjs-lib@2.0.0";
import untyped from "https://unpkg.com/umd-lib@1.0.0";
const a: number = twice(add(1, add2(2, sub)));
const b: string = add(1, 2);
const c: string = go().upper(shout("x")) + EXP_LIB_GLOBAL;
const d: number = shout("x");
untyped.anything(a, b, c, d);
`;
/** the two type errors SCRIPT has: line (1-based) and code */
const EXPECTED = [
    { line: 8, code: 2322 },
    { line: 10, code: 2322 },
];

let typings: StoredTypings;

beforeAll(async () => {
    (globalThis as any).fetch = fakeUnpkg(REGISTRY).fetch;
    const p = await import("../src/background/engine/packageImports");
    await p.ensurePackages([SCRIPT]);
    await p.packageTypingsIdle();
    typings = p.packageTypings();
    expect(Object.keys(typings.tops)).toHaveLength(6);
});

const errorsOf = (diags: readonly ts.Diagnostic[]) =>
    diags.map((d) => ({ line: d.file!.getLineAndCharacterOfPosition(d.start!).line + 1, code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, "\n") }));

describe("package import typings", () => {
    it("resolve in the editor (Monaco's TS worker host)", () => {
        const files = new Map<string, string>(Object.entries(typings.files).map(([p, text]) => [`file:///${TYPINGS_ROOT}/${p}`, text]));
        const main = "file:///main.ts";
        files.set(main, SCRIPT);
        const libDir = dirname(ts.getDefaultLibFilePath({}));
        // lib.*.d.ts come from Monaco's bundled lib map; here from the typescript package
        const read = (path: string) => files.get(path) ?? (path.startsWith(libDir) ? ts.sys.readFile(path) : undefined);
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => editorCompilerOptions(ts) as ts.CompilerOptions,
            getScriptFileNames: () => [...files.keys()],
            getScriptVersion: () => "1",
            getScriptSnapshot: (f) => {
                const t = read(f);
                return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
            },
            // like Monaco without allowJs: every file (package.json too) parses as TS
            getScriptKind: () => ts.ScriptKind.TS,
            getCurrentDirectory: () => "",
            getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
            readFile: read,
            fileExists: (f) => read(f) !== undefined,
        };
        const ls = ts.createLanguageService(host);
        const errors = errorsOf([...ls.getSyntacticDiagnostics(main), ...ls.getSemanticDiagnostics(main)]);
        expect(errors.map(({ line, code }) => ({ line, code }))).toEqual(EXPECTED);
        expect(errors[0].text).toMatch(/'number' is not assignable to type 'string'/);
        const resolve = (spec: string) =>
            ts.resolveModuleName(spec, main, host.getCompilationSettings(), { fileExists: host.fileExists, readFile: read, getCurrentDirectory: () => "" }).resolvedModule?.resolvedFileName;
        const at = (p: string) => `file:///${TYPINGS_ROOT}/unpkg.com/${p}`;
        expect(resolve("https://unpkg.com/cjs-lib@2.0.0")).toBe(at("@types/cjs-lib@2.0.1/index.d.ts"));
        expect(resolve("https://unpkg.com/esm-lib@1.0.0/math.js")).toBe(at("esm-lib@1.0.0/math.d.ts"));
        expect(resolve("https://unpkg.com/umd-lib@1.0.0")).toMatch(/^file:\/\/\/.*umd-lib@1\.0\.0\/.*\.d\.ts$/);
    });

    it("resolve in the synced folder with the generated tsconfig (real tsc)", () => {
        const dir = mkdtempSync(join(process.cwd(), ".tmp-package-typings-"));
        try {
            writeFileSync(join(dir, "tsconfig.json"), tsconfigText());
            writeFileSync(join(dir, "main.ts"), SCRIPT);
            for (const [p, text] of Object.entries(typings.files)) {
                const f = join(dir, TYPINGS_ROOT, p);
                mkdirSync(dirname(f), { recursive: true });
                writeFileSync(f, text);
            }
            const cfg = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
            expect(cfg.error).toBeUndefined();
            const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir);
            // the typings aren't scripts: only main.ts is a root
            expect(parsed.fileNames).toEqual([join(dir, "main.ts")]);
            const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, types: [] } });
            const errors = errorsOf(ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName.endsWith("main.ts")));
            expect(errors.map(({ line, code }) => ({ line, code }))).toEqual(EXPECTED);
            expect(ts.getPreEmitDiagnostics(program).filter((d) => !d.file)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
