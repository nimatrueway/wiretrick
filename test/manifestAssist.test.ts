import { describe, it, expect } from "vitest";
import { manifestScriptCompletions } from "../src/ui/manifestAssist";

const FILES = ["pkg/main.ts", "pkg/lib/util.ts", "pkg/view.tsx", "pkg/data.json", "other/x.ts", "root.ts", "PKG2/y.ts"];
/** `|` marks the cursor */
const at = (src: string, folder = "pkg", files = FILES) => {
    const offset = src.indexOf("|");
    const text = src.slice(0, offset) + src.slice(offset + 1);
    const r = manifestScriptCompletions(text, offset, folder, files);
    return r && { ...r, replaced: text.slice(r.replaceFrom, r.replaceTo) };
};

describe("metadata.json scripts completions", () => {
    it("offers the folder's .ts/.tsx files relative to it, shallow first", () => {
        expect(at('{ "scripts": ["|"] }')).toMatchObject({ paths: ["main.ts", "view.tsx", "lib/util.ts"], inString: true, replaced: "" });
    });

    it("replaces the string's content typed so far", () => {
        const r = at('{ "name": "x", "scripts": ["ma|in"] }')!;
        expect(r.replaced).toBe("main");
        expect(r.paths).toContain("main.ts");
    });

    it("leaves out what's already listed (but not the entry being edited)", () => {
        expect(at('{ "scripts": ["main.ts", "./view.tsx", "|"] }')!.paths).toEqual(["lib/util.ts"]);
        expect(at('{ "scripts": ["main.ts", "|", "lib/util.ts"] }')!.paths).toEqual(["view.tsx"]);
        expect(at('{ "scripts": ["main.ts|"] }')!.paths).toContain("main.ts");
    });

    it("between entries: inserts a quoted path at the cursor", () => {
        expect(at('{ "scripts": [|] }')).toMatchObject({ inString: false, replaced: "" });
        expect(at('{\n  "scripts": [\n    "main.ts",\n    |\n  ]\n}')!.paths).toEqual(["view.tsx", "lib/util.ts"]);
        expect(at('{ "scripts": [|')!.inString).toBe(false);
    });

    it("only in the top-level scripts array", () => {
        expect(at('{ "connect": ["|"] }')).toBeNull();
        expect(at('{ "scr|ipts": [] }')).toBeNull();
        expect(at('{ "x": { "scripts": ["|"] } }')).toBeNull();
        expect(at('{ "description": "|", "scripts": [] }')).toBeNull();
        expect(at('{ "scripts": [] |}')).toBeNull();
    });

    it("a package at the root lists every script", () => {
        expect(at('{ "scripts": ["|"] }', "")!.paths).toEqual(["root.ts", "other/x.ts", "pkg/main.ts", "pkg/view.tsx", "PKG2/y.ts", "pkg/lib/util.ts"]);
    });
});
