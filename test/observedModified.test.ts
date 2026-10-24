/** Observed vs modified: log-line classification, the separate "observed" log ring, and the Network filter/counts. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setDefaultStrategy } from "../src/shared/route";
import { outcomeKind, observedLine } from "../src/shared/netTypes";
import { addUiPort, allLogs, clearTab, log, logObserved, type LogEntry } from "../src/background/engine/logs";
import { touchCounts, touchState } from "../src/ui/network/netFormat";
import { compileQuery, parseQuery } from "../src/ui/network/netQuery";
import type { NetEntry, NetOutcome } from "../src/shared/netTypes";

// these suites exercise the extension strategy: make it the settings default
beforeEach(() => setDefaultStrategy("extension"));
afterEach(() => setDefaultStrategy(null));

describe("outcomeKind", () => {
    it("an explicit kind wins", () => {
        expect(outcomeKind("info", "[S] x https://a/", "observed")).toBe("observed");
        expect(outcomeKind("debug", "[S] x https://a/", "modified")).toBe("modified");
    });

    it("infers: engine INFO action lines → modified; observed marks, debug, errors, script console → observed", () => {
        expect(outcomeKind("info", "[S] onResponseBody applied (1b → 2b) https://a/")).toBe("modified");
        expect(outcomeKind("info", "[S] onRequest → redirect https://a/ → https://b/")).toBe("modified");
        expect(outcomeKind("info", observedLine("S", "onRequest", "https://a/"))).toBe("observed");
        expect(outcomeKind("debug", "[S] whatever https://a/")).toBe("observed");
        expect(outcomeKind("error", "[S] onRequest threw: x https://a/")).toBe("observed");
        expect(outcomeKind("info", "[S] console.log: fetching https://a/")).toBe("observed");
        expect(outcomeKind("warn", "[S] wt.log: hi https://a/")).toBe("observed");
    });

    it("formats the observed line with the handler and the URL last", () => {
        expect(observedLine("Foo", "onRequest", "https://a.test/x")).toBe("[Foo] onRequest → observed (no change) https://a.test/x");
        const same = observedLine("Foo", "onResponseBody", "https://a.test/x", "it returned the same body it received");
        expect(same).toBe("[Foo] onResponseBody → observed (no change) — it returned the same body it received https://a.test/x");
        expect(outcomeKind("info", same)).toBe("observed");
    });
});

describe("observed log lines don't flood the log ring", () => {
    it("are kept in their own small per-tab ring, replayed and reported alongside", () => {
        const tab = 4242;
        clearTab(tab);
        log(tab, "[S] onResponseBody applied (1b → 2b) https://a/", "info", "s");
        for (let i = 0; i < 300; i++) logObserved(tab, "S", "onRequest", `https://a/${i}`, "s");
        const mine = allLogs().filter((e) => e.tabId === tab);
        expect(mine.filter((e) => e.kind === "observed")).toHaveLength(50);
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
    const iv = (kind: "observed" | "modified"): NetOutcome => ({ scriptId: "s", scriptName: "S", action: "x", level: kind === "observed" ? "debug" : "info", kind, at: 0 });
    const e = (id: string, outcomes: NetOutcome[]): NetEntry =>
        ({ id, tabId: 1, url: `https://a/${id}`, method: "GET", type: "script", status: 200, statusText: "", mime: "", size: 1, fromCache: false, startedAt: 0, endedAt: 1, state: "done", outcomes }) as NetEntry;
    const missed: NetOutcome = { scriptId: "s", scriptName: "S", action: "onResponseBody never ran", level: "warn", kind: "missed", at: 0 };
    const rows = [e("none", []), e("observed", [iv("observed")]), e("both", [iv("observed"), iv("modified")]), e("missed", [missed])];
    const ids = (q: string, list = rows) => list.filter((r) => compileQuery(parseQuery(q).ast, { tabTitle: () => undefined })(r)).map((r) => r.id);

    it("classifies rows and filters all / observed-only / modified / touched; a missed warning is not a tap", () => {
        expect(rows.map(touchState)).toEqual(["none", "observed", "modified", "none"]);
        expect(ids("")).toEqual(["none", "observed", "both", "missed"]);
        expect(ids("is:observed")).toEqual(["observed"]);
        expect(ids("is:modified")).toEqual(["both"]);
        expect(ids("is:touched")).toEqual(["observed", "both"]);
    });

    it("filters by script", () => {
        const t = (name: string, kind: "observed" | "modified"): NetOutcome => ({ ...iv(kind), scriptName: name });
        const mixed = [e("a-mod", [t("A", "modified")]), e("a-obs-b-mod", [t("A", "observed"), t("B", "modified")]), e("b", [t("B", "observed")]), e("none", [])];
        expect(ids("script:=A", mixed)).toEqual(["a-mod", "a-obs-b-mod"]);
        expect(ids("script:=B is:touched", mixed)).toEqual(["a-obs-b-mod", "b"]);
        expect(ids("script:=C", mixed)).toEqual([]);
    });

    it("counts observed-only and modified rows", () => {
        expect(touchCounts(rows)).toEqual({ observed: 1, modified: 1 });
    });
});
