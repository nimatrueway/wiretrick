import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
        get length() {
            return m.size;
        },
        key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => m.get(k) ?? null,
        setItem: (k, v) => void m.set(k, String(v)),
        removeItem: (k) => void m.delete(k),
        clear: () => m.clear(),
    };
}

const script = (id: string, name: string, extra: Record<string, unknown> = {}): any => ({ id, code: "", enabled: true, meta: { name, match: ["*://example.com/*"], active: true }, ...extra });
const data = (id: string, path: string): any => ({ id, path, text: "{}" });

/** mock/ (beta, limits.json, deep/ (gamma)), empty/, alpha, delta */
const fixture = {
    scripts: [script("s_a", "alpha"), script("s_b", "mock/beta"), script("s_c", "mock/deep/gamma"), script("s_d", "delta", { error: "boom" })],
    dataFiles: [data("d_l", "mock/limits.json")],
    folders: ["mock", "mock/deep", "empty"],
    selectedId: "s_a" as string | null,
    typingsShown: false,
    dirty: false,
};

beforeEach(() => {
    cleanup();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
});

async function load(over: Partial<typeof fixture> = {}) {
    const store = await import("../src/ui/state/explorer");
    store.syncExplorer({ ...fixture, ...over });
    return store;
}

describe("explorer store", () => {
    it("restores and persists the collapsed folders, and prunes gone ones", async () => {
        localStorage.setItem("wtExplorerCollapsed", JSON.stringify(["mock", "gone"]));
        const s = await load();
        expect([...s.explorer.collapsed]).toEqual(["mock", "gone"]);
        expect(s.visibleRows().map((r) => r.id)).not.toContain("s_b");
        s.pruneCollapsed();
        expect(JSON.parse(localStorage.getItem("wtExplorerCollapsed")!)).toEqual(["mock"]);
        s.setFolderExpanded("mock", true);
        s.collapseAll();
        expect(JSON.parse(localStorage.getItem("wtExplorerCollapsed")!).sort()).toEqual(["empty", "mock", "mock/deep"]);
        s.revealInExplorer("mock/deep/gamma");
        expect([...s.explorer.collapsed]).toEqual(["empty"]);
    });

    it("selects ranges and toggles rows from the cursor; actions apply to the top-level selected rows", async () => {
        const s = await load();
        s.moveFocus("s_b");
        s.selectRange("s_a");
        // the shown order: empty/, mock/, deep/, gamma, beta, limits.json, alpha, delta
        expect([...s.explorer.sel]).toEqual(["s_b", "d_l", "s_a"]);
        expect(s.explorer.focusedId).toBe("s_a");
        s.toggleSel("d_l");
        expect([...s.explorer.sel]).toEqual(["s_b", "s_a"]);
        s.clearSel();
        s.toggleSel("dir:mock");
        expect([...s.explorer.sel]).toEqual(["d_l", "dir:mock"]); // the cursor row joins a new selection
        s.toggleSel("s_c");
        s.toggleSel("s_a");
        expect(s.actionRows("s_c").map((r) => r.id)).toEqual(["dir:mock", "s_a"]);
        expect(s.actionRows("s_d").map((r) => r.id)).toEqual(["s_d"]);
    });

    it("forgets selected rows (and a rename) that are gone", async () => {
        const s = await load();
        s.setSel(["s_a", "s_d"]);
        s.startRename("s_d");
        s.syncExplorer({ ...fixture, scripts: fixture.scripts.filter((x) => x.id !== "s_d") });
        expect([...s.explorer.sel]).toEqual(["s_a"]);
        expect(s.explorer.editing).toBeNull();
    });

    it("New … opens the section, reveals the target folder and doesn't stack inputs", async () => {
        localStorage.setItem("wtExplorerCollapsed", JSON.stringify(["mock", "mock/deep"]));
        const s = await load();
        s.explorer.sectionOpen = false;
        s.explorer.focusedId = "dir:mock/deep";
        s.startCreate("data");
        expect(s.explorer.editing).toEqual({ mode: "create", kind: "data", folder: "mock/deep" });
        expect(s.explorer.sectionOpen).toBe(true);
        expect([...s.explorer.collapsed]).toEqual([]);
        s.startCreate("folder", "");
        expect(s.explorer.editing).toMatchObject({ kind: "data" });
    });
});

async function mount(over: Partial<typeof fixture> = {}) {
    const s = await load(over);
    const { actions } = await import("../src/ui/shell/actions");
    const { ExplorerTree } = await import("../src/ui/explorer/Explorer");
    const { ContextMenu } = await import("../src/ui/explorer/ContextMenu");
    const r = render(
        <>
            <ExplorerTree />
            <ContextMenu />
        </>
    );
    const list = r.container.querySelector("#script-list") as HTMLElement;
    const row = (id: string) => r.container.querySelector(`#explorer-${CSS.escape(encodeURIComponent(id))}`) as HTMLElement;
    const key = (k: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(list, { key: k, ...init }));
    return { s, actions, r, list, row, key };
}

