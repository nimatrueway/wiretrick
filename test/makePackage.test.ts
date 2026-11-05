import { describe, expect, it } from "vitest";
import { fetchHosts, makeFolderPackagePlan, makePackagePlan, packageFolders, relativeSpec, withMetadata } from "../src/shared/makePackage";
import { readZip, writeZip } from "../src/shared/zip";
import { parseManifest } from "../src/shared/packageMetadata";

const byFrom = (plan: ReturnType<typeof makePackagePlan>) => Object.fromEntries(plan.files.map((f) => [f.from, f]));

describe("makePackagePlan", () => {
    it("moves a root script and what only it uses into a folder named after it, with a metadata.json", () => {
        const plan = makePackagePlan("dark.wiretrick.ts", {
            "dark.wiretrick.ts": 'import { a } from "./lib";\nimport cfg from "./cfg.json";\nwt.fetch("https://api.example.com/x");\n',
            "lib.ts": "export const a = 1;\n",
            "cfg.json": "{}\n",
            "other.ts": "export const b = 2;\n",
        });
        expect(plan.inPlace).toBe(false);
        expect(plan.folder).toBe("dark");
        expect(plan.files.map((f) => [f.from, f.to, f.copy])).toEqual([
            ["dark.wiretrick.ts", "dark/dark.wiretrick.ts", false],
            ["lib.ts", "dark/lib.ts", false],
            ["cfg.json", "dark/cfg.json", false],
        ]);
        const entry = plan.files[0].text;
        expect(entry).toContain('from "./lib"');
        expect(entry).toContain('from "./cfg.json"');
        expect(plan.manifest!.path).toBe("dark/metadata.json");
        expect(parseManifest(plan.manifest!.text)).toMatchObject({ name: "dark", version: "1.0.0", connect: ["api.example.com"], scripts: ["dark.wiretrick.ts"] });
        expect(plan.edits).toEqual([]);
    });

    it("keeps the layout under the entry's folder and copies what other scripts still use", () => {
        const plan = makePackagePlan("site/x.wiretrick.ts", {
            "site/x.wiretrick.ts": 'import "./parts/p";\nimport { u } from "../shared/u.js";\n',
            "site/parts/p.ts": "export {};\n",
            "shared/u.ts": "export const u = 1;\n",
            "y.wiretrick.ts": 'import { u } from "./shared/u";\n',
        });
        expect(plan.folder).toBe("site/x");
        const f = byFrom(plan);
        expect(f["site/parts/p.ts"]).toMatchObject({ to: "site/x/parts/p.ts", copy: false });
        expect(f["shared/u.ts"]).toMatchObject({ to: "site/x/u.ts", copy: true });
        expect(f["site/x.wiretrick.ts"].text).toContain('from "./u.js"');
        expect(f["site/x.wiretrick.ts"].text).toContain('import "./parts/p"');
        expect(plan.edits).toEqual([]);
    });

    it("copies what a copied file's original still imports", () => {
        const plan = makePackagePlan("e.wiretrick.ts", {
            "e.wiretrick.ts": 'import "./a";\n',
            "a.ts": 'import "./b";\n',
            "b.ts": "export {};\n",
            "o.wiretrick.ts": 'import "./a";\n',
        });
        expect(plan.files.map((f) => [f.from, f.copy])).toEqual([
            ["e.wiretrick.ts", false],
            ["a.ts", true],
            ["b.ts", true],
        ]);
    });

    it("rewrites other files that import the entry", () => {
        const plan = makePackagePlan("e.wiretrick.ts", { "e.wiretrick.ts": 'import "./c.json";\nexport const k = 1;\n', "c.json": "{}", "lib.ts": 'export { k } from "./e.wiretrick";\n' });
        expect(plan.edits).toEqual([{ path: "lib.ts", text: 'export { k } from "./e/e.wiretrick";\n' }]);
    });

    it("leaves a script that's alone in its folder in place: only a metadata.json is added", () => {
        const files = { "pkg/main.wiretrick.ts": 'import "./lib";\n', "pkg/lib.ts": "export {};\n" };
        const plan = makePackagePlan("pkg/main.wiretrick.ts", files);
        expect(plan.inPlace).toBe(true);
        expect(plan.folder).toBe("pkg");
        expect(plan.files.map((f) => f.to)).toEqual(["pkg/main.wiretrick.ts", "pkg/lib.ts"]);
        expect(plan.files.map((f) => f.text)).toEqual(Object.values(files));
        expect(parseManifest(plan.manifest!.text)).toMatchObject({ name: "main", scripts: ["main.wiretrick.ts"] });
    });

    it("isn't in place when its folder holds other files, and picks a free folder name", () => {
        const plan = makePackagePlan("pkg/a.wiretrick.ts", { "pkg/a.wiretrick.ts": 'import "./u";', "pkg/u.ts": "", "pkg/b.ts": "", "pkg/a/x.ts": "" }, ["pkg/a 2"]);
        expect(plan.inPlace).toBe(false);
        expect(plan.folder).toBe("pkg/a 3");
    });

    it("reports bare and missing imports", () => {
        const plan = makePackagePlan("e.wiretrick.ts", { "e.wiretrick.ts": 'import "utils";\nimport "./gone";\nimport x from "https://unpkg.com/x@1.0.0";\n', "utils.ts": "" });
        expect(plan.bare).toEqual([{ from: "e.wiretrick.ts", spec: "utils" }]);
        expect(plan.missing).toEqual([{ from: "e.wiretrick.ts", spec: "./gone" }]);
    });

    it("names a script that imports nothing in place, with wt.metadata", () => {
        const plan = makePackagePlan("p/e.ts", { "p/e.ts": 'wt.fetch("https://x.io/a");\n', "p/o.ts": "" });
        expect(plan.inPlace).toBe(true);
        expect(plan.manifest).toBeUndefined();
        expect(plan.files).toEqual([{ from: "p/e.ts", to: "p/e.ts", copy: false, text: 'wt.metadata({ name: "e", version: "1.0.0", connect: ["x.io"] });\n\nwt.fetch("https://x.io/a");\n' }]);
    });
});

