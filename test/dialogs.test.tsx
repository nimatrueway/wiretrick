import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
    cleanup();
    vi.resetModules();
});

describe("export/import picker", () => {
    async function open(warn = true) {
        const { BundlePicker } = await import("../src/ui/dialogs/BundlePicker");
        const { pickItems, dialogs } = await import("../src/ui/state/dialogs");
        render(<BundlePicker />);
        let result: Promise<number[] | null>;
        act(() => {
            result = pickItems({
                title: "Export",
                items: [
                    { path: "app.ts", kind: "script" },
                    { path: "lib/util.ts", kind: "script", badge: "new" },
                    { path: "lib/old.ts", kind: "script", checked: false },
                    { path: "lib/d.json", kind: "data" },
                    { path: "settings.yaml", kind: "settings" },
                    { path: "empty", kind: "folder" },
                ],
                confirm: "Export",
                // "app" imports "lib/util"
                warn: warn ? (sel) => (sel.includes(0) && !sel.includes(1) ? { text: "app imports lib/util", fix: [1] } : null) : undefined,
            });
        });
        return { result: result!, dialogs };
    }
    const box = (path: string) => $<HTMLInputElement>(`#bundle-picker .picker-row[data-path="${path}"] input`);
    const labels = () => $$("#bundle-picker .picker-label").map((e) => e.textContent);
    const type = (text: string) => fireEvent.change($(".picker-filter"), { target: { value: text } });

    it("shows the tree as the Explorer does, checked boxes as given, the filter focused", async () => {
        await open();
        expect(labels()).toEqual(["settings.yaml", "empty", "lib", "util.ts", "old.ts", "d.json", "app.ts"]);
        expect($$("#bundle-picker .picker-badge").map((e) => e.textContent)).toEqual(["new"]);
        expect(box("lib/old.ts").checked).toBe(false);
        expect(box("lib").indeterminate).toBe(true);
        expect(box("empty").checked).toBe(true);
        expect($(".picker-count").textContent).toBe("5 of 6 selected");
        expect(document.activeElement).toBe($(".picker-filter"));
        // a portal: next to the app, as before
        expect($("#bundle-picker").parentElement).toBe(document.body);
    });

    it("a folder's box checks (then unchecks) everything in it", async () => {
        await open(false);
        box("lib").click();
        expect([box("lib/util.ts"), box("lib/old.ts"), box("lib/d.json")].map((b) => b.checked)).toEqual([true, true, true]);
        expect(box("lib").checked).toBe(true);
        expect(box("lib").indeterminate).toBe(false);
        box("lib").click();
        expect([box("lib/util.ts"), box("lib/old.ts"), box("lib/d.json")].map((b) => b.checked)).toEqual([false, false, false]);
        expect($(".picker-count").textContent).toBe("3 of 6 selected");
    });

    it("the twistie collapses a folder", async () => {
        await open();
        fireEvent.click($('#bundle-picker .picker-row[data-path="lib"] .picker-twistie'));
        expect(labels()).toEqual(["settings.yaml", "empty", "lib", "app.ts"]);
        expect(box("lib").indeterminate).toBe(true);
        fireEvent.click($('#bundle-picker .picker-row[data-path="lib"] .picker-twistie'));
        expect(labels()).toContain("util.ts");
    });

    it("the filter narrows the tree by path; select all/none act on what it shows; Escape clears it", async () => {
        const { result } = await open(false);
        type("LIB/");
        expect(labels()).toEqual(["lib", "util.ts", "old.ts", "d.json"]);
        type("util");
        expect(labels()).toEqual(["lib", "util.ts"]);
        fireEvent.click($('[data-act="none"]'));
        // the folder's box shows what the filter shows
        expect(box("lib").checked).toBe(false);
        expect($(".picker-count").textContent).toBe("4 of 6 selected");
        type("zzz");
        expect(labels()).toEqual([]);
        expect($(".picker-none").textContent).toBe("Nothing matches the filter");
        fireEvent.keyDown($(".picker-filter"), { key: "Escape" });
        expect(($(".picker-filter") as HTMLInputElement).value).toBe("");
        expect(labels()).toHaveLength(7);
        expect(box("lib/util.ts").checked).toBe(false);
        fireEvent.click($('[data-act="all"]'));
        fireEvent.click($('[data-act="ok"]'));
        await expect(result).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("updates the warning as soon as a box is clicked; Add them re-checks the rows", async () => {
        const { result } = await open();
        const warn = $(".picker-warn");
        expect(warn.hidden).toBe(true);
        box("lib/util.ts").click();
        // read right after the click, as the e2e test does
        expect(warn.hidden).toBe(false);
        expect(warn.textContent).toContain("app imports lib/util");
        expect(warn.querySelector("button")!.hidden).toBe(false);
        expect($(".picker-count").textContent).toBe("4 of 6 selected");
        (warn.querySelector("button") as HTMLElement).click();
        expect(box("lib/util.ts").checked).toBe(true);
        expect(warn.hidden).toBe(true);
        fireEvent.keyDown(document, { key: "Enter" });
        await expect(result).resolves.toEqual([0, 1, 3, 4, 5]);
        expect(document.querySelector("#bundle-picker")).toBeNull();
    });

    it("select none disables OK (Enter does nothing); all re-checks", async () => {
        const { result } = await open(false);
        fireEvent.click($('[data-act="none"]'));
        expect(($('[data-act="ok"]') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.keyDown(document, { key: "Enter" });
        expect(document.querySelector("#bundle-picker")).not.toBeNull();
        fireEvent.click($('[data-act="all"]'));
        expect($(".picker-count").textContent).toBe("6 of 6 selected");
        fireEvent.click($('[data-act="ok"]'));
        await expect(result).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("Escape, Cancel and the backdrop cancel", async () => {
        let { result } = await open();
        const outer = vi.fn();
        document.addEventListener("keydown", outer);
        fireEvent.keyDown(document.body, { key: "Escape" });
        await expect(result).resolves.toBeNull();
        // the global Escape (closing Settings under it) doesn't see it
        expect(outer).not.toHaveBeenCalled();
        document.removeEventListener("keydown", outer);
        ({ result } = await open());
        fireEvent.mouseDown($("#bundle-picker"));
        await expect(result).resolves.toBeNull();
        ({ result } = await open());
        fireEvent.click($('.dialog-foot [data-act="cancel"]'));
        await expect(result).resolves.toBeNull();
    });
});

describe("conflict dialog", () => {
    async function open(theirs: string | null) {
        const { ConflictDialog } = await import("../src/ui/dialogs/ConflictDialog");
        const { resolveConflict } = await import("../src/ui/state/dialogs");
        const before = document.createElement("button");
        document.body.append(before);
        before.focus();
        render(<ConflictDialog />);
        let result: Promise<string>;
        act(() => void (result = resolveConflict({ name: "a.ts", theirs, mine: "mine" })));
        return { result: result!, before };
    }

    it("labels the choices with their keys and takes focus", async () => {
        const { result, before } = await open("theirs");
        expect($("#conflict-dialog h2").textContent).toBe('"a.ts" changed since you opened it');
        expect($$("#conflict-dialog .dialog-foot button").map((b) => [b.textContent, b.querySelector("u")?.textContent, b.dataset.act])).toEqual([
            ["Keep editing", "K", "cancel"],
            ["Take theirs", "T", "theirs"],
            ["Overwrite with mine", "O", "overwrite"],
        ]);
        expect(document.activeElement?.closest("#conflict-dialog")).not.toBeNull();
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
        await expect(result).resolves.toBe("cancel");
        expect(document.querySelector("#conflict-dialog")).toBeNull();
        expect(document.activeElement).toBe(before);
        before.remove();
    });

    it("ignores letter keys for a moment, then takes them", async () => {
        const now = vi.spyOn(performance, "now").mockReturnValue(1000);
        const { result, before } = await open(null);
        expect($("#conflict-dialog h2").textContent).toBe('"a.ts" was deleted');
        expect(document.querySelector(".conflict-diff")).toBeNull();
        fireEvent.keyDown(document.activeElement!, { key: "d" });
        expect(document.querySelector("#conflict-dialog")).not.toBeNull();
        now.mockReturnValue(1300);
        fireEvent.keyDown(document.activeElement!, { key: "d" });
        await expect(result).resolves.toBe("theirs");
        now.mockRestore();
        before.remove();
    });

    it("keeps keys from the page and focus inside", async () => {
        const { result, before } = await open("theirs");
        const outer = vi.fn();
        document.addEventListener("keydown", outer);
        fireEvent.keyDown($("#conflict-dialog .dialog"), { key: "x" });
        expect(outer).not.toHaveBeenCalled();
        before.focus();
        expect(document.activeElement?.closest("#conflict-dialog")).not.toBeNull();
        document.removeEventListener("keydown", outer);
        fireEvent.click($("#conflict-dialog"));
        await expect(result).resolves.toBe("cancel");
        before.remove();
    });
});

describe("help dialog", () => {
    it("filters the current tab and says when nothing matches", async () => {
        const { HelpDialog } = await import("../src/ui/dialogs/HelpDialog");
        const { openHelp, dialogs } = await import("../src/ui/state/dialogs");
        const { SAMPLES } = await import("../src/ui/samples");
        render(<HelpDialog />);
        await act(async () => openHelp("samples"));
        expect($("#help-panel").classList.contains("hidden")).toBe(false);
        expect($("#samples-body").hidden).toBe(false);
        expect($("#shortcuts-body").hidden).toBe(true);
        expect($$('[data-help-tab]').map((b) => b.getAttribute("data-help-tab"))).toEqual(["samples", "shortcuts"]);
        expect($$("#samples-list .sample")).toHaveLength(SAMPLES.length);
        await act(tick);
        expect(document.activeElement).toBe($("#samples-filter"));
        fireEvent.change($("#samples-filter"), { target: { value: SAMPLES[0].name } });
        expect($$("#samples-list .sample:not([hidden])").length).toBeGreaterThan(0);
        expect($$("#samples-list .sample:not([hidden])").length).toBeLessThan(SAMPLES.length);
        fireEvent.change($("#samples-filter"), { target: { value: "zzqqxx" } });
        expect($("#samples-empty").hidden).toBe(false);
        fireEvent.click($('[data-help-tab="shortcuts"]'));
        expect(dialogs.helpTab).toBe("shortcuts");
        await act(tick);
        expect($("#shortcuts-body").hidden).toBe(false);
        expect($('[data-help-tab="shortcuts"]').getAttribute("aria-selected")).toBe("true");
        expect($$("#shortcuts-table tbody tr").length).toBeGreaterThan(0);
        fireEvent.change($("#shortcuts-filter"), { target: { value: "zzqqxx" } });
        expect($("#shortcuts-empty").hidden).toBe(false);
        fireEvent.click($("#help-panel .btn-close"));
        await act(tick);
        expect($("#help-panel").classList.contains("hidden")).toBe(true);
    });
});

describe("install dialog", () => {
    it("opens on the picker, starts over with a drop, highlights a drag and closes", async () => {
        const { InstallDialog } = await import("../src/ui/dialogs/InstallDialog");
        const { openInstall, dialogs } = await import("../src/ui/state/dialogs");
        render(<InstallDialog />);
        expect($("#install-dialog")).toBeNull();
        await act(async () => openInstall());
        expect($("#install-dialog-title").textContent).toBe("Install Script");
        expect($("#install-drop")).not.toBeNull();
        expect($("#install-dialog h1")).toBeNull();
        const dataTransfer = { types: ["Files"], items: [], files: [new File(["# hi"], "notes.md")], getData: () => "", dropEffect: "" };
        fireEvent.dragOver($("#install-dialog"), { dataTransfer });
        expect($(".install-dialog").classList.contains("dropping")).toBe(true);
        await act(async () => void fireEvent.drop($("#install-drop"), { dataTransfer }));
        await act(tick);
        expect($(".install-dialog").classList.contains("dropping")).toBe(false);
        expect($("#install-dialog .err").textContent).toContain("notes.md has no script");
        fireEvent.click($("#install-dialog .btn-close"));
        await act(tick);
        expect(dialogs.install).toBeNull();
        expect($("#install-dialog")).toBeNull();
    });
});

describe("settings dialog", () => {
    it("has no Strategies section", async () => {
        const { SettingsDialog } = await import("../src/ui/dialogs/SettingsDialog");
        render(<SettingsDialog />);
        expect(document.querySelector("#settings-sec-strategy")).toBeNull();
        expect(document.querySelector(".strategy-table")).toBeNull();
        expect(document.body.textContent).not.toContain("Strategies");
    });

    it("picks a folder with one button and disconnects with another", async () => {
        const { SettingsDialog } = await import("../src/ui/dialogs/SettingsDialog");
        const { settings } = await import("../src/ui/state/settings");
        const { actions } = await import("../src/ui/shell/actions");
        const folderButton = vi.fn();
        const folderDisconnect = vi.fn();
        Object.assign(actions, { folderButton, folderDisconnect });
        settings.folder.supported = true;
        settings.folder.mode = "off";
        render(<SettingsDialog />);
        expect($("#btn-vscode").textContent).toBe("Choose Folder…");
        expect($("#btn-folder-disconnect")).toBeNull();
        await act(async () => void Object.assign(settings.folder, { mode: "synced", path: "scripts" }));
        // picking again replaces the folder (a cancelled pick keeps it): stopping is its own button
        expect($("#btn-vscode").textContent).toBe("Change Folder…");
        fireEvent.click($("#btn-vscode"));
        expect(folderButton).toHaveBeenCalledTimes(1);
        expect(folderDisconnect).not.toHaveBeenCalled();
        fireEvent.click($("#btn-folder-disconnect"));
        expect(folderDisconnect).toHaveBeenCalledTimes(1);
        await act(async () => void (settings.folder.mode = "reconnect"));
        expect($("#btn-vscode").textContent).toBe("Reconnect");
        expect($("#btn-folder-disconnect")).not.toBeNull();
        await act(async () => void (settings.folder.mode = "off"));
    });
});

describe("quick open", () => {
    it("filters, moves with the arrows and opens on Enter", async () => {
        const { QuickOpen } = await import("../src/ui/dialogs/QuickOpen");
        const { dialogs } = await import("../src/ui/state/dialogs");
        const { actions } = await import("../src/ui/shell/actions");
        actions.quickOpenItems = () => [
            { id: "s", name: "settings.yaml" },
            { id: "a", name: "alpha" },
            { id: "b", name: "beta" },
        ];
        const openQuick = vi.fn();
        actions.openQuick = openQuick;
        render(<QuickOpen />);
        await act(async () => void (dialogs.quickOpen = true));
        expect($("#quick-open").classList.contains("hidden")).toBe(false);
        expect(document.activeElement).toBe($("#qo-input"));
        expect($$(".qo-item").map((e) => e.textContent)).toEqual(["settings.yaml", "alpha", "beta"]);
        fireEvent.change($("#qo-input"), { target: { value: "a" } });
        expect($$(".qo-item").map((e) => e.textContent)).toEqual(["alpha", "beta", "settings.yaml"]);
        fireEvent.keyDown($("#qo-input"), { key: "ArrowDown" });
        expect($(".qo-item.active").dataset.id).toBe("b");
        fireEvent.keyDown($("#qo-input"), { key: "Enter" });
        await act(tick);
        expect(openQuick).toHaveBeenCalledWith("b");
        expect($("#quick-open").classList.contains("hidden")).toBe(true);
        // reopened: empty query, first row active
        await act(async () => void (dialogs.quickOpen = true));
        expect(($("#qo-input") as HTMLInputElement).value).toBe("");
        expect($(".qo-item.active").dataset.id).toBe("s");
        fireEvent.keyDown($("#qo-input"), { key: "Escape" });
        await act(tick);
        expect(dialogs.quickOpen).toBe(false);
    });
});

describe("settings store", () => {
    it("describes the scripts folder", async () => {
        const { folderStateText } = await import("../src/ui/state/settings");
        expect(folderStateText({ mode: "synced", path: "scripts" })).toBe("scripts");
        expect(folderStateText({ mode: "synced", path: "" })).toBe("(syncing)");
        expect(folderStateText({ mode: "reconnect", path: "x" })).toBe("reconnect needed");
        expect(folderStateText({ mode: "off", path: "x" })).toBe("");
    });

    it("shows the helper's state and the buttons it needs", async () => {
        const { helperView } = await import("../src/ui/state/settings");
        const missing = helperView({ state: "missing", extensionId: "abc" } as any);
        expect(missing.state).toBe("not installed");
        expect(missing.installCommand).toContain("abc");
        expect(missing.detail).toContain(missing.installCommand);
        expect(missing.retry).toBe(true);
        expect(missing.trust).toBe(false);
        const ready = helperView({ state: "ready", version: "1.2", port: 8080, caTrusted: false, extensionId: "abc", scripts: ["one"] } as any);
        expect(ready.state).toBe("running (v1.2) on 127.0.0.1:8080");
        expect(ready.detail.split("\n")[0]).toBe("Scripts: one");
        expect(ready).toMatchObject({ installCommand: "", retry: false, trust: true });
        expect(helperView({ state: "idle", extensionId: "" } as any).retry).toBe(false);
    });
});

describe("welcome page", () => {
    it("lists the samples; close shows only when there are scripts to go back to", async () => {
        const { Welcome } = await import("../src/ui/dialogs/Welcome");
        const { dialogs } = await import("../src/ui/state/dialogs");
        const { explorer } = await import("../src/ui/state/explorer");
        const { SAMPLES } = await import("../src/ui/samples");
        render(<Welcome />);
        expect($("#welcome").hidden).toBe(true);
        await act(async () => void (dialogs.welcome = true));
        expect($("#welcome").hidden).toBe(false);
        expect($$(".welcome-card")).toHaveLength(SAMPLES.length);
        expect($(`.welcome-card[data-sample="${SAMPLES[0].name}"] .welcome-try`).textContent).toBe("Try it");
        expect($("#welcome-close").hidden).toBe(true);
        await act(async () => void (explorer.scripts = [{ id: "x" }] as any));
        expect($("#welcome-close").hidden).toBe(false);
    });
});
