/** Seen vs altered: log-line classification, the separate "seen" log ring, and the Network filter/counts. */
import { describe, it, expect } from "vitest";
import { interventionKind, seenLine } from "../src/shared/netTypes";
import { addUiPort, allLogs, clearTab, log, logSeen, type LogEntry } from "../src/background/engine/logs";
import { matches, touchCounts, touchState, ALL_TYPES, type NetFilter } from "../src/ui/network/netFormat";
import type { NetEntry, NetIntervention } from "../src/shared/netTypes";

describe("interventionKind", () => {
    it("an explicit kind wins", () => {
        expect(interventionKind("info", "[S] x https://a/", "seen")).toBe("seen");
        expect(interventionKind("debug", "[S] x https://a/", "altered")).toBe("altered");
    });

    it("infers: engine INFO action lines → altered; seen marks, debug, errors, script console → seen", () => {
        expect(interventionKind("info", "[S] modifyResponse applied (1b → 2b) https://a/")).toBe("altered");
        expect(interventionKind("info", "[S] onRequest → redirect → https://b/ https://a/")).toBe("altered");
        expect(interventionKind("info", seenLine("S", "onRequest", "https://a/"))).toBe("seen");
        expect(interventionKind("debug", "[S] whatever https://a/")).toBe("seen");
        expect(interventionKind("error", "[S] onRequest threw: x https://a/")).toBe("seen");
        expect(interventionKind("info", "[S] console.log: fetching https://a/")).toBe("seen");
        expect(interventionKind("warn", "[S] wt.log: hi https://a/")).toBe("seen");
    });

    it("formats the seen line with the handler and the URL last", () => {
        expect(seenLine("Foo", "onRequest", "https://a.test/x")).toBe("[Foo] onRequest → seen (no change) https://a.test/x");
    });
});

describe("seen log lines don't flood the log ring", () => {
    it("are kept in their own small per-tab ring, replayed and reported alongside", () => {
        const tab = 4242;
        clearTab(tab);
        log(tab, "[S] modifyResponse applied (1b → 2b) https://a/", "info", "s");
        for (let i = 0; i < 300; i++) logSeen(tab, "S", "onRequest", `https://a/${i}`, "s");
        const mine = allLogs().filter((e) => e.tabId === tab);
        expect(mine.filter((e) => e.kind === "seen")).toHaveLength(50);
        expect(mine.filter((e) => e.level === "info")).toHaveLength(1);
        expect(mine[mine.length - 1].message).toBe("[S] onRequest → seen (no change) https://a/299");
        const replay: LogEntry[] = [];
        addUiPort({ postMessage: (m: any) => replay.push(m.entry), onDisconnect: { addListener: () => {} } } as any);
        expect(replay.filter((e) => e.tabId === tab)).toHaveLength(51);
        clearTab(tab);
        expect(allLogs().filter((e) => e.tabId === tab)).toEqual([]);
    });
});

describe("Network filter and counts", () => {
    const iv = (kind: "seen" | "altered"): NetIntervention => ({ scriptId: "s", scriptName: "S", action: "x", level: kind === "seen" ? "debug" : "info", kind, at: 0 });
    const e = (id: string, interventions: NetIntervention[]): NetEntry =>
        ({ id, tabId: 1, url: `https://a/${id}`, method: "GET", type: "script", status: 200, statusText: "", mime: "", size: 1, fromCache: false, startedAt: 0, endedAt: 1, state: "done", interventions }) as NetEntry;
    const rows = [e("none", []), e("seen", [iv("seen")]), e("both", [iv("seen"), iv("altered")])];
    const f = (touched: NetFilter["touched"]): NetFilter => ({ text: "", types: ALL_TYPES, touched, tabId: null });

    it("classifies rows and filters all / seen (incl. altered) / altered", () => {
        expect(rows.map(touchState)).toEqual(["none", "seen", "altered"]);
        expect(rows.filter((r) => matches(r, f("all"))).map((r) => r.id)).toEqual(["none", "seen", "both"]);
        expect(rows.filter((r) => matches(r, f("seen"))).map((r) => r.id)).toEqual(["seen", "both"]);
        expect(rows.filter((r) => matches(r, f("altered"))).map((r) => r.id)).toEqual(["both"]);
    });

    it("counts seen (any script ran) and altered rows", () => {
        expect(touchCounts(rows)).toEqual({ seen: 2, altered: 1 });
    });
});
