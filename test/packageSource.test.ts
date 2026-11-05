import { describe, it, expect } from "vitest";
import { crawl, fetchPackage, parseSource, pickStart, sourceLabel, ENTRY_URL_RE, type Net } from "../src/shared/packageSource";

describe("parseSource", () => {
    it("GitHub file, folder and repository URLs", () => {
        expect(parseSource("https://github.com/me/s/blob/main/dark/dark.wiretrick.ts")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark/dark.wiretrick.ts", tree: false });
        expect(parseSource("https://github.com/me/s/tree/v1/dark")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "v1", path: "dark", tree: true });
        expect(parseSource("https://github.com/me/s")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "HEAD", path: "", tree: true });
        expect(parseSource("https://raw.githubusercontent.com/me/s/main/a%20b.wiretrick.ts")).toMatchObject({ ref: "main", path: "a b.wiretrick.ts", tree: false });
        expect(parseSource("https://raw.githubusercontent.com/me/s/refs/heads/dev/x.wiretrick.ts")).toMatchObject({ ref: "refs/heads/dev", path: "x.wiretrick.ts" });
    });
    it("gists", () => {
        expect(parseSource("https://gist.github.com/me/abc123")).toEqual({ kind: "gist", id: "abc123" });
        expect(parseSource("https://gist.githubusercontent.com/me/abc123/raw/def/x.wiretrick.ts")).toEqual({ kind: "gist", id: "abc123", file: "x.wiretrick.ts" });
    });
    it("plain and file URLs name a script or metadata.json", () => {
        expect(parseSource("https://x.dev/p/a.wiretrick.ts#top")).toEqual({ kind: "url", url: "https://x.dev/p/a.wiretrick.ts" });
        expect(parseSource("file:///home/me/p/a.wiretrick.tsx")).toEqual({ kind: "url", url: "file:///home/me/p/a.wiretrick.tsx" });
        expect(parseSource("https://x.dev/p/a.ts")).toEqual({ kind: "url", url: "https://x.dev/p/a.ts" });
        expect(parseSource("https://x.dev/kit/metadata.json")).toEqual({ kind: "url", url: "https://x.dev/kit/metadata.json" });
        expect(typeof parseSource("https://x.dev/p/a.js")).toBe("string");
        expect(typeof parseSource("ftp://x/a.wiretrick.ts")).toBe("string");
    });
    it("labels", () => {
        expect(sourceLabel({ kind: "github", owner: "me", repo: "s", ref: "HEAD", path: "", tree: true })).toBe("github.com/me/s");
    });
    it("recognizes entry URLs opened in a tab", () => {
        expect(ENTRY_URL_RE.test("https://x.dev/a.wiretrick.ts?raw=1")).toBe(true);
        expect(ENTRY_URL_RE.test("file:///a/b.wiretrick.tsx")).toBe(true);
        expect(ENTRY_URL_RE.test("https://x.dev/a.wiretrick.ts.html")).toBe(false);
    });
});

describe("pickStart", () => {
    it("a folder's metadata.json, else its *.wiretrick.ts, else its one script", () => {
        expect(pickStart(["a.ts", "metadata.json"], "x", "")).toBe("metadata.json");
        expect(pickStart(["lib.ts", "a.wiretrick.ts"], "x", "")).toBe("a.wiretrick.ts");
        expect(pickStart(["a.ts", "types.d.ts", "c.json"], "x", "")).toBe("a.ts");
        expect(() => pickStart(["a.ts", "b.ts"], "x", "pick one")).toThrow(/2 scripts.*pick one/);
        expect(() => pickStart(["c.json"], "x", "")).toThrow(/no script/);
    });
});

