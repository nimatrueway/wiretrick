import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { addedCapabilities, capabilitiesOf, describeCapabilities, isAllUrls, type Capabilities } from "../src/shared/packageCaps";
import { modifiedFiles, packageFolder, packageName, storeItemOf, uniqueEntryName } from "../src/shared/packageModel";
import { diffHunks, lineDiff } from "../src/shared/lineDiff";
import { readZip } from "../src/shared/zip";
import { entriesIn, isPackageFile, localPackage } from "../src/shared/localPackage";

const caps = (c: Partial<Capabilities> = {}): Capabilities => ({ urls: [], strategies: [], pageJs: false, overlay: false, unsafe: false, connect: [], packages: [], ...c });

describe("packageCaps", () => {
    it("reads what a script's routes and imports can do", () => {
        const routes = [
            { kind: "onRequest", url: ["*://b.com/*", "*://a.com/*"], strategy: "fetch" },
            { kind: "onDocument", url: ["*://a.com/*"] },
            { kind: "onDocument", url: ["*://c.com/*"], world: "isolated" },
            { kind: "onOverlay", url: ["*://a.com/*"], world: "page" },
        ];
        const c = capabilitiesOf({ routes } as never, { connect: ["api.x.com"] }, ['import confetti from "https://unpkg.com/canvas-confetti@1.9.3";', 'import "./lib";']);
        expect(c).toEqual({
            urls: ["*://a.com/*", "*://b.com/*", "*://c.com/*"],
            strategies: ["fetch"],
            pageJs: true,
            overlay: true,
            unsafe: true,
            connect: ["api.x.com"],
            packages: ["canvas-confetti"],
        });
    });

    it("an isolated onDocument doesn't touch the page's JavaScript", () => {
        const c = capabilitiesOf({ routes: [{ kind: "onDocument", url: ["*://a.com/*"], world: "isolated" }] } as never, { connect: [] }, []);
        expect(c.pageJs).toBe(false);
    });

    it("knows every-site patterns", () => {
        for (const p of ["<all_urls>", "*://*/*", "*", "https://*/*"]) expect(isAllUrls(p)).toBe(true);
        expect(isAllUrls("*://*.a.com/*")).toBe(false);
    });

    it("describes the riskiest first", () => {
        const lines = describeCapabilities(caps({ urls: ["<all_urls>", "*://a.com/*"], strategies: ["debugger", "fetch"], connect: ["x.io"] }));
        expect(lines.map((l) => l.risk)).toEqual(["high", "high", "low", "low", "low"]);
        expect(lines[0].text).toBe("Runs on every site");
        expect(describeCapabilities(caps())).toEqual([{ text: "Registers no handlers (a library)", risk: "low" }]);
    });

    it("lists only what an update adds", () => {
        const prev = caps({ urls: ["*://a.com/*"], strategies: ["fetch"] });
        expect(addedCapabilities(prev, prev)).toEqual([]);
        expect(addedCapabilities(prev, caps({ urls: ["*://a.com/*"] }))).toEqual([]);
        expect(addedCapabilities(prev, caps({ urls: ["*://a.com/*", "*://b.com/*"], strategies: ["fetch", "debugger"], pageJs: true, unsafe: true, overlay: true, connect: ["h"], packages: ["p"] }))).toEqual([
            "runs on *://b.com/*",
            "intercepts with debugger",
            "runs code in the site's own JavaScript world",
            "draws an overlay",
            "runs overlay code in the site's world (unsafe)",
            "connects to h",
            "imports p",
        ]);
        // already everywhere: more sites add nothing
        expect(addedCapabilities(caps({ urls: ["<all_urls>"] }), caps({ urls: ["*://b.com/*"] }))).toEqual([]);
    });
});

describe("packageModel", () => {
    it("maps package files to store items", () => {
        expect(storeItemOf("", "x.wiretrick.ts")).toEqual({ kind: "script", name: "x.wiretrick" });
        expect(storeItemOf("x", "lib/a.ts")).toEqual({ kind: "script", name: "x/lib/a" });
        expect(storeItemOf("x", "ui.tsx")).toEqual({ kind: "script", name: "x/ui.tsx" });
        expect(storeItemOf("x", "data/c.json")).toEqual({ kind: "data", name: "x/data/c.json" });
    });

    it("names a package by @name, else its entry", () => {
        expect(packageName("a/dark.wiretrick.ts", { name: "" })).toBe("dark");
        expect(packageName("dark.wiretrick.ts", { name: "Dark Mode" })).toBe("Dark Mode");
    });

    it("puts a single file at the root and more in a unique folder", () => {
        expect(packageFolder("dark.wiretrick.ts", { "dark.wiretrick.ts": "" }, ["dark"])).toBe("");
        const files = { "dark.wiretrick.ts": "", "lib.ts": "" };
        expect(packageFolder("dark.wiretrick.ts", files, [])).toBe("dark");
        expect(packageFolder("dark.wiretrick.ts", files, ["Dark/x", "dark (2)/y.json"])).toBe("dark (3)");
    });

    it("keeps a renamed root entry an entry", () => {
        expect(uniqueEntryName("x.wiretrick", [])).toBe("x.wiretrick");
        expect(uniqueEntryName("x.wiretrick", ["x.wiretrick", "x (2).wiretrick"])).toBe("x (3).wiretrick");
        expect(uniqueEntryName("x.wiretrick.tsx", ["x.wiretrick.tsx"])).toBe("x (2).wiretrick.tsx");
    });

    it("finds files edited, renamed or deleted since install", () => {
        const pkg = {
            files: {
                "a.ts": { kind: "script", id: "1", name: "p/a", hash: "h1" },
                "b.ts": { kind: "script", id: "2", name: "p/b", hash: "h2" },
                "c.json": { kind: "data", id: "3", name: "p/c.json", hash: "h3" },
                "d.ts": { kind: "script", id: "4", name: "p/d", hash: "h4" },
            },
        } as const;
        const now: Record<string, { name: string; hash: string }> = { "1": { name: "p/a", hash: "h1" }, "2": { name: "p/b", hash: "edited" }, "3": { name: "q/c.json", hash: "h3" } };
        expect(modifiedFiles(pkg as never, (f) => now[f.id])).toEqual(["b.ts", "c.json", "d.ts"]);
    });
});

