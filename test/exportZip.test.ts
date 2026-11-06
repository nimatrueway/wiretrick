/**
 * Export…/Import… zip: laid out like the synced scripts folder (scripts and
 * data files by path, empty folders as folder entries, settings.yaml with
 * the globals and the exported scripts' enabled state and params).
 */
import { describe, it, expect } from "vitest";
import { buildExportZip, emptyFolders, importedSettingsDoc, readExportZip, settingsForScripts } from "../src/shared/exportZip";
import { readZipEntries, writeZip } from "../src/shared/zip";
import { parseSettings, renderSettings, type GlobalSettings, type ScriptSettingsState } from "../src/shared/settingsYaml";

// in-memory chrome.storage — must exist before scriptStore/settingsFile load
const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

const buf = (z: Uint8Array): ArrayBuffer => z.slice().buffer;
const G: GlobalSettings = { logLevel: "warn", logCap: 500 };
const script = (name: string, enabled: boolean, values: Record<string, any> = {}): ScriptSettingsState => ({
    name,
    declared: true,
    enabled,
    defs: { level: { type: "string", default: "warn" } } as any,
    values,
});
// as the settings file renders it: defaults commented out, sections separated by blank lines
const SETTINGS = renderSettings(G, [script("Debug header", false, { level: "debug" }), script("mock/helpers", true), script("Other", true, { level: "trace" })]);

describe("export zip layout", () => {
    it("lays files out as the scripts folder: settings.yaml, folders, scripts (.ts/.tsx) and data files by path", async () => {
        const zip = buildExportZip({
            settings: "settings:\n  logLevel: warn\n",
            scripts: [
                { name: "Debug header", code: "a" },
                { name: "ui/Panel.tsx", code: "b" },
                { name: "mock/helpers", code: "c" },
            ],
            dataFiles: [{ path: "mock/rate-limits.json", text: "{}" }, { path: "icons/x.svg", text: "<svg/>" }],
            folders: ["mock/empty", "later"],
        });
        const raw = await readZipEntries(buf(zip));
        expect(Object.keys(raw.files)).toEqual(["settings.yaml", "Debug header.ts", "ui/Panel.tsx", "mock/helpers.ts", "mock/rate-limits.json", "icons/x.svg"]);
        expect(raw.folders).toEqual(["mock/empty", "later"]);
        const z = await readExportZip(buf(zip));
        expect(z.settings).toBe("settings:\n  logLevel: warn\n");
        expect(z.scripts).toEqual([
            { name: "Debug header", file: "Debug header.ts", code: "a" },
            { name: "ui/Panel.tsx", file: "ui/Panel.tsx", code: "b" },
            { name: "mock/helpers", file: "mock/helpers.ts", code: "c" },
        ]);
        expect(z.dataFiles).toEqual([{ path: "mock/rate-limits.json", text: "{}" }, { path: "icons/x.svg", text: "<svg/>" }]);
        expect(z.folders).toEqual(["mock/empty", "later"]);
        expect(z.ignored).toEqual([]);
    });

    it("without settings.yaml there's no settings entry", async () => {
        const z = await readExportZip(buf(buildExportZip({ scripts: [{ name: "a", code: "" }], dataFiles: [] })));
        expect(z.settings).toBeNull();
        expect(z.scripts.map((s) => s.name)).toEqual(["a"]);
    });

    it("takes a zipped scripts folder: unwraps its top folder, skips the support files, dot entries and node_modules", async () => {
        const zip = writeZip({
            "Scripts/": "",
            "Scripts/settings.yaml": "settings:\n",
            "Scripts/wt-api.d.ts": "declare const wt: any;",
            "Scripts/tsconfig.json": "{}",
            "Scripts/settings.schema.json": "{}",
            "Scripts/.vscode/settings.json": "{}",
            "Scripts/node_modules/x/index.json": "{}",
            "__MACOSX/Scripts/._a.ts": "",
            "Scripts/a.ts": "A",
            "Scripts/types.d.ts": "declare const x: 1;",
            "Scripts/notes.md": "# hi",
            "Scripts/d/data.json": "[]",
            "Scripts/e/": "",
        });
        const z = await readExportZip(buf(zip));
        expect(z.settings).toBe("settings:\n");
        expect(z.scripts).toEqual([{ name: "a", file: "a.ts", code: "A" }]);
        expect(z.dataFiles).toEqual([{ path: "d/data.json", text: "[]" }]);
        expect(z.folders).toEqual(["e"]);
        expect(z.ignored.sort()).toEqual(["notes.md", "types.d.ts"]);
    });

    it("keeps a single top folder that is just a folder of scripts", async () => {
        const z = await readExportZip(buf(writeZip({ "mock/a.ts": "A", "mock/b.json": "{}" })));
        expect(z.scripts.map((s) => s.name)).toEqual(["mock/a"]);
        expect(z.dataFiles.map((d) => d.path)).toEqual(["mock/b.json"]);
    });

    it("isn't fooled by a non-zip", async () => {
        await expect(readExportZip(new TextEncoder().encode("name: x\ncode: y\n").buffer as ArrayBuffer)).rejects.toThrow("not a zip file");
    });

    it("emptyFolders: only folders with nothing (no file, no folder) inside, once", () => {
        expect(emptyFolders(["a", "a/b", "c", "C", "d", "e"], ["a/b/x.ts", "d/y.json"])).toEqual(["c", "e"]);
        expect(emptyFolders(["a", "a/b"], [])).toEqual(["a/b"]);
    });
});

