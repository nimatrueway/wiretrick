// Package imports type-check like in the editor (Monaco's TS worker: files
// are extra libs keyed file:///…, no directoryExists, every lib a root
// file) and in the synced folder (real tsc with the generated tsconfig).
import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import ts from "typescript";
import { editorCompilerOptions } from "../src/ui/monacoSetup";
import { BUILTIN_TYPINGS_ROOT, tsconfigText } from "../src/shared/generatedFiles";
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

    it("the built-in valtio and React typings resolve in the editor (what build.mjs ships in builtin-types.json)", () => {
        const files = new Map<string, string>();
        const add = (dir: string, test: (f: string) => boolean) => {
            for (const f of readdirSync(join("node_modules", dir), { recursive: true }) as string[])
                if (test(f)) files.set(`file:///node_modules/${dir}/${f.split(sep).join("/")}`, readFileSync(join("node_modules", dir, f), "utf8"));
        };
        add("valtio/esm", (f) => f.endsWith(".d.mts"));
        add("@types/react", (f) => ["index.d.ts", "global.d.ts", "jsx-runtime.d.ts", "jsx-dev-runtime.d.ts"].includes(f));
        add("@types/react-dom", (f) => ["index.d.ts", "client.d.ts"].includes(f));
        add("csstype", (f) => f === "index.d.ts");
        const main = "file:///main.ts";
        files.set(
            main,
            `import { proxy, useSnapshot, subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
import { useSnapshot as use2 } from "valtio/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
const s = proxy({ n: 1 });
subscribe(s, () => {});
subscribeKey(s, "n", (v: number) => v);
export function App() { const snap = useSnapshot(s); const [x] = useState(0); return snap.n + x + use2(s).n; }
createRoot(document.body);
const bad: string = useSnapshot(s).n;
`
        );
        const libDir = dirname(ts.getDefaultLibFilePath({}));
        const read = (path: string) => files.get(path) ?? (path.startsWith(libDir) ? ts.sys.readFile(path) : undefined);
        const ls = ts.createLanguageService({
            getCompilationSettings: () => editorCompilerOptions(ts) as ts.CompilerOptions,
            getScriptFileNames: () => [...files.keys()],
            getScriptVersion: () => "1",
            getScriptSnapshot: (f) => {
                const t = read(f);
                return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
            },
            getScriptKind: () => ts.ScriptKind.TS,
            getCurrentDirectory: () => "",
            getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
            readFile: read,
            fileExists: (f) => read(f) !== undefined,
        });
        const errors = errorsOf([...ls.getSyntacticDiagnostics(main), ...ls.getSemanticDiagnostics(main)]);
        expect(errors.map(({ line, code }) => ({ line, code }))).toEqual([{ line: 11, code: 2322 }]);
    });

    it("the built-ins (valtio, React) resolve in the synced folder too, in .ts and .tsx files (real tsc)", () => {
        const dir = mkdtempSync(join(process.cwd(), ".tmp-builtin-typings-"));
        try {
            writeFileSync(join(dir, "tsconfig.json"), tsconfigText());
            // as folder sync writes lib/builtin-types.json (keys as build.mjs makes them)
            const put = (mod: string, test: (f: string) => boolean) => {
                for (const f of readdirSync(join("node_modules", mod), { recursive: true }) as string[]) {
                    if (!test(f)) continue;
                    const to = join(dir, BUILTIN_TYPINGS_ROOT, mod, f);
                    mkdirSync(dirname(to), { recursive: true });
                    writeFileSync(to, readFileSync(join("node_modules", mod, f), "utf8"));
                }
            };
            put("valtio/esm", (f) => f.endsWith(".d.mts"));
            put("@types/react", (f) => ["index.d.ts", "global.d.ts", "jsx-runtime.d.ts", "jsx-dev-runtime.d.ts"].includes(f));
            put("@types/react-dom", (f) => ["index.d.ts", "client.d.ts"].includes(f));
            put("csstype", (f) => f === "index.d.ts");
            writeFileSync(join(dir, "a.ts"), `import { proxy, subscribe } from "valtio";\nimport { useSnapshot } from "valtio/react";\nimport { subscribeKey } from "valtio/utils";\nconst s = proxy({ n: 1 });\nsubscribe(s, () => {});\nsubscribeKey(s, "n", () => {});\nexport const x: number = s.n;\nvoid useSnapshot;\n`);
            writeFileSync(join(dir, "b.tsx"), `import { useState } from "react";\nimport { createRoot } from "react-dom/client";\nconst App = () => { const [n] = useState(1); return <div className="x">{n}</div>; };\ncreateRoot(document.body).render(<App />);\nconst bad: string = 1;\n`);
            const cfg = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
            const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir);
            expect(parsed.errors).toEqual([]);
            expect(parsed.fileNames.sort()).toEqual([join(dir, "a.ts"), join(dir, "b.tsx")]);
            const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, types: [] } });
            const diags = ts.getPreEmitDiagnostics(program).filter((d) => !d.file || !d.file.fileName.includes(BUILTIN_TYPINGS_ROOT));
            expect(diags.map((d) => `${d.file ? d.file.fileName.slice(dir.length + 1) : ""}:${d.code}`)).toEqual(["b.tsx:2322"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("an .svg import is its markup, a string, in the synced folder (wt-api.d.ts; real tsc)", () => {
        const dir = mkdtempSync(join(process.cwd(), ".tmp-svg-typings-"));
        try {
            writeFileSync(join(dir, "tsconfig.json"), tsconfigText());
            writeFileSync(join(dir, "wt-api.d.ts"), readFileSync("src/types/wt-api.d.ts", "utf8"));
            mkdirSync(join(dir, "icons"));
            writeFileSync(join(dir, "icons", "logo.svg"), "<svg/>");
            writeFileSync(join(dir, "c.ts"), `import logo from "./icons/logo.svg";\nexport const s: string = logo;\nexport const n: number = logo;\n`);
            const cfg = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
            const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir);
            const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, types: [] } });
            const diags = ts.getPreEmitDiagnostics(program);
            expect(diags.map((d) => `${d.file ? d.file.fileName.slice(dir.length + 1) : ""}:${d.start && d.file ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : ""}:${d.code}`)).toEqual(["c.ts:3:2322"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