describe("lineDiff", () => {
    it("diffs lines", () => {
        const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")!;
        expect(d.map((l) => l.op + l.text)).toEqual([" a", "-b", "+B", " c", " d", "+e"]);
    });

    it("same text: no changes", () => {
        expect(lineDiff("x\ny", "x\ny")!.every((l) => l.op === " ")).toBe(true);
    });

    it("gives up on huge diffs", () => {
        const big = (s: string) => Array.from({ length: 2100 }, (_, i) => s + i).join("\n");
        expect(lineDiff(big("a"), big("b"))).toBeNull();
    });

    it("keeps context around changes and marks gaps", () => {
        const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
        const after = before.replace("l2\n", "L2\n").replace("l17", "L17");
        const h = diffHunks(lineDiff(before, after)!, 1);
        expect(h.map((l) => (l ? l.op + l.text : "…"))).toEqual([" l1", "-l2", "+L2", " l3", "…", " l16", "-l17", "+L17", " l18"]);
    });
});

/** a zip with `files`, each stored or deflated */
function makeZip(files: [string, string, "store" | "deflate"][]): ArrayBuffer {
    const enc = new TextEncoder();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const [name, text, how] of files) {
        const n = enc.encode(name);
        const raw = enc.encode(text);
        const data = how === "store" ? raw : new Uint8Array(deflateRawSync(raw));
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(8, how === "store" ? 0 : 8, true);
        lh.setUint32(18, data.length, true);
        lh.setUint32(22, raw.length, true);
        lh.setUint16(26, n.length, true);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(10, how === "store" ? 0 : 8, true);
        ch.setUint32(20, data.length, true);
        ch.setUint32(24, raw.length, true);
        ch.setUint16(28, n.length, true);
        ch.setUint32(42, offset, true);
        const local = new Uint8Array([...new Uint8Array(lh.buffer), ...n, ...data]);
        locals.push(local);
        centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...n]));
        offset += local.length;
    }
    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let p = 0;
    for (const part of parts) {
        out.set(part, p);
        p += part.length;
    }
    return out.buffer;
}

describe("readZip", () => {
    it("reads stored and deflated files, skipping folders and unwanted ones", async () => {
        const zip = makeZip([
            ["pkg/", "", "store"],
            ["pkg/x.wiretrick.ts", 'import "./lib";\n', "store"],
            ["pkg/lib.ts", "export const a = 1;\n".repeat(50), "deflate"],
            ["pkg/readme.md", "hi", "store"],
        ]);
        const out = await readZip(zip, isPackageFile);
        const dec = new TextDecoder();
        expect(Object.keys(out).sort()).toEqual(["pkg/lib.ts", "pkg/x.wiretrick.ts"]);
        expect(dec.decode(out["pkg/lib.ts"])).toBe("export const a = 1;\n".repeat(50));
        expect(dec.decode(out["pkg/x.wiretrick.ts"])).toBe('import "./lib";\n');
    });

    it("rejects what isn't a zip", async () => {
        await expect(readZip(new TextEncoder().encode("hello, this is not a zip file at all").buffer as ArrayBuffer)).rejects.toThrow("not a zip file");
    });
});

describe("localPackage", () => {
    it("picks package files and entries, shallowest first", () => {
        expect(isPackageFile("a/b.ts")).toBe(true);
        expect(isPackageFile("a/b.svg")).toBe(true);
        expect(isPackageFile("node_modules/x/index.ts")).toBe(false);
        expect(isPackageFile("readme.md")).toBe(false);
        expect(entriesIn(["sub/b.wiretrick.ts", "lib.ts", "a.wiretrick.tsx", "z.wiretrick.ts"])).toEqual(["a.wiretrick.tsx", "z.wiretrick.ts", "sub/b.wiretrick.ts"]);
    });

    it("takes the entry and what it imports", async () => {
        const files = { "x.wiretrick.ts": 'import { a } from "./lib";\nimport c from "./c.json";\nimport "./gone";', "lib.ts": "export const a = 1;", "c.json": "{}", "other.ts": "" };
        const p = await localPackage(files, "x.wiretrick.ts");
        expect(Object.keys(p.files).sort()).toEqual(["c.json", "lib.ts", "x.wiretrick.ts"]);
        expect(p.missing.length).toBe(1);
        expect(p.revision).toMatch(/^[0-9a-f]+$/);
        const again = await localPackage({ ...files, "other.ts": "changed" }, "x.wiretrick.ts");
        expect(again.revision).toBe(p.revision);
    });
});
