import { describe, it, expect } from "vitest";
import { crawl, fetchPackage, isRemote, parseSource, pickStart, sourceLabel, ENTRY_URL_RE, type Net } from "../src/shared/packageSource";
import { writeZip } from "../src/shared/zip";

describe("parseSource", () => {
    it("GitHub file, folder and repository URLs", () => {
        expect(parseSource("https://github.com/me/s/blob/main/dark/dark.tangitweak.ts")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark/dark.tangitweak.ts", tree: false });
        expect(parseSource("https://github.com/me/s/tree/v1/dark")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "v1", path: "dark", tree: true });
        expect(parseSource("https://github.com/me/s")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "HEAD", path: "", tree: true });
        expect(parseSource("https://raw.githubusercontent.com/me/s/main/a%20b.tangitweak.ts")).toMatchObject({ ref: "main", path: "a b.tangitweak.ts", tree: false });
        expect(parseSource("https://raw.githubusercontent.com/me/s/refs/heads/dev/x.tangitweak.ts")).toMatchObject({ ref: "refs/heads/dev", path: "x.tangitweak.ts" });
    });
    it("gists", () => {
        expect(parseSource("https://gist.github.com/me/abc123")).toEqual({ kind: "gist", id: "abc123" });
        expect(parseSource("https://gist.githubusercontent.com/me/abc123/raw/def/x.tangitweak.ts")).toEqual({ kind: "gist", id: "abc123", file: "x.tangitweak.ts" });
    });
    it("plain and file URLs name a script or metadata.json", () => {
        expect(parseSource("https://x.dev/p/a.tangitweak.ts#top")).toEqual({ kind: "url", url: "https://x.dev/p/a.tangitweak.ts" });
        expect(parseSource("file:///home/me/p/a.tangitweak.tsx")).toEqual({ kind: "url", url: "file:///home/me/p/a.tangitweak.tsx" });
        expect(parseSource("https://x.dev/p/a.ts")).toEqual({ kind: "url", url: "https://x.dev/p/a.ts" });
        expect(parseSource("https://x.dev/kit/metadata.json")).toEqual({ kind: "url", url: "https://x.dev/kit/metadata.json" });
        expect(typeof parseSource("https://x.dev/p/a.js")).toBe("string");
        expect(typeof parseSource("ftp://x/a.tangitweak.ts")).toBe("string");
    });
    it("zip URLs, GitHub's archives and release assets too", () => {
        expect(parseSource("https://x.dev/kit.zip#a")).toEqual({ kind: "zip", url: "https://x.dev/kit.zip" });
        expect(parseSource("https://github.com/me/s/archive/refs/heads/main.zip")).toEqual({ kind: "zip", url: "https://github.com/me/s/archive/refs/heads/main.zip" });
        expect(parseSource("https://github.com/me/s/releases/download/v1/kit.ZIP")).toMatchObject({ kind: "zip" });
        expect(isRemote({ kind: "zip", url: "https://x.dev/kit.zip" })).toBe(true);
        expect(isRemote({ kind: "zip", url: "file:///kit.zip" })).toBe(false);
    });
    it("labels", () => {
        expect(sourceLabel({ kind: "github", owner: "me", repo: "s", ref: "HEAD", path: "", tree: true })).toBe("github.com/me/s");
    });
    it("recognizes entry URLs opened in a tab", () => {
        expect(ENTRY_URL_RE.test("https://x.dev/a.tangitweak.ts?raw=1")).toBe(true);
        expect(ENTRY_URL_RE.test("file:///a/b.tangitweak.tsx")).toBe(true);
        expect(ENTRY_URL_RE.test("https://x.dev/a.tangitweak.ts.html")).toBe(false);
    });
});

describe("pickStart", () => {
    it("a folder's metadata.json, else its *.tangitweak.ts, else its one script", () => {
        expect(pickStart(["a.ts", "metadata.json"], "x", "")).toBe("metadata.json");
        expect(pickStart(["lib.ts", "a.tangitweak.ts"], "x", "")).toBe("a.tangitweak.ts");
        expect(pickStart(["a.ts", "types.d.ts", "c.json"], "x", "")).toBe("a.ts");
        expect(() => pickStart(["a.ts", "b.ts"], "x", "pick one")).toThrow(/2 scripts.*pick one/);
        expect(() => pickStart(["c.json"], "x", "")).toThrow(/no script/);
    });
});

