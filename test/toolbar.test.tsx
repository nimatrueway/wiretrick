import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { flushSync } from "react-dom";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

beforeEach(() => {
    cleanup();
    vi.resetModules();
});

async function mount() {
    const { EditorToolbar } = await import("../src/ui/shell/EditorToolbar");
    const { toolbar } = await import("../src/ui/state/toolbar");
    const { settings } = await import("../src/ui/state/settings");
    const { layout } = await import("../src/ui/state/layout");
    const { actions } = await import("../src/ui/shell/actions");
    render(<EditorToolbar />);
    return { toolbar, settings, layout, actions };
}

describe("editor toolbar", () => {
    it("shows each save state as soon as it is set", async () => {
        const { toolbar, actions } = await mount();
        const btn = $<HTMLButtonElement>("#btn-save");
        expect(btn.disabled).toBe(true);
        expect(btn.dataset.state).toBe("saved");
        const seen: string[] = [];
        // each state is its own DOM write (oldValue: the state it replaced)
        new MutationObserver((recs) => recs.forEach((r) => seen.push(r.oldValue!))).observe(btn, { attributeFilter: ["data-state"], attributeOldValue: true });
        for (const state of ["unsaved", "saving", "saved"] as const) {
            flushSync(() => void Object.assign(toolbar.save, { state, disabled: state !== "unsaved", dim: state !== "unsaved" }));
            // synchronously, as the e2e tests read it
            expect(btn.dataset.state).toBe(state);
            expect(btn.querySelector(".save-label")!.textContent).toBe(state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Save");
        }
        expect(btn.classList.contains("dim")).toBe(true);
        expect(btn.title).toBe("Saved — no unsaved changes");
        await Promise.resolve();
        expect(seen).toEqual(["saved", "unsaved", "saving"]);
        actions.save = vi.fn();
        flushSync(() => void Object.assign(toolbar.save, { state: "unsaved", disabled: false, dim: false }));
        btn.click();
        expect(actions.save).toHaveBeenCalledOnce();
    });

    it("the Enabled switch is hidden for null and toggles through the action", async () => {
        const { toolbar, actions } = await mount();
        const label = $("#script-enabled");
        expect(label.hidden).toBe(true);
        act(() => void (toolbar.enabled = true));
        expect(label.hidden).toBe(false);
        expect(label.querySelector(".switch")!.classList.contains("on")).toBe(true);
        expect(label.getAttribute("aria-checked")).toBe("true");
        act(() => void (toolbar.enabled = false));
        expect(label.querySelector(".switch")!.classList.contains("on")).toBe(false);
        actions.toggleEnabled = vi.fn();
        label.click();
        expect(actions.toggleEnabled).toHaveBeenCalledOnce();
    });

    it("the status line is clickable only with an action", async () => {
        const { toolbar } = await mount();
        const el = $("#editor-status");
        act(() => void (toolbar.status = { text: "settings.json: bad", cls: "error", onClick: null }));
        expect(el.textContent).toBe("settings.json: bad");
        expect(el.className).toBe("error");
        const onClick = vi.fn();
        act(() => void (toolbar.status = { text: "Reload", cls: "", onClick }));
        expect(el.className).toBe("clickable");
        el.click();
        expect(onClick).toHaveBeenCalledOnce();
    });

    it("the typings note and the folder sync button follow the store", async () => {
        const { toolbar, settings } = await mount();
        expect($("#typings-note").hidden).toBe(true);
        act(() => void (toolbar.typings = true));
        expect($("#typings-note").hidden).toBe(false);
        const sync = $<HTMLButtonElement>("#btn-folder-sync");
        expect(sync.dataset.state).toBe("off");
        expect(sync.title).toBe("Folder sync is off — click to set it up");
        act(() => void (toolbar.sync = { state: "connected", path: "/home/me/tt" }));
        expect(sync.dataset.state).toBe("connected");
        expect(sync.getAttribute("aria-label")).toBe("Folder sync: connected");
        expect(sync.title).toBe('Synced with "/home/me/tt" — click for folder sync settings');
        await act(async () => void (settings.folder.supported = false));
        expect(sync.disabled).toBe(true);
        expect(sync.title).toContain("not in Firefox");
    });

    it("the open button follows the launch mode and canOpen", async () => {
        const { toolbar, settings } = await mount();
        const b = $<HTMLButtonElement>("#btn-open-vscode");
        expect(b.style.display).toBe("");
        expect(b.disabled).toBe(true);
        act(() => void (toolbar.canOpen = true));
        expect(b.disabled).toBe(false);
        expect(b.getAttribute("aria-label")).toBe("Open in VS Code");
        await act(async () => void (settings.launchMode = "vscode-insiders"));
        expect(b.classList.contains("insiders")).toBe(true);
        await act(async () => void (settings.launchMode = "custom"));
        expect(b.classList.contains("custom")).toBe(true);
        expect(b.disabled).toBe(true);
        expect(b.title).toBe("Set the editor URL in Settings → Open button");
        await act(async () => void (settings.editorUrl = "idea://open?file={path}"));
        expect(b.disabled).toBe(false);
        await act(async () => void (settings.launchMode = "off"));
        expect(b.style.display).toBe("none");
        expect(b.disabled).toBe(true);
    });

    it("the layout toggles show and flip the layout", async () => {
        const { layout, actions } = await mount();
        actions.setSidebarHidden = vi.fn();
        actions.setPanelHidden = vi.fn();
        expect($("#btn-toggle-sidebar").getAttribute("aria-pressed")).toBe("true");
        act(() => void (layout.panelHidden = true));
        expect($("#btn-toggle-panel").getAttribute("aria-pressed")).toBe("false");
        $("#btn-toggle-sidebar").click();
        $("#btn-toggle-panel").click();
        expect(actions.setSidebarHidden).toHaveBeenCalledWith(true);
        expect(actions.setPanelHidden).toHaveBeenCalledWith(false);
    });
});

describe("explorer resize handle", () => {
    it("resizes the explorer within 200–620 px and saves the width once let go", async () => {
        const { SplitV } = await import("../src/ui/shell/EditorToolbar");
        const { layout } = await import("../src/ui/state/layout");
        const sidebar = document.createElement("div");
        sidebar.id = "sidebar";
        document.body.append(sidebar);
        render(<SplitV />);
        const handle = $("#split-v");
        fireEvent.mouseDown(handle, { clientX: 300 });
        expect(handle.classList.contains("dragging")).toBe(true);
        fireEvent.mouseMove(document, { clientX: 100 });
        expect(sidebar.style.width).toBe("200px");
        fireEvent.mouseMove(document, { clientX: 900 });
        expect(sidebar.style.width).toBe("620px");
        fireEvent.mouseMove(document, { clientX: 333 });
        expect(sidebar.style.width).toBe("333px");
        // jsdom has no layout: offsetWidth is 0
        Object.defineProperty(sidebar, "offsetWidth", { value: 333 });
        fireEvent.mouseUp(document);
        expect(handle.classList.contains("dragging")).toBe(false);
        expect(layout.sidebarW).toBe(333);
        fireEvent.mouseMove(document, { clientX: 500 });
        expect(sidebar.style.width).toBe("333px");
        sidebar.remove();
    });
});
