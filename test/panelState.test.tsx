import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { ref } from "valtio";
import type { LogLine } from "../src/ui/logQuery";
import type { ProblemGroup } from "../src/ui/problems";

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

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    cleanup();
    // Node's own (file-less) localStorage would shadow the DOM one
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
});

describe("persisted dock store", () => {
    it("starts from what is stored and falls back to bottom/left", async () => {
        localStorage.setItem("resPanelDock", JSON.stringify({ dock: "right" }));
        const { dockLayout, dockOf, sideOf } = await import("../src/ui/state/dock");
        expect(dockOf(dockLayout)).toBe("right");
        expect(sideOf(dockLayout)).toBe("left");
        localStorage.setItem("resPanelDock", "[1]");
        vi.resetModules();
        const fresh = await import("../src/ui/state/dock");
        expect(fresh.dockOf(fresh.dockLayout)).toBe("bottom");
    });

    it("writes only what this page changed, merging per-dock sizes", async () => {
        localStorage.setItem("resPanelDock", JSON.stringify({ size: { right: 400 } }));
        const { dockLayout } = await import("../src/ui/state/dock");
        // another Editor tab moves the explorer and resizes the bottom panel
        localStorage.setItem("resPanelDock", JSON.stringify({ side: "right", size: { right: 400, bottom: 250 } }));
        dockLayout.dock = "left";
        dockLayout.size = { ...dockLayout.size, left: 300 };
        await tick();
        expect(JSON.parse(localStorage.getItem("resPanelDock")!)).toEqual({ side: "right", dock: "left", size: { right: 400, bottom: 250, left: 300 } });
    });
});

describe("log store", () => {
    it("keeps the newest lines that pass the level and the filter", async () => {
        const { appendLog, shownLines, logState, logSources } = await import("../src/ui/state/log");
        for (let i = 0; i < 10; i++) appendLog({ at: 0, message: `[s${i % 2}] line ${i}`, level: i % 3 ? "info" : "debug" });
        expect(shownLines().map((l) => l.message)).toEqual(["[s1] line 1", "[s0] line 2", "[s0] line 4", "[s1] line 5", "[s1] line 7", "[s0] line 8"]);
        logState.cap = 2;
        expect(shownLines().map((l) => l.message)).toEqual(["[s1] line 7", "[s0] line 8"]);
        logState.cap = 500;
        logState.level = "debug";
        expect(shownLines()).toHaveLength(10);
        logState.filter = ref({ test: (e: LogLine) => e.source === "s1", mark: null });
        expect(shownLines().every((l) => l.source === "s1")).toBe(true);
        expect(logSources()).toEqual(["s0", "s1"]);
    });

    it("counts errors and warnings for the status bar until cleared", async () => {
        const { appendLog, clearLog, logState, shownLines } = await import("../src/ui/state/log");
        const { badges, panel } = await import("../src/ui/state/panel");
        const v = panel.badgeVersion;
        appendLog({ at: 0, message: "a", level: "error" });
        appendLog({ at: 0, message: "b", level: "warn" });
        appendLog({ at: 0, message: "c", level: "info" });
        expect(badges.log.counts).toEqual([["error", 1], ["warn", 1]]);
        expect(panel.badgeVersion).toBeGreaterThan(v);
        logState.scroll = "paused";
        clearLog();
        expect(shownLines()).toHaveLength(0);
        expect(badges.log.empty).toBe(true);
        expect(logState.scroll).toBe("follow");
    });

    it("keeps at most 300 'observed' lines and 2000 in all", async () => {
        const { appendLog, logState, shownLines } = await import("../src/ui/state/log");
        logState.level = "debug";
        logState.cap = 5000;
        for (let i = 0; i < 400; i++) appendLog({ at: 0, message: `o${i}`, level: "debug", kind: "observed" });
        expect(shownLines()).toHaveLength(300);
        expect(shownLines()[0].message).toBe("o100");
        for (let i = 0; i < 2000; i++) appendLog({ at: 0, message: `n${i}`, level: "error" });
        expect(shownLines()).toHaveLength(2000);
        expect(shownLines()[0].message).toBe("n0");
    });
});

const groups = (): ProblemGroup[] => [
    {
        id: "a",
        label: "Alpha.ts",
        file: "ts",
        problems: [
            { severity: "error", kind: "ts", message: "Type 'string' is not assignable", line: 3, column: 5 },
            { severity: "warning", kind: "route", message: "never matches" },
        ],
    },
    { id: "b", label: "Beta.ts", file: "ts", problems: [{ severity: "error", kind: "runtime", message: "boom", dismissible: true }] },
];