describe("withMetadata", () => {
    it("adds what's missing to an existing call", () => {
        expect(withMetadata('wt.metadata({ description: "Hi {x}" });\n', "x")).toBe('wt.metadata({ name: "x", version: "1.0.0", description: "Hi {x}" });\n');
        expect(withMetadata("wt.metadata({});", "x")).toBe('wt.metadata({ name: "x", version: "1.0.0" });');
        expect(withMetadata('wt.metadata({\n    version: "2.0.0",\n});', "x")).toBe('wt.metadata({\n    name: "x",\n    version: "2.0.0",\n});');
    });

    it("keeps a call that names the script", () => {
        const code = 'wt.metadata({ name: "Mine", version: "3" });';
        expect(withMetadata(code, "x", ["a.com"])).toBe(code);
    });

    it("adds a call after the imports", () => {
        expect(withMetadata('import { a,\n  b } from "./lib";\nimport "./c";\n\nrun();\n', "x")).toBe('import { a,\n  b } from "./lib";\nimport "./c";\n\nwt.metadata({ name: "x", version: "1.0.0" });\n\nrun();\n');
        expect(withMetadata("run();\n", "x")).toBe('wt.metadata({ name: "x", version: "1.0.0" });\n\nrun();\n');
    });
});

describe("makeFolderPackagePlan", () => {
    it("lists the scripts no other file in the folder imports", () => {
        const plan = makeFolderPackagePlan("kit", {
            "kit/a.ts": 'import "./lib";\nimport "../out";\nimport "utils";',
            "kit/sub/b.tsx": 'import "../lib";',
            "kit/lib.ts": "",
            "kit/c.json": "{}",
            "out.ts": "",
        });
        expect(plan.scripts).toEqual(["kit/a.ts", "kit/sub/b.tsx"]);
        expect(plan.outside).toEqual([{ from: "kit/a.ts", spec: "../out" }]);
        expect(plan.bare).toEqual([{ from: "kit/a.ts", spec: "utils" }]);
        expect(plan.manifest.path).toBe("kit/metadata.json");
        expect(parseManifest(plan.manifest.text)).toMatchObject({ name: "kit", version: "1.0.0", scripts: ["a.ts", "sub/b.tsx"] });
    });
});

describe("relativeSpec", () => {
    it("writes the path in the old specifier's style", () => {
        expect(relativeSpec("a/b/e.ts", "a/lib.ts", "./lib")).toBe("../lib");
        expect(relativeSpec("a/e.ts", "a/x/Panel.tsx", "./Panel.tsx")).toBe("./x/Panel.tsx");
        expect(relativeSpec("a/e.ts", "a/x/Panel.tsx", "./Panel")).toBe("./x/Panel");
        expect(relativeSpec("e.ts", "a/u.ts", "../u.js")).toBe("./a/u.js");
        expect(relativeSpec("e.ts", "d/c.json", "./c.json")).toBe("./d/c.json");
    });
});

describe("fetchHosts", () => {
    it("reads literal wt.fetch URLs", () => {
        expect(fetchHosts(['wt.fetch("https://A.example.com:8080/x"); wt.fetch(`https://b.io/${x}`); wt.fetch(url);'])).toEqual(["a.example.com", "b.io"]);
    });
});

describe("packageFolders", () => {
    it("finds folders holding a metadata.json", () => {
        expect([...packageFolders(["a/metadata.json", "a/x.json", "metadata.json", "b/c/metadata.json", "d/meta.json"])]).toEqual([
            ["a", "a/metadata.json"],
            ["b/c", "b/c/metadata.json"],
        ]);
    });
});

describe("writeZip", () => {
    it("writes what readZip reads", async () => {
        const zip = writeZip({ "p/p.wiretrick.ts": "export {};\n", "p/ü.json": '{"a":1}', "p/b.bin": new Uint8Array([0, 255, 7]) });
        const back = await readZip(zip.buffer as ArrayBuffer);
        const text = (b: Uint8Array) => new TextDecoder().decode(b);
        expect(Object.keys(back)).toEqual(["p/p.wiretrick.ts", "p/ü.json", "p/b.bin"]);
        expect(text(back["p/p.wiretrick.ts"])).toBe("export {};\n");
        expect(text(back["p/ü.json"])).toBe('{"a":1}');
        expect([...back["p/b.bin"]]).toEqual([0, 255, 7]);
    });
});
