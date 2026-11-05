import { describe, expect, it } from "vitest";
import { fetchHosts, makePackagePlan, packageFolders, relativeSpec, withHeader } from "../src/shared/makePackage";
import { readZip, writeZip } from "../src/shared/zip";
import { parseHeader } from "../src/shared/packageHeader";

const byFrom = (plan: ReturnType<typeof makePackagePlan>) => Object.fromEntries(plan.files.map((f) => [f.from, f]));

describe("makePackagePlan", () => {
    it("moves a root entry and what only it uses into a folder named after it, with a header", () => {
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
        expect(plan.addsHeader).toBe(true);
        expect(parseHeader(entry)).toMatchObject({ name: "dark", version: "1.0.0", connect: ["api.example.com"] });
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
        const plan = makePackagePlan("e.wiretrick.ts", { "e.wiretrick.ts": "export const k = 1;\n", "lib.ts": 'export { k } from "./e.wiretrick";\n' });
        expect(plan.edits).toEqual([{ path: "lib.ts", text: 'export { k } from "./e/e.wiretrick";\n' }]);
    });

    it("leaves an entry that's alone in its folder in place: only the header changes", () => {
        const files = { "pkg/main.wiretrick.ts": 'import "./lib";\n', "pkg/lib.ts": "export {};\n" };
        const plan = makePackagePlan("pkg/main.wiretrick.ts", files);
        expect(plan.inPlace).toBe(true);
        expect(plan.folder).toBe("pkg");
        expect(plan.files.map((f) => f.to)).toEqual(["pkg/main.wiretrick.ts", "pkg/lib.ts"]);
        expect(plan.files[1].text).toBe(files["pkg/lib.ts"]);
        expect(parseHeader(plan.files[0].text).name).toBe("main");
    });

    it("isn't in place when its folder has another entry, and picks a free folder name", () => {
        const plan = makePackagePlan("pkg/a.wiretrick.ts", { "pkg/a.wiretrick.ts": "", "pkg/b.wiretrick.ts": "", "pkg/a/x.ts": "" }, ["pkg/a 2"]);
        expect(plan.inPlace).toBe(false);
        expect(plan.folder).toBe("pkg/a 3");
    });

    it("reports bare and missing imports", () => {
        const plan = makePackagePlan("e.wiretrick.ts", { "e.wiretrick.ts": 'import "utils";\nimport "./gone";\nimport x from "https://unpkg.com/x@1.0.0";\n', "utils.ts": "" });
        expect(plan.bare).toEqual([{ from: "e.wiretrick.ts", spec: "utils" }]);
        expect(plan.missing).toEqual([{ from: "e.wiretrick.ts", spec: "./gone" }]);
    });

    it("keeps a header that has a name", () => {
        const code = "/**\n * @name Mine\n */\nexport {};\n";
        const plan = makePackagePlan("p/e.wiretrick.ts", { "p/e.wiretrick.ts": code });
        expect(plan.addsHeader).toBe(false);
        expect(plan.files[0].text).toBe(code);
    });
});

describe("withHeader", () => {
    it("adds to a doc block at the top", () => {
        const out = withHeader("// hi\n/**\n * Does things\n * @version 2.0.0\n */\ncode();\n", "x");
        expect(out).toBe("// hi\n/**\n * @name x\n * @description\n * Does things\n * @version 2.0.0\n */\ncode();\n");
        expect(parseHeader(out)).toMatchObject({ name: "x", version: "2.0.0", description: "Does things" });
    });

    it("puts a new block above a one-line comment", () => {
        expect(withHeader("/** one */\ncode();\n", "x")).toBe("/**\n * @name x\n * @version 1.0.0\n * @description\n */\n/** one */\ncode();\n");
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
    it("finds folders whose one entry has a header", () => {
        const h = "/** @name x */\n";
        const out = packageFolders([
            { name: "a/a.wiretrick", code: h },
            { name: "a/lib", code: "" },
            { name: "b/b.wiretrick", code: "" },
            { name: "c/c.wiretrick", code: h },
            { name: "c/sub/d.wiretrick", code: "" },
            { name: "root.wiretrick", code: h },
            { name: "e/f/g.wiretrick", code: h },
        ]);
        expect([...out]).toEqual([
            ["a", "a/a.wiretrick"],
            ["e/f", "e/f/g.wiretrick"],
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
