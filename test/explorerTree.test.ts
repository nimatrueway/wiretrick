import { describe, expect, it } from "vitest";
import { baseName, dropPath, explorerTree, folderPathOfRowId, folderRowId, isFolderRowId, joinPath, movedCollapsed, targetFolder } from "../src/ui/explorerTree";

const rows = (input: Parameters<typeof explorerTree>[0]) => explorerTree(input).map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? (r.expanded ? "v " : "> ") : ""}${r.name}`);

describe("explorerTree", () => {
    const input = {
        scripts: [
            { id: "s1", name: "zeta" },
            { id: "s2", name: "mock/b" },
            { id: "s3", name: "mock/a" },
            { id: "s4", name: "alpha" },
            { id: "s5", name: "mock/deep/x" },
        ],
        dataFiles: [
            { id: "d1", path: "mock/z.json" },
            { id: "d2", path: "mock/A.json" },
            { id: "d3", path: "root.json" },
        ],
        folders: ["Empty", "mock"],
    };

    it("orders subfolders, then scripts (stored order), then data files", () => {
        expect(rows(input)).toEqual(["v Empty", "v mock", "  v deep", "    x", "  b", "  a", "  A.json", "  z.json", "zeta", "alpha", "root.json"]);
    });

    it("flat root scripts stay in stored order", () => {
        expect(rows({ scripts: [{ id: "b", name: "b" }, { id: "a", name: "a" }], dataFiles: [], folders: [] })).toEqual(["b", "a"]);
    });

    it("hides a collapsed folder's contents, unless all", () => {
        const collapsed = new Set(["mock"]);
        expect(rows({ ...input, collapsed })).toEqual(["v Empty", "> mock", "zeta", "alpha", "root.json"]);
        expect(explorerTree({ ...input, collapsed, all: true }).map((r) => r.id)).toEqual(["dir:Empty", "dir:mock", "dir:mock/deep", "s5", "s2", "s3", "d2", "d1", "s1", "s4", "d3"]);
    });

    it("rows carry kind, id, path and depth", () => {
        const r = explorerTree(input).find((x) => x.id === "s5")!;
        expect(r).toEqual({ kind: "script", id: "s5", path: "mock/deep/x", name: "x", depth: 2 });
        expect(explorerTree(input)[2]).toMatchObject({ kind: "folder", id: "dir:mock/deep", path: "mock/deep", depth: 1, expanded: true });
    });
});

describe("path helpers", () => {
    it("names and ids", () => {
        expect(baseName("a/b/c.json")).toBe("c.json");
        expect(baseName("x")).toBe("x");
        expect(joinPath("", "x")).toBe("x");
        expect(joinPath("a/b", "x")).toBe("a/b/x");
        expect(folderRowId("a/b")).toBe("dir:a/b");
        expect(isFolderRowId("dir:a")).toBe(true);
        expect(isFolderRowId("s_1")).toBe(false);
        expect(folderPathOfRowId("dir:a/b")).toBe("a/b");
    });

    it("targetFolder: a folder itself, a file's folder, else the root", () => {
        expect(targetFolder(undefined)).toBe("");
        expect(targetFolder({ kind: "folder", path: "a/b" })).toBe("a/b");
        expect(targetFolder({ kind: "script", path: "a/b/x" })).toBe("a/b");
        expect(targetFolder({ kind: "data", path: "x.json" })).toBe("");
    });

    it("dropPath", () => {
        expect(dropPath({ kind: "script", path: "a/x" }, "b")).toBe("b/x");
        expect(dropPath({ kind: "script", path: "a/x" }, "")).toBe("x");
        expect(dropPath({ kind: "data", path: "a/x.json" }, "a")).toBeNull();
        expect(dropPath({ kind: "folder", path: "a" }, "a")).toBeNull();
        expect(dropPath({ kind: "folder", path: "a" }, "a/b")).toBeNull();
        expect(dropPath({ kind: "folder", path: "a/b" }, "")).toBe("b");
        expect(dropPath({ kind: "folder", path: "a" }, "ab")).toBe("ab/a");
    });

    it("movedCollapsed keeps a moved folder's state and its subfolders'", () => {
        expect([...movedCollapsed(new Set(["a", "a/b", "c", "ab"]), "a", "z/a")].sort()).toEqual(["ab", "c", "z/a", "z/a/b"]);
    });
});
