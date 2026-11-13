/**
 * Export…/Import… zip: laid out like the synced scripts folder (scripts and
 * data files by path, empty folders as folder entries, settings.json with
 * the globals and the exported scripts' enabled state and params).
 */
import { describe, it, expect } from "vitest";
import {
    buildExportZip,
    emptyFolders,
    filesGoneFrom,
    importedSettingsDoc,
    packageRoots,
    parseExportedStores,
    readExportZip,
    settingsForScripts,
    STORES_FILE,
    storesForScripts,
} from "../src/shared/exportZip";
import { readZipEntries, writeZip } from "../src/shared/zip";
import { parseSettings, renderSettings, type GlobalSettings, type ScriptSettingsState } from "../src/shared/settingsJson";

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
const SETTINGS = renderSettings(G, [script("Debug header.ts", false, { level: "debug" }), script("mock/helpers.ts", true), script("Other.ts", true, { level: "trace" })]);

describe("export zip layout", () => {
    it("lays files out as the scripts folder: settings.json, folders, scripts (.ts/.tsx) and data files by path", async () => {
        const zip = buildExportZip({
            settings: '{"logLevel":"warn"}\n',
            scripts: [
                { name: "Debug header", code: "a" },
                { name: "ui/Panel.tsx", code: "b" },
                { name: "mock/helpers", code: "c" },
            ],
            dataFiles: [{ path: "mock/rate-limits.json", text: "{}" }, { path: "icons/x.svg", text: "<svg/>" }],
            folders: ["mock/empty", "later"],
        });
        const raw = await readZipEntries(buf(zip));
        expect(Object.keys(raw.files)).toEqual(["settings.json", "Debug header.ts", "ui/Panel.tsx", "mock/helpers.ts", "mock/rate-limits.json", "icons/x.svg"]);
        expect(raw.folders).toEqual(["mock/empty", "later"]);
        const z = await readExportZip(buf(zip));
        expect(z.settings).toBe('{"logLevel":"warn"}\n');
        expect(z.scripts).toEqual([
            { name: "Debug header", file: "Debug header.ts", code: "a" },
            { name: "ui/Panel.tsx", file: "ui/Panel.tsx", code: "b" },
            { name: "mock/helpers", file: "mock/helpers.ts", code: "c" },
        ]);
        expect(z.dataFiles).toEqual([{ path: "mock/rate-limits.json", text: "{}" }, { path: "icons/x.svg", text: "<svg/>" }]);
        expect(z.folders).toEqual(["mock/empty", "later"]);
        expect(z.ignored).toEqual([]);
    });

    it("without settings.json there's no settings entry", async () => {
        const z = await readExportZip(buf(buildExportZip({ scripts: [{ name: "a", code: "" }], dataFiles: [] })));
        expect(z.settings).toBeNull();
        expect(z.stores).toBeNull();
        expect(z.scripts.map((s) => s.name)).toEqual(["a"]);
    });

    it("round-trips optional stores.json and filters stores by picked scripts", async () => {
        const allStores = {
            "bonsai/index.tsx": { flags: { beta: true } },
            "other/script": { cache: { hits: 3 } },
        };
        const storesJson = storesForScripts(allStores, ["Bonsai/Index.tsx"]);
        expect(storesJson).not.toBeNull();
        expect(parseExportedStores(storesJson!)).toEqual({ "bonsai/index.tsx": { flags: { beta: true } } });

        const zip = buildExportZip({
            settings: "{}\n",
            stores: storesJson,
            scripts: [{ name: "bonsai/index.tsx", code: "// ok" }],
            dataFiles: [],
        });
        const z = await readExportZip(buf(zip));
        expect(z.stores).toBe(storesJson);
        expect(z.dataFiles).toEqual([]); // STORES_FILE is not misclassified as a user data file
        expect(() => parseExportedStores("[]")).toThrow(new RegExp(STORES_FILE));
    });

    it("takes a zipped scripts folder: unwraps its top folder, skips the support files, dot entries and node_modules", async () => {
        const zip = writeZip({
            "Scripts/": "",
            "Scripts/settings.json": "{}\n",
            "Scripts/tt-api.d.ts": "declare const tt: any;",
            "Scripts/tsconfig.json": "{}",
            "Scripts/settings.schema.json": "{}",
            "Scripts/.vscode/settings.json": "{}",
            "Scripts/node_modules/x/index.json": "{}",
            "__MACOSX/Scripts/._a.ts": "",
            "Scripts/a.ts": "A",
            "Scripts/types.d.ts": "declare const x: 1;",
            "Scripts/README.md": "# hi",
            "Scripts/notes.txt": "skip",
            "Scripts/d/data.json": "[]",
            "Scripts/e/": "",
        });
        const z = await readExportZip(buf(zip));
        expect(z.settings).toBe("{}\n");
        expect(z.scripts).toEqual([{ name: "a", file: "a.ts", code: "A" }]);
        expect(z.dataFiles).toEqual([
            { path: "README.md", text: "# hi" },
            { path: "d/data.json", text: "[]" },
        ]);
        expect(z.folders).toEqual(["e"]);
        expect(z.ignored.sort()).toEqual(["notes.txt", "types.d.ts"]);
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

describe("settings.json in the zip", () => {
    it("keeps the globals and only the exported scripts' overrides", () => {
        const out = settingsForScripts(SETTINGS, ["Debug header", "Other"]);
        expect(Object.keys(parseSettings(out).scripts)).toEqual(["Debug header.ts", "Other.ts"]);
        expect(parseSettings(out).globals).toEqual(parseSettings(SETTINGS).globals);
    });

    it("no exported script: no scripts section, just the globals", () => {
        const out = settingsForScripts(SETTINGS, []);
        expect(JSON.parse(out)).toEqual({ logLevel: "warn" });
    });

    it("leaves malformed JSON unchanged and scopes importedSettingsDoc to picked scripts", () => {
        expect(settingsForScripts("{oops", ["a"])).toBe("{oops");
        expect(importedSettingsDoc(SETTINGS, ["Debug header"])).toEqual({
            globals: parseSettings(SETTINGS).globals,
            scripts: { "Debug header.ts": parseSettings(SETTINGS).scripts["Debug header.ts"] },
            onlyScripts: ["Debug header"],
        });
        expect(() => importedSettingsDoc("{oops", [])).toThrow();
    });

    it("lands enabled state, params and globals through the real apply path without touching unpicked scripts", async () => {
        const ss = await import("../src/background/engine/scriptStore");
        const sf = await import("../src/background/settingsFile");
        const code = `tt.params({ level: { type: "string", default: "warn" } });\ntt.onRequest({ url: "*", strategy: "extension" }, () => {});\n`;
        const untouchedId = ss.newId();
        await ss.saveScript({ id: untouchedId, name: "Untouched", code });
        await ss.setEnabled(untouchedId, false);

        const zip = buildExportZip({
            settings: settingsForScripts(SETTINGS, ["Debug header"]),
            scripts: [{ name: "Debug header", code }],
            dataFiles: [],
        });
        const z = await readExportZip(buf(zip));
        const id = ss.newId();
        await ss.saveScript({ id, name: "Debug header", code: z.scripts[0].code });
        expect((await ss.getScript(id))!.enabled).toBe(true);
        expect(await sf.applySettingsDoc(importedSettingsDoc(z.settings!, ["Debug header"]))).toEqual({});
        expect((await ss.getScript(id))!.enabled).toBe(false);
        expect((await ss.getParamValues(id)).level).toBe("debug");
        expect((await ss.getScript(untouchedId))!.enabled).toBe(false); // unpicked script untouched!
        expect(store.resLogLevel).toBe("warn");
    });
});

describe("Import… of a package's new version", () => {
    const zip = (paths: string[], settings: string | null = null) => ({
        settings,
        scripts: paths.filter((p) => /\.tsx?$/.test(p)).map((p) => ({ name: p.replace(/\.ts$/, ""), file: p, code: "" })),
        dataFiles: paths.filter((p) => !/\.tsx?$/.test(p) && !p.endsWith("/")).map((p) => ({ path: p, text: "" })),
        folders: paths.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)),
    });

    it("its packages: the one folder everything is in (Export Package…), and folders with a metadata.json", () => {
        expect(packageRoots(zip(["kit/a.ts", "kit/lib/b.ts"]))).toEqual(["kit"]);
        expect(packageRoots(zip(["kit/a.ts", "x.ts"]))).toEqual([]);
        expect(packageRoots(zip(["kit/a.ts"], "globals: {}"))).toEqual([]);
        expect(packageRoots(zip(["a/metadata.json", "a/x.ts", "b/y.ts", "metadata.json"]))).toEqual(["a"]);
        // one inside another counts as the outer one
        expect(packageRoots(zip(["kit/metadata.json", "kit/sub/metadata.json", "kit/sub/x.ts"]))).toEqual(["kit"]);
    });

    it("existing files in those packages that the zip doesn't have (any case), and nothing outside them", () => {
        const existing = ["kit/a.ts", "kit/old.ts", "kit/lib/data.json", "Kit/Lib/B.ts", "other/c.ts", "kitten/d.ts", "e.ts"];
        expect(filesGoneFrom(zip(["kit/a.ts", "kit/lib/b.ts"]), existing)).toEqual(["kit/old.ts", "kit/lib/data.json"]);
        expect(filesGoneFrom(zip(["kit/a.ts", "x.ts"]), existing)).toEqual([]);
    });
});
