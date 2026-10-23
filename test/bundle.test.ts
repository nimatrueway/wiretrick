/**
 * Import/export bundle: export writes one YAML document (settings +
 * scripts), import accepts that YAML shape.
 * Settings land through the real apply path (settingsFile.applySettingsDoc
 * → params + globals).
 */
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildBundle, parseBundleText, bundleSettingsDoc, pickBundle, syncFileNameFor, vscodeTargetPath } from "../src/ui/bundle";
import { SETTINGS_FILE, type SettingsDoc } from "../src/shared/settingsYaml";

const SETTINGS_ID = "__settings__"; // mirrors manager.ts's virtual entry id

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

const SCRIPTS = [
    { name: "Debug header", code: `wt.params({ level: { type: "string", default: "warn" } });\n`, enabled: false },
    { name: "Mock api", code: ``, enabled: true },
];

const DOC: SettingsDoc = {
    settings: { logLevel: "warn" },
    params: { "Debug header": { enabled: false, level: "debug" } },
};

describe("export bundle shape (yaml)", () => {
    it("is one YAML document with settings + scripts", () => {
        const text = buildBundle(DOC, SCRIPTS);
        expect(text.startsWith("# Wiretrick export")).toBe(true);
        const parsed: any = parseYaml(text);
        expect(parsed.format).toBe("wiretrick-bundle");
        expect(parsed.version).toBe(2);
        expect(parsed.settings).toEqual({ logLevel: "warn" });
        expect(parsed.scripts).toEqual([
            { name: "Debug header", enabled: false, params: { level: "debug" }, code: SCRIPTS[0].code },
            { name: "Mock api", enabled: true, code: SCRIPTS[1].code },
        ]);
    });

    it("omits empty settings and empty params", () => {
        const text = buildBundle({ settings: null, params: {} }, [SCRIPTS[1]]);
        const parsed: any = parseYaml(text);
        expect(parsed.settings).toBeUndefined();
        expect(parsed.scripts[0].params).toBeUndefined();
    });

    it("round-trips through parseBundleText", () => {
        const b = parseBundleText(buildBundle(DOC, SCRIPTS))!;
        expect(b).not.toBeNull();
        expect(b.settings).toEqual({ logLevel: "warn" });
        expect(b.scripts).toEqual([
            { name: "Debug header", enabled: false, params: { level: "debug" }, code: SCRIPTS[0].code },
            { name: "Mock api", enabled: true, code: SCRIPTS[1].code },
        ]);
    });
});

describe("parseBundleText", () => {
    it("other formats (rescript-bundle) → null", () => {
        expect(parseBundleText("format: rescript-bundle\nversion: 1\nscripts:\n  - name: Old\n    code: wt.onDocument(() => {})\n")).toBeNull();
    });

    it("non-bundle payloads → null (plain array / single script / yaml / garbage)", () => {
        expect(parseBundleText(JSON.stringify([{ code: "x" }]))).toBeNull();
        expect(parseBundleText(JSON.stringify({ code: "x" }))).toBeNull();
        expect(parseBundleText("just: yaml\n")).toBeNull();
        expect(parseBundleText("")).toBeNull();
        expect(parseBundleText("not: [valid")).toBeNull();
    });
});

describe("open-in-vscode target path", () => {
    it("settings entry → <folder>/settings.yaml (virtual row, not a stored script)", () => {
        expect(vscodeTargetPath("/Users/x/scripts", SETTINGS_ID, undefined, SETTINGS_ID, SETTINGS_FILE)).toBe("/Users/x/scripts/settings.yaml");
    });

    it("real script → <folder>/<sanitized name>.ts", () => {
        expect(vscodeTargetPath("/Users/x/scripts", "s_abc", "Debug header", SETTINGS_ID, SETTINGS_FILE)).toBe("/Users/x/scripts/Debug header.ts");
    });

    it("trailing slashes on the folder are stripped", () => {
        expect(vscodeTargetPath("/Users/x/scripts//", SETTINGS_ID, undefined, SETTINGS_ID, SETTINGS_FILE)).toBe("/Users/x/scripts/settings.yaml");
    });

    it("syncFileNameFor: settings id wins even if a script name is passed", () => {
        expect(syncFileNameFor(SETTINGS_ID, "whatever", SETTINGS_ID, SETTINGS_FILE)).toBe("settings.yaml");
    });
});

describe("imported bundle settings applied via the real apply path", () => {
    it("applySettingsDoc lands params + globals from a yaml bundle (enabled lands via saveScript)", async () => {
        const ss = await import("../src/background/engine/scriptStore");
        const sf = await import("../src/background/settingsFile");

        // the import order mirrors the manager: scripts saved first (with
        // their bundle enabled state), then the settings doc applied
        const bundle = parseBundleText(buildBundle(DOC, SCRIPTS))!;
        const id = ss.newId();
        await ss.saveScript({ id, name: "Debug header", code: SCRIPTS[0].code, enabled: bundle.scripts[0].enabled });

        const res = await sf.applySettingsDoc(bundleSettingsDoc(bundle)!);
        expect(res).toEqual({});

        expect((await ss.getParamValues(id)).level).toBe("debug"); // param from the bundle
        expect((await ss.getScript(id))!.enabled).toBe(false); // enabled from the bundle entry
        expect(store.resLogLevel).toBe("warn"); // global from the bundle
        expect(store.resLogCap).toBeUndefined(); // not in the bundle → untouched
    });

    it("a bundle without settings/params produces no settings doc (scripts-only import)", async () => {
        const before = { ...store };
        const bundle = parseBundleText(buildBundle({ settings: null, params: {} }, SCRIPTS))!;
        // enabled travels on the script entries and is applied at saveScript
        // time — it must NOT become a params section, or planSettings would
        // reset every unmentioned param of that script to its default
        expect(bundleSettingsDoc(bundle)).toBeNull();
        expect(store).toEqual(before);
    });
});

describe("pickBundle (partial import)", () => {
    const full = { settings: { logLevel: "warn" }, scripts: [{ name: "a", code: "1" }, { name: "b", code: "2", params: { x: 1 } }, { name: "c", code: "3" }] };
    it("keeps only the picked scripts, in bundle order given", () => {
        expect(pickBundle(full, false, [2, 0])).toEqual({ scripts: [full.scripts[2], full.scripts[0]] });
    });
    it("keeps settings only when asked", () => {
        expect(pickBundle(full, true, []).settings).toEqual({ logLevel: "warn" });
        expect(bundleSettingsDoc(pickBundle(full, false, [0]))).toBeNull();
        expect(bundleSettingsDoc(pickBundle(full, false, [1]))).toEqual({ settings: null, params: { b: { x: 1 } } });
    });
    it("an export without settings omits the section", () => {
        const text = buildBundle({ settings: null, params: {} }, [{ name: "a", code: "1" }]);
        expect(parseYaml(text).settings).toBeUndefined();
    });
});