describe("Problems view", () => {
    it("lists problems by file; arrows move and collapse; Enter opens", async () => {
        const { ProblemsView } = await import("../src/ui/panel/ProblemsView");
        const { setProblems } = await import("../src/ui/state/panel");
        const { actions } = await import("../src/ui/shell/actions");
        const opened: string[] = [];
        actions.openProblem = (id, p) => void opened.push(`${id}:${p.message}`);
        setProblems(groups());
        const { container } = render(<ProblemsView hidden={false} />);
        await act(tick);
        const rows = () => [...container.querySelectorAll<HTMLElement>(".pb-row")];
        expect(rows().map((r) => r.dataset.key)).toEqual(["g:a", "p:a:0", "p:a:1", "g:b", "p:b:0"]);
        expect(rows().filter((r) => r.tabIndex === 0).map((r) => r.dataset.key)).toEqual(["g:a"]);
        expect(rows()[0].title).toBe("Alpha.ts: 1 error, 1 warning");
        act(() => rows()[0].focus());
        fireEvent.keyDown(rows()[0], { key: "ArrowDown" });
        expect(document.activeElement).toBe(rows()[1]);
        expect(rows()[1].tabIndex).toBe(0);
        fireEvent.keyDown(rows()[1], { key: "Enter" });
        expect(opened).toEqual(["a:Type 'string' is not assignable"]);
        fireEvent.keyDown(rows()[1], { key: "ArrowLeft" });
        expect(document.activeElement).toBe(rows()[0]);
        fireEvent.keyDown(rows()[0], { key: "ArrowLeft" });
        expect(rows().map((r) => r.dataset.key)).toEqual(["g:a", "g:b", "p:b:0"]);
        expect(rows()[0].getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(rows()[0]);
        fireEvent.click(rows()[0]);
        expect(rows()).toHaveLength(5);
    });

    it("says why the list is empty", async () => {
        const { ProblemsView } = await import("../src/ui/panel/ProblemsView");
        const { panel, setProblems } = await import("../src/ui/state/panel");
        const { container } = render(<ProblemsView hidden={false} />);
        await act(tick);
        expect(container.textContent).toBe("No problems have been detected in the scripts.");
        await act(async () => {
            setProblems(groups());
            panel.problemsFilter = "zzz";
            await tick();
        });
        expect(container.textContent).toBe("No results found with the provided filter.");
        await act(async () => {
            panel.problemsFilter = "boom";
            await tick();
        });
        expect([...container.querySelectorAll<HTMLElement>(".pb-row")].map((r) => r.dataset.key)).toEqual(["g:b", "p:b:0"]);
    });
});

describe("status bar", () => {
    it("shows each view's counts and opens it, or closes the panel when it is already open", async () => {
        const { StatusBar } = await import("../src/ui/shell/StatusBar");
        const { layout } = await import("../src/ui/state/layout");
        const { panel, setProblems } = await import("../src/ui/state/panel");
        const { appendLog } = await import("../src/ui/state/log");
        const { actions } = await import("../src/ui/shell/actions");
        actions.showPanelTab = (t) => void (layout.panelTab = t);
        actions.setPanelHidden = (h) => void (layout.panelHidden = h);
        layout.panelTab = "log";
        layout.panelHidden = false;
        const { container } = render(<StatusBar />);
        await act(async () => {
            setProblems(groups());
            appendLog({ at: 0, message: "x", level: "warn" });
            await tick();
        });
        const item = (id: string) => container.querySelector<HTMLElement>(`#${id}`)!;
        expect([...item("sb-problems").querySelectorAll<HTMLElement>(".sb-n")].map((n) => `${n.dataset.k}=${n.textContent}`)).toEqual(["error=2", "warn=1"]);
        expect(item("sb-log").className).toBe("sb-item active");
        expect(item("sb-log").getAttribute("aria-pressed")).toBe("true");
        expect(item("sb-log").title).toMatch(/^Log \(Alt\+Shift\+L\) — /);
        expect(item("sb-net").title).toBe("Network (Alt+Shift+N)");
        act(() => item("sb-problems").click());
        expect(layout.panelTab).toBe("problems");
        expect(item("sb-problems").className).toBe("sb-item active");
        act(() => item("sb-problems").click());
        expect(layout.panelHidden).toBe(true);
        expect(item("sb-problems").className).toBe("sb-item");
        await act(async () => {
            panel.statusBar = false;
            await tick();
        });
        expect(document.body.classList.contains("no-status")).toBe(true);
    });
});
