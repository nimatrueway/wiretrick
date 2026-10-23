/** Tapped vs modified: log-line classification, the separate "tapped" log ring, and the Network filter/counts. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { interventionKind, tappedLine } from "../src/shared/netTypes";
import { addUiPort, allLogs, clearTab, log, logTapped, type LogEntry } from "../src/background/engine/logs";
import { matches, touchCounts, touchState, ALL_TYPES, type NetFilter } from "../src/ui/network/netFormat";
import type { NetEntry, NetIntervention } from "../src/shared/netTypes";

// these suites exercise the extension strategy: make it the settings default
beforeEach(() => setDefaultStrategy("extension"));
afterEach(() => setDefaultStrategy(null));

describe("interventionKind", () => {
    it("an explicit kind wins", () => {
        expect(interventionKind("info", "[S] x https://a/", "tapped")).toBe("tapped");
        expect(interventionKind("debug", "[S] x https://a/", "modified")).toBe("modified");
    });

    it("infers: engine INFO action lines → modified; tapped marks, debug, errors, script console → tapped", () => {
        expect(interventionKind("info", "[S] onResponseBody applied (1b → 2b) https://a/")).toBe("modified");
        expect(interventionKind("info", "[S] onRequest → redirect → https://b/ https://a/")).toBe("modified");
        expect(interventionKind("info", tappedLine("S", "onRequest", "https://a/"))).toBe("tapped");
        expect(interventionKind("debug", "[S] whatever https://a/")).toBe("tapped");
        expect(interventionKind("error", "[S] onRequest threw: x https://a/")).toBe("tapped");
        expect(interventionKind("info", "[S] console.log: fetching https://a/")).toBe("tapped");
        expect(interventionKind("warn", "[S] wt.log: hi https://a/")).toBe("tapped");
    });

    it("formats the tapped line with the handler and the URL last", () => {
        expect(tappedLine("Foo", "onRequest", "https://a.test/x")).toBe("[Foo] onRequest → observed (no change) https://a.test/x");
    });
});

describe("tapped log lines don't flood the log ring", () => {
    it("are kept in their own small per-tab ring, replayed and reported alongside", () => {
        const tab = 4242;
        clearTab(tab);
        log(tab, "[S] onResponseBody applied (1b → 2b) https://a/", "info", "s");
        for (let i = 0; i < 300; i++) logTapped(tab, "S", "onRequest", `https://a/${i}`, "s");
        const mine = allLogs().filter((e) => e.tabId === tab);
        expect(mine.filter((e) => e.kind === "tapped")).toHaveLength(50);
        expect(mine.filter((e) => e.level === "info")).toHaveLength(1);
        expect(mine[mine.length - 1].message).toBe("[S] onRequest → observed (no change) https://a/299");
        const replay: LogEntry[] = [];
        addUiPort({ postMessage: (m: any) => replay.push(m.entry), onDisconnect: { addListener: () => {} } } as any);
        expect(replay.filter((e) => e.tabId === tab)).toHaveLength(51);
        clearTab(tab);
        expect(allLogs().filter((e) => e.tabId === tab)).toEqual([]);
    });
});

describe("Network filter and counts", () => {
    const iv = (kind: "tapped" | "modified"): NetIntervention => ({ scriptId: "s", scriptName: "S", action: "x", level: kind === "tapped" ? "debug" : "info", kind, at: 0 });
    const e = (id: string, interventions: NetIntervention[]): NetEntry =>
        ({ id, tabId: 1, url: `https://a/${id}`, method: "GET", type: "script", status: 200, statusText: "", mime: "", size: 1, fromCache: false, startedAt: 0, endedAt: 1, state: "done", interventions }) as NetEntry;
    const missed: NetIntervention = { scriptId: "s", scriptName: "S", action: "onResponseBody never ran", level: "warn", kind: "missed", at: 0 };
    const rows = [e("none", []), e("tapped", [iv("tapped")]), e("both", [iv("tapped"), iv("modified")]), e("missed", [missed])];
    const f = (touched: NetFilter["touched"]): NetFilter => ({ text: "", types: ALL_TYPES, touched, tabId: null });

    it("classifies rows and filters all / tapped-only / modified / any; a missed warning is not a tap", () => {
        expect(rows.map(touchState)).toEqual(["none", "tapped", "modified", "none"]);
        expect(rows.filter((r) => matches(r, f("all"))).map((r) => r.id)).toEqual(["none", "tapped", "both", "missed"]);
        expect(rows.filter((r) => matches(r, f("tapped"))).map((r) => r.id)).toEqual(["tapped"]);
        expect(rows.filter((r) => matches(r, f("modified"))).map((r) => r.id)).toEqual(["both"]);
        expect(rows.filter((r) => matches(r, f("any"))).map((r) => r.id)).toEqual(["tapped", "both"]);
    });

    it("counts tapped-only and modified rows", () => {
        expect(touchCounts(rows)).toEqual({ tapped: 1, modified: 1 });
    });
});
