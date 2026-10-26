import { renameSettingsSection } from "../src/shared/settingsYamlPatch";
import { uniqueScriptName } from "../src/shared/scriptName";
import { describe, it, expect } from "vitest";
import {
    parseSettings, renderSettings, planSettings, yamlKey, SCHEMA_MODELINE, SETTINGS_FILE, defaultStrategySetting,
    type ScriptSettingsState,
} from "../src/shared/settingsYaml";
import { patchSettings } from "../src/shared/settingsYamlPatch";

const defs: any = {
    level: { type: "enum", choices: ["info", "warn"], default: "info", description: "Value of the x-debug header" },
    n: { type: "number", default: 1 },
    tags: { type: "stringList", default: [] },
};
const script = (over: Partial<ScriptSettingsState> = {}): ScriptSettingsState => ({
    name: "My Script",
    declared: true,
    enabled: true,
    defs,
    values: {},
    ...over,
});
const G = { logLevel: "info", logCap: 500, defaultStrategy: "helper" };

describe("settings.yaml render", () => {
    it("starts with the schema modeline and comments out defaults, with descriptions", () => {
        const t = renderSettings(G, [script()]);
        expect(t.startsWith(SCHEMA_MODELINE + "\n")).toBe(true);
        expect(t).toContain("settings:\n");
        expect(t).toContain("params:\n  My Script:\n");
        expect(t).toContain("    # Value of the x-debug header (info | warn)\n    # level: info");
        expect(t).toContain("    # Run this script\n    # enabled: true");
        expect(t).toContain("  # logLevel: info");
        expect(t).not.toMatch(/^\s{0,4}[a-zA-Z"][^:]*: \S/m); // no live entries at all
        expect(parseSettings(t)).toEqual({ settings: {}, params: { "My Script": {} } });
    });

    it("emits only user-set values as live entries", () => {
        const t = renderSettings({ logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [script({ enabled: false, values: { level: "warn", tags: ["a"] } })]);
        expect(t).toContain("  # default: info\n  logLevel: warn");
        expect(t).toContain("    # default: true\n    enabled: false");
        expect(t).toContain("    # default: info\n    level: warn");
        expect(t).toContain("    tags:\n      - a");
        expect(parseSettings(t).params["My Script"]).toEqual({ enabled: false, level: "warn", tags: ["a"] });
    });

    it("is deterministic and skips libraries", () => {
        const lib = script({ name: "util", declared: false, defs: {} });
        expect(renderSettings(G, [script(), lib])).toBe(renderSettings(G, [script(), lib]));
        expect(renderSettings(G, [lib])).not.toContain("util");
        expect(renderSettings(G, [lib])).not.toContain("params:");
    });

    it("render → parse → plan is a fixpoint", () => {
        const s = script({ enabled: false, values: { n: 3 } });
        const t = renderSettings({ logLevel: "debug", logCap: 900, defaultStrategy: "helper" }, [s]);
        expect(planSettings(parseSettings(t), { logLevel: "debug", logCap: 900, defaultStrategy: "helper" }, [s])).toEqual({ globals: {}, scripts: [] });
    });

    it("separates script sections with a blank line", () => {
        const t = renderSettings(G, [script(), script({ name: "Other" })]);
        expect(t).toContain("    # tags: []\n\n  Other:\n");
        // and the patcher keeps the same spacing when inserting a section
        const out = patchSettings(t, G, [script(), script({ name: "Other" }), script({ name: "Third", values: { n: 9 } })])!;
        expect(out).toContain("    # tags: []\n\n  Third:\n");
        expect(out).toContain("n: 9");
    });

    it("a commented multiline default renders as a block scalar", () => {
        const s = script({
            name: "N",
            defs: { notes: { type: "string", multiline: true, default: "line one\nline two", description: "Notes param" } },
            values: {},
        });
        const t = renderSettings(G, [s]);
        expect(t).toContain("    # notes: |-\n    #   line one\n    #   line two\n");
        expect(parseSettings(t).params.N).toEqual({}); // all commented → nothing live
        // and the live form is the same block shape
        const live = renderSettings(G, [script({ name: "N", defs: s.defs, values: { notes: "live one\nlive two" } })]);
        expect(live).toContain("    notes: |-\n      live one\n      live two\n");
    });

    it("quotes keys that would parse as non-strings or break syntax", () => {
        expect(yamlKey("My Script")).toBe("My Script");
        expect(yamlKey("a.b c")).toBe("a.b c");
        expect(yamlKey("true")).toBe('"true"');
        expect(yamlKey("123")).toBe('"123"');
        expect(yamlKey("a: b")).toBe('"a: b"');
        expect(yamlKey('q"#')).toBe('"q\\"#"');
        const s = script({ name: "true", values: { n: 2 } });
        const t = renderSettings(G, [s]);
        expect(t).toContain('  "true":');
        expect(parseSettings(t).params["true"]).toEqual({ n: 2 });
    });
});

describe("settings.yaml apply", () => {
    it("throws on syntax errors", () => {
        expect(() => parseSettings("settings:\n  logLevel: [unclosed\n")).toThrow();
        expect(() => parseSettings('a: 1\na: 2\n')).toThrow(); // duplicate keys
    });

    it("plans changes; missing keys mean default; invalid values are skipped", () => {
        const s = script({ enabled: false, values: { n: 5, level: "warn" } });
        const doc = parseSettings('settings:\n  logLevel: loud\n  logCap: 5000\nparams:\n  My Script:\n    level: bogus\n    tags: [x]\n');
        expect(planSettings(doc, G, [s])).toEqual({
            globals: { logCap: 5000 },
            scripts: [{ name: "My Script", enabled: true, params: { n: 1, tags: ["x"] } }],
        });
    });

    it("leaves scripts / globals without a section alone", () => {
        expect(planSettings(parseSettings(""), { logLevel: "warn", logCap: 900, defaultStrategy: "helper" }, [script({ enabled: false })])).toEqual({ globals: {}, scripts: [] });
        expect(planSettings(parseSettings("# only a comment\n"), { logLevel: "warn", logCap: 900, defaultStrategy: "helper" }, [script({ enabled: false })])).toEqual({ globals: {}, scripts: [] });
    });

    it("plans bodyCap (kB): valid integers in range; missing = default", () => {
        const plan = (t: string, cur: any = G) => planSettings(parseSettings(t), cur, []).globals;
        expect(plan("settings:\n  bodyCap: 1024\n")).toEqual({ bodyCap: 1024 });
        expect(plan("settings:\n  bodyCap: 8\n")).toEqual({});
        expect(plan("settings:\n  bodyCap: 20000\n")).toEqual({});
        expect(plan("settings:\n  bodyCap: 64.5\n")).toEqual({});
        expect(plan("settings:\n  bodyCap: 2048\n")).toEqual({});
        expect(plan("settings:\n  logLevel: info\n", { ...G, bodyCap: 1024 })).toEqual({ bodyCap: 2048 });
        expect(renderSettings({ ...G, bodyCap: 1024 }, [])).toMatch(/\n  # Network view: kB.*\n  # default: 2048\n  bodyCap: 1024\n/);
        expect(patchSettings("settings:\n  # bodyCap: 2048\n", { ...G, bodyCap: 64 }, [])).toMatch(/^settings:\n  # bodyCap: 2048\n  bodyCap: 64\n/);
    });

    it("a present-but-all-commented section resets it to defaults", () => {
        const doc = parseSettings("settings:\n  # logLevel: info\nparams:\n  My Script:\n    # n: 1\n");
        expect(doc).toEqual({ settings: {}, params: { "My Script": {} } });
        const plan = planSettings(doc, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [script({ values: { n: 9 } })]);
        expect(plan).toEqual({ globals: { logLevel: "info" }, scripts: [{ name: "My Script", params: { n: 1 } }] });
    });

    it("parses yaml 1.2 core scalars: yes/on stay strings, hex is a number", () => {
        const doc = parseSettings("params:\n  My Script:\n    level: yes\n    n: 0x10\n");
        expect(doc.params["My Script"].level).toBe("yes");
        expect(doc.params["My Script"].n).toBe(16);
    });
});

describe("settings.yaml patching", () => {
    const hand = [
        "# my notes",
        "settings:",
        '  logLevel:   "warn"   # keep quiet',
        "",
        "",
        "params:",
        "  My Script:   # main",
        "    # enabled: true",
        '    level: "warn"  # trailing',
        "    # n",
        "    # n: 1",
        "    # tags",
        "    # tags: []",
        "",
        "# footer comment",
        "",
    ].join("\n");

    it("is a no-op when state matches (byte-for-byte)", () => {
        expect(patchSettings(hand, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [script({ values: { level: "warn" } })])).toBe(hand);
    });

    it("rewrites only the changed values, byte-for-byte elsewhere", () => {
        const out = patchSettings(hand, { logLevel: "error", logCap: 500, defaultStrategy: "helper" }, [script({ values: { level: "info" } })])!;
        expect(out).toBe(hand.replace('"warn"   # keep', '"error"   # keep').replace('level: "warn"  # trailing', 'level: "info"  # trailing'));
    });

    it("keeps the existing quote style on value updates", () => {
        const single = "params:\n  My Script:\n    level: 'warn'\n";
        expect(patchSettings(single, G, [script({ values: { level: "info" } })])).toBe("params:\n  My Script:\n    level: 'info'\n");
        const plain = "params:\n  My Script:\n    level: warn\n";
        expect(patchSettings(plain, G, [script({ values: { level: "info" } })])).toBe("params:\n  My Script:\n    level: info\n");
    });

    it("inserts a missing live entry under its commented default", () => {
        const out = patchSettings(hand, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [script({ enabled: false, values: { level: "warn" } })])!;
        expect(out).toBe(hand.replace("    # enabled: true\n", "    # enabled: true\n    enabled: false\n"));
    });

    it("inserts new entries and appends missing script sections", () => {
        const out = patchSettings(hand, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [
            script({ values: { level: "warn", n: 4 } }),
            script({ name: "Other", values: { n: 2 } }),
        ])!;
        // live entry lands under its commented default…
        expect(out).toContain('    # n\n    # n: 1\n    n: 4\n');
        // …and the new section is separated by a blank line
        expect(out).toContain("\n\n  Other:\n");
        expect(out).toContain("    # default: 1\n    n: 2\n");
        expect(out).toContain("# footer comment"); // untouched
        expect(parseSettings(out).params.Other).toEqual({ n: 2 });
        expect(parseSettings(out).params["My Script"]).toEqual({ level: "warn", n: 4 });
    });

    it("documents a newly declared param (even at its default) in a documented section", () => {
        // `hand` documents level/n/tags/enabled; a new `extra` param appears
        const withExtra = script({ values: { level: "warn" }, defs: { ...defs, extra: { type: "string", default: "x", description: "Extra knob" } } });
        const out = patchSettings(hand, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [withExtra])!;
        expect(out).toContain('    level: "warn"  # trailing\n    # Extra knob\n    # extra: x\n');
        expect(parseSettings(out).params["My Script"]).toEqual({ level: "warn" }); // commented → not live
    });

    it("comments out a param that is no longer declared", () => {
        const stale = "params:\n  My Script:\n    # enabled: true\n    level: warn\n    old: 5 # keep me\n";
        const s = script({ values: { level: "warn" } }); // defs have no `old`
        const out = patchSettings(stale, G, [s])!;
        expect(out).toContain("    # no longer declared in the script — kept for reference:\n    # old: 5 # keep me\n");
        expect(out).toContain("    level: warn\n"); // the live entry stays
        expect(parseSettings(out).params["My Script"]).toEqual({ level: "warn" }); // `old` is inert
        // …and it's stable: a second patch is a no-op
        expect(patchSettings(out, G, [s])).toBe(out);
    });

    it("comments out the whole section of a deleted script", () => {
        const doc = "params:\n  Gone:\n    # Run this script\n    # enabled: true\n    n: 4\n\n  My Script:\n    level: warn\n";
        const s = script({ values: { level: "warn" } });
        const out = patchSettings(doc, G, [s])!;
        expect(out).toBe('params:\n  # script "Gone" no longer exists — kept for reference:\n  # Gone:\n  #   # Run this script\n  #   # enabled: true\n  #   n: 4\n\n  My Script:\n    level: warn\n');
        expect(Object.keys(parseSettings(out).params)).toEqual(["My Script"]);
        expect(patchSettings(out, G, [s])).toBe(out); // stable
        // the last section deleted, a new script added in the same patch
        const out2 = patchSettings("params:\n  Gone:\n    n: 4\n", G, [script({ name: "New", values: { n: 3 } })])!;
        expect(out2).toContain('  # Gone:\n  #   n: 4\n');
        expect(parseSettings(out2).params).toEqual({ New: { n: 3 } });
    });

    it("appends a missing params section at the document end", () => {
        const doc = "# yaml-language-server: $schema=./settings.schema.json\nsettings:\n  logLevel: warn\n";
        const out = patchSettings(doc, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [script({ name: "New", values: { n: 3 } })])!;
        expect(out).toBe(doc + "\nparams:\n  New:\n    # Run this script\n    # enabled: true\n    # Value of the x-debug header (info | warn)\n    # level: info\n    # n\n    # default: 1\n    n: 3\n    # tags\n    # tags: []\n");
    });

    it("appends a missing settings section at the document end", () => {
        const doc = "params:\n  My Script:\n    n: 1\n";
        const out = patchSettings(doc, { logLevel: "error", logCap: 500, defaultStrategy: "helper" }, [script({ values: { n: 1 } })])!;
        expect(out).toBe(doc + "\nsettings:\n  logLevel: error\n");
    });

    it("inserts live entries into an all-commented (null) section", () => {
        const doc = "settings:\n  # logLevel: info\n\nparams:\n  My Script:\n    # enabled: true\n    # level: info\n";
        const out = patchSettings(doc, { logLevel: "warn", logCap: 500, defaultStrategy: "helper" }, [script({ enabled: false })] )!;
        expect(out).toContain("settings:\n  # logLevel: info\n  logLevel: warn\n");
        // the live entry lands under its commented default…
        expect(out).toContain("  My Script:\n    # enabled: true\n    enabled: false\n    # level: info\n");
        // …and params the file never documented are added as comments
        expect(out).toContain("    # n\n    # n: 1\n    # tags\n    # tags: []\n");
        expect(parseSettings(out).params["My Script"]).toEqual({ enabled: false });
    });

    it("handles CRLF and quoted/dotted script names", () => {
        const crlf = 'params:\r\n  "a.b c":\r\n    level: "warn"\r\n\r\n  My Script:\r\n    n: 2\r\n';
        const s = [script({ name: "a.b c", values: { level: "info" } }), script({ values: { n: 3 } })];
        const out = patchSettings(crlf, G, s)!;
        expect(out).toBe('params:\r\n  "a.b c":\r\n    level: "info"\r\n\r\n  My Script:\r\n    n: 3\r\n');
    });

    it("render of a patched file stays parse-equivalent to canonical state", () => {
        const st = [script({ enabled: false, values: { level: "warn", n: 9 } })];
        const out = patchSettings(hand, { logLevel: "debug", logCap: 700, defaultStrategy: "helper" }, st)!;
        expect(planSettings(parseSettings(out), { logLevel: "debug", logCap: 700, defaultStrategy: "helper" }, st)).toEqual({ globals: {}, scripts: [] });
    });

    it("returns null for unparsable text, wrong-shaped sections and empty input", () => {
        expect(patchSettings("settings:\n  logLevel: [unclosed\n", G, [script()])).toBeNull();
        expect(patchSettings("params:\n  My Script: [1, 2]\n", G, [script({ values: { n: 3 } })])).toBeNull();
        expect(patchSettings("settings: 5\n", G, [script()])).toBeNull();
        expect(patchSettings("", G, [script()])).toBeNull();
        expect(patchSettings("- just\n- a\n- list\n", G, [script()])).toBeNull();
    });
});

describe("multiline string params", () => {
    const mdefs: any = { body: { type: "string", multiline: true, default: "", description: "Free text" } };
    const m = (v: string) => script({ name: "N", defs: mdefs, values: { body: v } });

    it("renders newlines as a YAML block scalar and round-trips", () => {
        for (const v of ["a\nb", 'q"""x\n"', "back\\slash\nz", "tab\there\r\nend", "trailing\n"]) {
            const t = renderSettings(G, [m(v)]);
            expect(parseSettings(t).params.N.body).toBe(v);
        }
        expect(renderSettings(G, [m("a\nb")])).toContain("    body: |-\n      a\n      b");
    });

    it("keeps single-line values one-line", () => {
        expect(renderSettings(G, [m("plain")])).toContain("    body: plain");
        expect(renderSettings(G, [m("a: b")])).toContain('    body: "a: b"');
    });

    it("plans a multi-line value from the document", () => {
        const doc = parseSettings("params:\n  N:\n    body: |-\n      x\n      y\n");
        expect(planSettings(doc, G, [m("")]).scripts[0].params.body).toBe("x\ny");
    });

    it("patches single-line values and block scalars in place", () => {
        const one = "params:\n  N:\n    # note\n    body: \"a\" # c\n";
        expect(patchSettings(one, G, [m("b")])).toBe('params:\n  N:\n    # note\n    body: "b" # c\n');
        // single-line → block scalar; the trailing comment moves to the header
        expect(patchSettings(one, G, [m("b\nc")])).toBe('params:\n  N:\n    # note\n    body: |- # c\n      b\n      c\n');
        // block scalar → block scalar
        const block = "params:\n  N:\n    body: |-\n      x\n      y\n";
        expect(patchSettings(block, G, [m("z\nw")])).toBe("params:\n  N:\n    body: |-\n      z\n      w\n");
        // block scalar → single line collapses it
        expect(patchSettings(block, G, [m("z")])).toBe("params:\n  N:\n    body: z\n");
    });
});

describe("renameSettingsSection", () => {
    const text = "# top\nparams:\n  old:\n    n: 9 # tuned\n  other:\n    x: 1\n";
    it("moves the section, keeping values and comments", () => {
        const out = renameSettingsSection(text, "old", "new");
        expect(out).toBe("# top\nparams:\n  new:\n    n: 9 # tuned\n  other:\n    x: 1\n");
    });
    it("quotes names that need it", () => {
        expect(renameSettingsSection(text, "old", "a: b")).toMatch(/\n  "a: b":\n    n: 9/);
    });
    it("is a no-op when the section is missing, the target exists, or the yaml is broken", () => {
        expect(renameSettingsSection(text, "nope", "new")).toBe(text);
        expect(renameSettingsSection(text, "old", "other")).toBe(text);
        expect(renameSettingsSection("params: [oops", "old", "new")).toBe("params: [oops");
    });
});

describe("script name helpers", () => {
    it("uniqueScriptName ignores letter case", () => {
        expect(uniqueScriptName("x", ["a"])).toBe("x");
        expect(uniqueScriptName("X", ["x", "x (2)"])).toBe("X (3)");
    });
});

describe("settings added by an update", () => {
    it("documents a global setting an existing file doesn't mention, leaving the rest byte-for-byte", () => {
        const G = { logLevel: "info", logCap: 500, defaultStrategy: defaultStrategySetting() } as any;
        const full = renderSettings(G, []);
        // an older file: no strategy documentation at all
        const old = full.slice(0, full.indexOf("  # Interception strategy"));
        const patched = patchSettings(old, G, [])!;
        expect(patched).toBe(full);
        expect(patchSettings(full, G, [])).toBe(full);
    });

    it("doesn't add documentation to a settings section the user stripped of comments", () => {
        const text = "settings:\n  logLevel: warn\n";
        expect(patchSettings(text, { logLevel: "warn", logCap: 500, defaultStrategy: defaultStrategySetting() } as any, [])).toBe(text);
    });
});
