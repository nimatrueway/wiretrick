import { describe, it, expect } from "vitest";
import { buildPickTree, checkState, leavesOf, pathMatches, pickTreeRows, setChecked, toggleNode, visibleLeaves, type PickItem, type PickNode } from "../src/ui/pickTree";

const ITEMS: PickItem[] = [
    { path: "zeta.ts", kind: "script" },
    { path: "alpha.ts", kind: "script" },
    { path: "mock/helpers.ts", kind: "script" },
    { path: "mock/deep/x.tsx", kind: "script" },
    { path: "mock/b.json", kind: "data" },
    { path: "mock/A.json", kind: "data" },
    { path: "settings.yaml", kind: "settings" },
    { path: "mock/empty", kind: "folder" },
    { path: "Other", kind: "folder" },
];
const roots = buildPickTree(ITEMS);
const shape = (nodes: PickNode[]): any[] => nodes.map((n) => (n.children?.length ? { [n.name]: shape(n.children) } : n.name));
const names = (query = "", collapsed: string[] = []) => pickTreeRows(roots, query, new Set(collapsed)).map((r) => "  ".repeat(r.depth) + r.node.name + (r.open === undefined ? "" : r.open ? " ▾" : " ▸"));
const find = (path: string, nodes = roots): PickNode => {
    for (const n of nodes) {
        if (n.path === path) return n;
        if (n.children && path.startsWith(n.path + "/")) return find(path, n.children);
    }
    throw new Error(path);
};
const ALL = ITEMS.map(() => true);

describe("pick tree", () => {
    it("orders as the Explorer: settings.yaml, folders, scripts (in their order), data files", () => {
        expect(shape(roots)).toEqual(["settings.yaml", { mock: [{ deep: ["x.tsx"] }, "empty", "helpers.ts", "A.json", "b.json"] }, "Other", "zeta.ts", "alpha.ts"]);
        expect(find("mock/empty").item).toBe(7);
        expect(find("mock").item).toBeUndefined();
    });

    it("folders of differently-cased paths are one folder", () => {
        expect(shape(buildPickTree([{ path: "Mock/a.ts", kind: "script" }, { path: "mock/b.ts", kind: "script" }]))).toEqual([{ Mock: ["a.ts", "b.ts"] }]);
    });

    it("rows: folders expanded unless collapsed", () => {
        expect(names()).toEqual(["settings.yaml", "mock ▾", "  deep ▾", "    x.tsx", "  empty", "  helpers.ts", "  A.json", "  b.json", "Other", "zeta.ts", "alpha.ts"]);
        expect(names("", ["mock"])).toEqual(["settings.yaml", "mock ▸", "Other", "zeta.ts", "alpha.ts"]);
    });

    it("the filter: case-insensitive path substring; matches keep their folders, shown expanded", () => {
        expect(pathMatches("mock/Deep/x.tsx", " DEEP ")).toBe(true);
        expect(names("JSON", ["mock"])).toEqual(["mock ▾", "  A.json", "  b.json"]);
        expect(names("mock/")).toEqual(["mock ▾", "  deep ▾", "    x.tsx", "  empty", "  helpers.ts", "  A.json", "  b.json"]);
        expect(names("empty")).toEqual(["mock ▾", "  empty"]);
        expect(names("nothing")).toEqual([]);
        expect(visibleLeaves(roots, "json")).toEqual([5, 4]);
        expect(visibleLeaves(roots).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("a folder's box: on, off or mixed from its (shown) entries", () => {
        const mock = find("mock");
        expect(leavesOf(mock)).toEqual([3, 7, 2, 5, 4]);
        expect(checkState(mock, ALL)).toBe("on");
        const some = setChecked(ALL, [2], false);
        expect(checkState(mock, some)).toBe("mixed");
        expect(checkState(mock, some, "json")).toBe("on");
        expect(checkState(mock, setChecked(ALL, leavesOf(mock), false))).toBe("off");
        expect(checkState(find("mock/empty"), ALL)).toBe("on");
    });

    it("clicking a folder checks all it holds unless all are checked; with a filter, only what's shown", () => {
        const mock = find("mock");
        const off = toggleNode(mock, ALL);
        expect(leavesOf(mock).map((i) => off[i])).toEqual([false, false, false, false, false]);
        expect(off[0]).toBe(true);
        const mixed = setChecked(off, [2], true);
        expect(leavesOf(mock).map((i) => toggleNode(mock, mixed)[i])).toEqual([true, true, true, true, true]);
        const filtered = toggleNode(mock, ALL, "json");
        expect([filtered[4], filtered[5], filtered[2]]).toEqual([false, false, true]);
        expect(toggleNode(find("alpha.ts"), ALL)[1]).toBe(false);
    });
});