describe("settings.yaml in the zip", () => {
    it("keeps the globals and only the exported scripts' sections, the rest byte-for-byte", () => {
        const out = settingsForScripts(SETTINGS, ["Debug header", "Other"]);
        expect(out).toBe(SETTINGS.replace(/\n {2}mock\/helpers:\n(?: {4}.*\n)+/, ""));
        expect(Object.keys(parseSettings(out).params)).toEqual(["Debug header", "Other"]);
        expect(parseSettings(out).settings).toEqual(parseSettings(SETTINGS).settings);
        expect(settingsForScripts(SETTINGS, ["Debug header", "mock/helpers", "Other"])).toBe(SETTINGS);
    });

    it("drops the first or the last section with its blank separator", () => {
        const first = settingsForScripts(SETTINGS, ["mock/helpers", "Other"]);
        expect(Object.keys(parseSettings(first).params)).toEqual(["mock/helpers", "Other"]);
        expect(first).not.toMatch(/params:\n\n/);
        const last = settingsForScripts(SETTINGS, ["Debug header"]);
        expect(Object.keys(parseSettings(last).params)).toEqual(["Debug header"]);
        expect(last.endsWith("\n\n")).toBe(false);
    });

    it("no exported script: no params section, just the globals", () => {
        const out = settingsForScripts(SETTINGS, []);
        expect(out).not.toContain("params:");
        expect(parseSettings(out)).toEqual({ settings: parseSettings(SETTINGS).settings, params: {} });
    });

    it("flow maps and hand-edited text still come out right", () => {
        expect(parseSettings(settingsForScripts("params: { a: { x: 1 }, b: { y: 2 } }\n", ["b"])).params).toEqual({ b: { y: 2 } });
        const odd = "settings:\n  logLevel: warn\nparams:\n  a:\n    x: 1\n  # a comment\n  b:\n      y: 2\n  c: {}\n";
        expect(parseSettings(settingsForScripts(odd, ["b"]))).toEqual({ settings: { logLevel: "warn" }, params: { b: { y: 2 } } });
        expect(settingsForScripts("not: [valid", ["a"])).toBe("not: [valid");
    });

    it("an import applies the globals and the picked scripts' sections only", () => {
        expect(importedSettingsDoc(SETTINGS, ["Debug header"])).toEqual({
            settings: parseSettings(SETTINGS).settings,
            params: { "Debug header": parseSettings(SETTINGS).params["Debug header"] },
        });
        expect(() => importedSettingsDoc("params: [x", [])).toThrow();
    });

    it("lands enabled state, params and globals through the real apply path", async () => {
        const ss = await import("../src/background/engine/scriptStore");
        const sf = await import("../src/background/settingsFile");
        const code = `wt.params({ level: { type: "string", default: "warn" } });\nwt.onRequest({ url: "*", strategy: "extension" }, () => {});\n`;
        const zip = buildExportZip({
            settings: settingsForScripts(SETTINGS, ["Debug header"]),
            scripts: [{ name: "Debug header", code }],
            dataFiles: [],
        });
        const z = await readExportZip(buf(zip));
        // as the Editor imports: scripts saved first (enabled untouched), then settings.yaml applied
        const id = ss.newId();
        await ss.saveScript({ id, name: "Debug header", code: z.scripts[0].code });
        expect((await ss.getScript(id))!.enabled).toBe(true);
        expect(await sf.applySettingsDoc(importedSettingsDoc(z.settings!, ["Debug header"]))).toEqual({});
        expect((await ss.getScript(id))!.enabled).toBe(false);
        expect((await ss.getParamValues(id)).level).toBe("debug");
        expect(store.resLogLevel).toBe("warn");
    });
});