describe("explorer tree", () => {
    it("renders settings.yaml, folders, files and their state classes", async () => {
        const { row, list } = await mount({ dirty: true });
        expect([...list.querySelectorAll(":scope > li")].map((l) => l.id)).toEqual(["explorer-__settings__", "explorer-dir%3Aempty", "explorer-dir%3Amock", "explorer-dir%3Amock%2Fdeep", "explorer-s_c", "explorer-s_b", "explorer-d_l", "explorer-s_a", "explorer-s_d"]);
        expect(row("s_a").className).toBe("script-item handlers selected focused dirty"); // registers handlers: bold
        expect(row("__settings__").className).toBe("script-item");
        expect(row("s_d").className).toBe("script-item handlers has-error");
        expect(row("s_d").querySelector(".err-ind.compile")).not.toBeNull();
        expect(row("s_c").style.getPropertyValue("--depth")).toBe("2");
        expect(row("dir:mock").getAttribute("aria-expanded")).toBe("true");
        expect(list.getAttribute("aria-activedescendant")).toBe("explorer-s_a");
    });

    it("moves the cursor and folds folders with the keys; Enter opens", async () => {
        const { s, actions, row, key, list } = await mount();
        const select = vi.spyOn(actions, "select");
        key("Home");
        key("ArrowDown");
        key("ArrowDown");
        expect(list.getAttribute("aria-activedescendant")).toBe("explorer-dir%3Amock");
        key("ArrowLeft");
        expect(row("dir:mock").getAttribute("aria-expanded")).toBe("false");
        expect(row("s_b")).toBeNull();
        expect(JSON.parse(localStorage.getItem("wtExplorerCollapsed")!)).toEqual(["mock"]);
        key("ArrowRight");
        key("ArrowRight");
        expect(s.explorer.focusedId).toBe("dir:mock/deep");
        key("ArrowDown");
        key("ArrowLeft");
        expect(s.explorer.focusedId).toBe("dir:mock/deep");
        key("Enter");
        expect(row("s_c")).toBeNull();
        key("End");
        key("Enter");
        expect(select).toHaveBeenCalledWith("s_d");
        key("ArrowUp", { shiftKey: true });
        expect(row("s_a").className).toContain("multi");
        expect(row("s_d").className).toContain("multi");
        key("Escape");
        expect(s.explorer.sel.size).toBe(0);
    });

    it("⌘/Ctrl- and Shift-click build a selection without opening; a plain click opens", async () => {
        const { s, actions, row } = await mount();
        const select = vi.spyOn(actions, "select");
        act(() => void fireEvent.click(row("s_d"), { ctrlKey: true }));
        expect([...s.explorer.sel]).toEqual(["s_a", "s_d"]);
        act(() => void fireEvent.click(row("d_l"), { shiftKey: true }));
        expect([...s.explorer.sel]).toEqual(["d_l", "s_a", "s_d"]); // from the anchor (the last ⌘-clicked row)
        expect(select).not.toHaveBeenCalled();
        act(() => void fireEvent.click(row("s_b")));
        expect(select).toHaveBeenCalledWith("s_b");
        expect([...s.explorer.sel]).toEqual(["s_b"]);
        act(() => void fireEvent.click(row("dir:empty")));
        expect(row("dir:empty").getAttribute("aria-expanded")).toBe("false");
    });

    it("right-click shows the row's menu; a menu item runs and closes it", async () => {
        const { actions, row, s } = await mount();
        const enable = vi.spyOn(actions, "setScriptEnabled");
        act(() => void fireEvent.contextMenu(row("s_b"), { clientX: 10, clientY: 10 }));
        const items = () => [...document.querySelectorAll(".ctx-menu li")].map((l) => (l.classList.contains("sep") ? "-" : l.textContent));
        expect(items()).toEqual(["OpenEnter", "-", "Disable", "-", "Make Package…", "Export Package…", "-", "New Script…", "New JSON File…", "New Folder…", "-", "Copy Path", "-", "Rename…F2", "DeleteDelete"]);
        act(() => void fireEvent.click([...document.querySelectorAll(".ctx-menu li")].find((l) => l.textContent === "Disable")!));
        expect(enable).toHaveBeenCalledWith("s_b", false);
        expect(document.querySelector(".ctx-menu")).toBeNull();
        act(() => void fireEvent.contextMenu(row("dir:mock")));
        expect(items().slice(0, 6)).toEqual(["Expand AllCtrl+→", "Fold AllCtrl+←", "-", "Make Package…", "-", "New Script…"]);
        act(() => void fireEvent.click([...document.querySelectorAll(".ctx-menu li")].find((l) => l.textContent?.startsWith("Fold All"))!));
        expect([...s.explorer.collapsed].sort()).toEqual(["mock", "mock/deep"]);
        expect(row("dir:empty").getAttribute("aria-expanded")).toBe("true");
        act(() => void fireEvent.contextMenu(row("dir:mock")));
        act(() => void fireEvent.click([...document.querySelectorAll(".ctx-menu li")].find((l) => l.textContent?.startsWith("Expand All"))!));
        expect([...s.explorer.collapsed]).toEqual([]);
        expect(row("dir:mock/deep").getAttribute("aria-expanded")).toBe("true");
        // Ctrl+← / Ctrl+→ (PC) and Alt-click fold/expand recursively
        const list = document.querySelector("#script-list")!;
        act(() => void fireEvent.keyDown(list, { key: "ArrowLeft", ctrlKey: true }));
        expect([...s.explorer.collapsed].sort()).toEqual(["mock", "mock/deep"]);
        act(() => void fireEvent.click(row("dir:mock"), { altKey: true }));
        expect([...s.explorer.collapsed]).toEqual([]);
        act(() => void fireEvent.contextMenu(row("dir:mock")));
        act(() => void fireEvent.keyDown(document, { key: "Escape" }));
        expect(document.querySelector(".ctx-menu")).toBeNull();
    });

    it("F2 renames in place: the name is selected, bad characters are stripped, Enter moves it", async () => {
        const { actions, row, key, s } = await mount();
        let finish!: () => void;
        const move = vi.spyOn(actions, "moveRows").mockImplementation(() => new Promise<void>((r) => (finish = r)));
        key("F2");
        const input = row("s_a").querySelector("input.script-rename") as HTMLInputElement;
        expect(input.value).toBe("alpha.ts");
        expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
        input.value = "mock/omega?.ts";
        act(() => void fireEvent.input(input));
        expect(input.value).toBe("mock/omega.ts");
        act(() => void fireEvent.keyDown(input, { key: "Enter" }));
        expect(move).toHaveBeenCalledWith([{ item: expect.objectContaining({ id: "s_a" }), to: "mock/omega" }]);
        // the input stays until the move is done
        expect(row("s_a").querySelector("input.script-rename")).not.toBeNull();
        await act(async () => finish());
        expect(s.explorer.editing).toBeNull();
        expect(row("s_a").querySelector(".script-name")).not.toBeNull();
    });

    it("double-click renames a file but not a folder; Escape cancels", async () => {
        const { actions, row } = await mount();
        const move = vi.spyOn(actions, "moveRows");
        act(() => void fireEvent.doubleClick(row("dir:mock").querySelector(".script-name")!));
        expect(document.querySelector("input.script-rename")).toBeNull();
        act(() => void fireEvent.doubleClick(row("d_l").querySelector(".script-name")!));
        const input = row("d_l").querySelector("input.script-rename") as HTMLInputElement;
        expect(input.value).toBe("mock/limits.json");
        expect([input.selectionStart, input.selectionEnd]).toEqual([5, 11]);
        act(() => void fireEvent.keyDown(input, { key: "Escape" }));
        expect(row("d_l").querySelector("input")).toBeNull();
        expect(move).not.toHaveBeenCalled();
    });

    it("New … puts the name input right below its folder and creates on Enter", async () => {
        const { s, actions, list } = await mount();
        const create = vi.spyOn(actions, "createItem");
        act(() => s.startCreate("data", "mock"));
        const ids = [...list.querySelectorAll(":scope > li")].map((l) => l.id || l.className);
        expect(ids.slice(2, 4)).toEqual(["explorer-dir%3Amock", "script-item creating"]);
        const input = list.querySelector("li.creating input") as HTMLInputElement;
        expect(input.placeholder).toBe("name.json, .md or .svg");
        input.value = "users";
        act(() => void fireEvent.keyDown(input, { key: "Enter" }));
        expect(create).toHaveBeenCalledWith("data", "mock/users.json");
        expect(list.querySelector("li.creating")).toBeNull();
        act(() => s.startCreate("script", ""));
        expect(list.querySelectorAll(":scope > li")[1].className).toBe("script-item creating");
    });

    it("renders custom script and bundle icons on Explorer script and package folder rows", async () => {
        const { s, row } = await mount();
        act(() =>
            s.syncExplorer({
                ...fixture,
                scripts: [
                    script("s_a", "alpha", { meta: { name: "alpha", match: ["*://example.com/*"], active: true, metadata: { icon: "data:image/png;base64,BBBB", connect: [] } } }),
                    script("s_b", "mock/beta"),
                ],
                dataFiles: [
                    { id: "d_m", path: "mock/metadata.json", text: JSON.stringify({ name: "Mock Kit", icon: "icon.svg", scripts: ["beta.ts"] }), savedAt: 1 },
                    { id: "d_i", path: "mock/icon.svg", text: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>', savedAt: 1 },
                    { id: "d_readme", path: "README.md", text: "# Hello", savedAt: 1 },
                ],
            })
        );
        expect(row("s_a").querySelector<HTMLImageElement>(".file-icon img")?.getAttribute("src")).toBe("data:image/png;base64,BBBB");
        expect(row("dir:mock").querySelector<HTMLImageElement>(".file-icon.package img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
        expect(row("s_b").querySelector<HTMLImageElement>(".file-icon img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
        expect(row("d_readme").querySelector(".file-icon.md")?.textContent).toBe("MD");
    });
});
