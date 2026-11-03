import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const KEY = "resPanelLayout";

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

async function fresh() {
    vi.resetModules();
    return import("../src/ui/state/layout");
}

describe("layout store", () => {
    beforeEach(() => {
        cleanup();
        // Node's own (file-less) localStorage would shadow the DOM one
        vi.stubGlobal("localStorage", memoryStorage());
    });

    it("starts from what is stored", async () => {
        localStorage.setItem(KEY, JSON.stringify({ sidebarHidden: true, sidebarW: 300 }));
        const { layout } = await fresh();
        expect(layout.sidebarHidden).toBe(true);
        expect(layout.sidebarW).toBe(300);
    });

    it("survives a corrupt entry", async () => {
        localStorage.setItem(KEY, "{nope");
        const { layout } = await fresh();
        expect({ ...layout }).toEqual({});
    });

    it("saves changes at once, keeping keys another tab stored", async () => {
        const { layout } = await fresh();
        localStorage.setItem(KEY, JSON.stringify({ wordWrap: true }));
        layout.panelHidden = true;
        expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ wordWrap: true, panelHidden: true });
        layout.panelTab = "network";
        expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ wordWrap: true, panelHidden: true, panelTab: "network" });
    });

    it("drives the workbench's classes, sidebar width and toggle buttons", async () => {
        const { layout } = await fresh();
        const { Workbench } = await import("../src/ui/shell/Workbench");
        const { container } = render(<Workbench />);
        const app = container.querySelector("#app")!;
        expect(app.className).toBe("");
        expect(container.querySelector("#btn-toggle-sidebar")!.getAttribute("aria-pressed")).toBe("true");
        act(() => {
            layout.sidebarHidden = true;
            layout.panelHidden = true;
            layout.sidebarW = 321;
        });
        expect(app.className).toBe("sidebar-hidden panel-hidden");
        expect(container.querySelector("#btn-toggle-sidebar")!.getAttribute("aria-pressed")).toBe("false");
        expect(container.querySelector("#btn-toggle-panel")!.getAttribute("aria-pressed")).toBe("false");
        expect((container.querySelector("#sidebar") as HTMLElement).style.width).toBe("321px");
        expect(container.querySelector("#monaco-host")).not.toBeNull();
    });
});
