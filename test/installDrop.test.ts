import { describe, it, expect } from "vitest";
import { isInstallDrag, readDrop } from "../src/ui/install/drop";

type FakeEntry = { name: string; isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void) => void; createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void) => void } };

const fileEntry = (name: string, text: string): FakeEntry => ({ name, isFile: true, isDirectory: false, file: (ok) => ok(new File([text], name)) });
const dirEntry = (name: string, children: FakeEntry[]): FakeEntry => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
        // hands out the entries in two batches, then none (as Chrome does)
        const batches = [children.slice(0, 1), children.slice(1), []];
        return { readEntries: (ok) => ok(batches.shift() ?? []) };
    },
});

function transfer(opts: { entries?: FakeEntry[]; files?: File[]; data?: Record<string, string> }): DataTransfer {
    const files = opts.files ?? (opts.entries ?? []).map((e) => new File([""], e.name));
    const items = (opts.entries ?? files.map(() => null)).map((e) => ({ kind: "file", webkitGetAsEntry: () => e }));
    const data = opts.data ?? {};
    return {
        types: [...(files.length ? ["Files"] : []), ...Object.keys(data)],
        items,
        files,
        getData: (t: string) => data[t] ?? "",
    } as unknown as DataTransfer;
}

describe("install drops", () => {
    it("takes files and links, not the Explorer's own row drags", () => {
        expect(isInstallDrag(transfer({ files: [new File(["x"], "a.ts")] }))).toBe(true);
        expect(isInstallDrag(transfer({ data: { "text/uri-list": "https://x/a.ts" } }))).toBe(true);
        expect(isInstallDrag(transfer({ data: { "text/plain": "folder/a.ts" } }))).toBe(false);
        expect(isInstallDrag(null)).toBe(false);
    });

    it("reads a link from the uri-list (skipping comments), else a URL in the text", async () => {
        expect(await readDrop(transfer({ data: { "text/uri-list": "# from a page\r\nhttps://gist.github.com/me/abc\r\n" } }))).toEqual({ url: "https://gist.github.com/me/abc" });
        expect(await readDrop(transfer({ data: { "text/uri-list": "", "text/plain": " https://github.com/me/kit " } }))).toEqual({ url: "https://github.com/me/kit" });
        expect(await readDrop(transfer({ data: { "text/plain": "just words" } }))).toHaveProperty("error");
    });

    it("passes a .zip on as is", async () => {
        const zip = new File(["PK"], "kit.zip");
        const d = await readDrop(transfer({ entries: [fileEntry("kit.zip", "PK")], files: [zip] }));
        expect(d).toEqual({ zip });
    });

    it("reads a folder's package files by their paths inside it", async () => {
        const dir = dirEntry("kit", [
            fileEntry("metadata.json", "{}"),
            fileEntry("README.md", "# Kit"),
            dirEntry("tools", [fileEntry("b.ts", "B"), fileEntry("notes.txt", "skip")]),
            dirEntry("node_modules", [fileEntry("x.ts", "skip")]),
            fileEntry("a.ts", "A"),
        ]);
        const d = await readDrop(transfer({ entries: [dir] }));
        expect(d).toEqual({ label: 'The folder "kit"', files: { "metadata.json": "{}", "README.md": "# Kit", "tools/b.ts": "B", "a.ts": "A" } });
    });

    it("reads dropped scripts by name", async () => {
        expect(await readDrop(transfer({ entries: [fileEntry("dark.tangitweak.ts", "D")] }))).toEqual({ label: "dark.tangitweak.ts", files: { "dark.tangitweak.ts": "D" } });
        const two = await readDrop(transfer({ entries: [fileEntry("a.ts", "A"), fileEntry("cfg.json", "{}")] }));
        expect(two).toEqual({ label: "The dropped files", files: { "a.ts": "A", "cfg.json": "{}" } });
    });

    it("falls back to the files where entries aren't available", async () => {
        const d = await readDrop(transfer({ entries: [null as any], files: [new File(["A"], "a.ts")] }));
        expect(d).toEqual({ label: "a.ts", files: { "a.ts": "A" } });
    });
});