describe("crawl", () => {
    const fs: Record<string, string> = {
        "repo/pkg/main.wiretrick.ts": `import { a } from "./lib/a";\nimport cfg from "./cfg.json";\nimport x from "../shared/x.js";\nimport React from "react";\nimport u from "https://unpkg.com/x@1.0.0";\nimport g from "globalutil";\nimport m from "./nope";`,
        "repo/pkg/lib/a.ts": `import { P } from "./Panel";\nexport const a = 1;`,
        "repo/pkg/lib/Panel.tsx": `export const P = () => <div/>;`,
        "repo/pkg/cfg.json": `{"a":1}`,
        "repo/shared/x.ts": `import { a } from "../pkg/lib/a";\nexport default 1;`,
    };
    const read = async (p: string) => fs[p] ?? null;
    it("follows relative imports, relative to the common folder", async () => {
        const c = await crawl("repo/pkg/main.wiretrick.ts", read);
        expect(c.entries).toEqual(["pkg/main.wiretrick.ts"]);
        expect(Object.keys(c.files).sort()).toEqual(["pkg/cfg.json", "pkg/lib/Panel.tsx", "pkg/lib/a.ts", "pkg/main.wiretrick.ts", "shared/x.ts"]);
        expect(c.missing).toEqual([{ from: "pkg/main.wiretrick.ts", spec: "./nope" }]);
        expect(c.bare).toEqual([{ from: "pkg/main.wiretrick.ts", spec: "globalutil" }]);
    });
    it("a single file sits at the root", async () => {
        const c = await crawl("repo/pkg/lib/Panel.tsx", read);
        expect(c).toEqual({ entries: ["Panel.tsx"], files: { "Panel.tsx": fs["repo/pkg/lib/Panel.tsx"] }, missing: [], bare: [] });
    });
    it("a metadata.json brings its scripts and what they import", async () => {
        const kit: Record<string, string> = {
            "kit/metadata.json": JSON.stringify({ name: "Kit", scripts: ["a.ts", "sub/b.ts"] }),
            "kit/a.ts": 'import "./lib";',
            "kit/sub/b.ts": 'import "../lib";',
            "kit/lib.ts": "export {};",
            "kit/unused.ts": "",
            "out.ts": "",
            "bad/metadata.json": JSON.stringify({ scripts: ["a.ts"] }),
            "bad/a.ts": 'import "../out";',
        };
        const c = await crawl("kit/metadata.json", async (p) => kit[p] ?? null);
        expect(c.entries).toEqual(["a.ts", "sub/b.ts"]);
        expect(c.manifest?.name).toBe("Kit");
        expect(Object.keys(c.files).sort()).toEqual(["a.ts", "lib.ts", "metadata.json", "sub/b.ts"]);
        await expect(crawl("bad/metadata.json", async (p) => kit[p] ?? null)).rejects.toThrow(/outside/);
    });
    it("a missing entry fails", async () => {
        await expect(crawl("nope.wiretrick.ts", read)).rejects.toThrow("can't read");
    });
});

describe("fetchPackage", () => {
    const calls: string[] = [];
    const net: Net = {
        async text(url) {
            calls.push(url);
            const files: Record<string, string> = {
                "https://raw.githubusercontent.com/me/s/abc/dark/dark.wiretrick.ts": `import "./util";`,
                "https://raw.githubusercontent.com/me/s/abc/dark/util.ts": `export {};`,
                "https://x.dev/p/a.wiretrick.ts": `export {};`,
            };
            return files[url] ?? null;
        },
        async json(url) {
            calls.push(url);
            if (url === "https://api.github.com/repos/me/s/commits/main") return { sha: "abc" };
            if (url === "https://api.github.com/repos/me/s/git/trees/abc?recursive=1")
                return { tree: [{ path: "dark", type: "tree" }, { path: "dark/dark.wiretrick.ts", type: "blob" }, { path: "dark/sub/other.wiretrick.ts", type: "blob" }, { path: "dark/util.ts", type: "blob" }] };
            if (url === "https://api.github.com/gists/g1") return { history: [{ version: "rev1" }], files: { "a.wiretrick.ts": { content: "export {};" }, "b.ts": { content: "" } } };
            throw new Error("unexpected " + url);
        },
    };
    it("GitHub folder: pinned to the commit, the folder's one entry", async () => {
        const p = await fetchPackage({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark", tree: true }, net);
        expect(p.revision).toBe("abc");
        expect(p.entries).toEqual(["dark.wiretrick.ts"]);
        expect(Object.keys(p.files)).toEqual(["dark.wiretrick.ts", "util.ts"]);
    });
    it("gist: its entry and revision", async () => {
        const p = await fetchPackage({ kind: "gist", id: "g1" }, net);
        expect(p).toMatchObject({ entries: ["a.wiretrick.ts"], revision: "rev1", files: { "a.wiretrick.ts": "export {};" } });
    });
    it("plain URL: the revision is the files' hash", async () => {
        const p = await fetchPackage({ kind: "url", url: "https://x.dev/p/a.wiretrick.ts" }, net);
        expect(p.entries).toEqual(["a.wiretrick.ts"]);
        expect(p.revision).toMatch(/^[0-9a-f]{24}$/);
    });
});