describe("crawl", () => {
    const fs: Record<string, string> = {
        "repo/pkg/main.tangitweak.ts": `import { a } from "./lib/a";\nimport cfg from "./cfg.json";\nimport x from "../shared/x.js";\nimport React from "react";\nimport u from "https://unpkg.com/x@1.0.0";\nimport g from "globalutil";\nimport m from "./nope";`,
        "repo/pkg/lib/a.ts": `import { P } from "./Panel";\nexport const a = 1;`,
        "repo/pkg/lib/Panel.tsx": `export const P = () => <div/>;`,
        "repo/pkg/cfg.json": `{"a":1}`,
        "repo/shared/x.ts": `import { a } from "../pkg/lib/a";\nexport default 1;`,
    };
    const read = async (p: string) => fs[p] ?? null;
    it("follows relative imports, relative to the common folder", async () => {
        const c = await crawl("repo/pkg/main.tangitweak.ts", read);
        expect(c.entries).toEqual(["pkg/main.tangitweak.ts"]);
        expect(Object.keys(c.files).sort()).toEqual(["pkg/cfg.json", "pkg/lib/Panel.tsx", "pkg/lib/a.ts", "pkg/main.tangitweak.ts", "shared/x.ts"]);
        expect(c.missing).toEqual([{ from: "pkg/main.tangitweak.ts", spec: "./nope" }]);
        expect(c.bare).toEqual([{ from: "pkg/main.tangitweak.ts", spec: "globalutil" }]);
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
        await expect(crawl("nope.tangitweak.ts", read)).rejects.toThrow("can't read");
    });
});

describe("fetchPackage", () => {
    const calls: string[] = [];
    const zip = writeZip({ "kit-1.0/metadata.json": '{"name":"Kit","scripts":["a.ts"]}', "kit-1.0/a.ts": 'import "./lib/b";', "kit-1.0/lib/b.ts": "export {};", "kit-1.0/README.md": "hi", "kit-1.0/lib/c.ts": "export {};" });
    const net: Net = {
        async bytes(url) {
            calls.push(url);
            return url === "https://x.dev/kit.zip" ? (zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer) : null;
        },
        async text(url) {
            calls.push(url);
            const files: Record<string, string> = {
                "https://raw.githubusercontent.com/me/s/abc/dark/dark.tangitweak.ts": `import "./util";`,
                "https://raw.githubusercontent.com/me/s/abc/dark/util.ts": `export {};`,
                "https://x.dev/p/a.tangitweak.ts": `export {};`,
            };
            return files[url] ?? null;
        },
        async json(url) {
            calls.push(url);
            if (url === "https://api.github.com/repos/me/s/commits/main") return { sha: "abc" };
            if (url === "https://api.github.com/repos/me/s/git/trees/abc?recursive=1")
                return { tree: [{ path: "dark", type: "tree" }, { path: "dark/dark.tangitweak.ts", type: "blob" }, { path: "dark/sub/other.tangitweak.ts", type: "blob" }, { path: "dark/util.ts", type: "blob" }] };
            if (url === "https://api.github.com/gists/g1") return { history: [{ version: "rev1" }], files: { "a.tangitweak.ts": { content: "export {};" }, "b.ts": { content: "" } } };
            throw new Error("unexpected " + url);
        },
    };
    it("GitHub folder: pinned to the commit, the folder's one entry", async () => {
        const p = await fetchPackage({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark", tree: true }, net);
        expect(p.revision).toBe("abc");
        expect(p.entries).toEqual(["dark.tangitweak.ts"]);
        expect(Object.keys(p.files)).toEqual(["dark.tangitweak.ts", "util.ts"]);
    });
    it("gist: its entry and revision", async () => {
        const p = await fetchPackage({ kind: "gist", id: "g1" }, net);
        expect(p).toMatchObject({ entries: ["a.tangitweak.ts"], revision: "rev1", files: { "a.tangitweak.ts": "export {};" } });
    });
    it("plain URL: the revision is the files' hash", async () => {
        const p = await fetchPackage({ kind: "url", url: "https://x.dev/p/a.tangitweak.ts" }, net);
        expect(p.entries).toEqual(["a.tangitweak.ts"]);
        expect(p.revision).toMatch(/^[0-9a-f]{24}$/);
    });
    it("zip URL: its one folder's metadata.json and what the scripts import", async () => {
        const p = await fetchPackage({ kind: "zip", url: "https://x.dev/kit.zip" }, net);
        expect(p.entries).toEqual(["a.ts"]);
        expect(Object.keys(p.files).sort()).toEqual(["a.ts", "lib/b.ts", "metadata.json"]);
        expect(p.revision).toMatch(/^[0-9a-f]{24}$/);
        await expect(fetchPackage({ kind: "zip", url: "https://x.dev/none.zip" }, net)).rejects.toThrow(/can't read/);
    });
    it("reports monotonic file and byte download progress", async () => {
        const fileEvents: any[] = [];
        await fetchPackage({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark", tree: true }, net, (p) => fileEvents.push(p));
        expect(fileEvents[0]).toEqual({});
        expect(fileEvents[fileEvents.length - 1]).toEqual({ done: 2, total: 2, detail: "2 / 2 files" });

        const zipEvents: any[] = [];
        const streamingNet: Net = {
            ...net,
            async bytes(url, onBytes) {
                onBytes?.(120, 240);
                onBytes?.(240, 240);
                return net.bytes(url);
            },
        };
        await fetchPackage({ kind: "zip", url: "https://x.dev/kit.zip" }, streamingNet, (p) => zipEvents.push(p));
        expect(zipEvents).toContainEqual({ done: 120, total: 240, detail: "120 B / 240 B" });
        expect(zipEvents[zipEvents.length - 1]).toEqual({ done: 240, total: 240, detail: "240 B / 240 B" });
    });
});
