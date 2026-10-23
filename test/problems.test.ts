import { describe, expect, it } from "vitest";
import { collectProblems, filterProblems, problemCounts, ProblemsBadge, SETTINGS_GROUP, type ProblemMarker, type ProblemScript } from "../src/ui/problems";

const script = (id: string, over: Partial<ProblemScript> = {}): ProblemScript => ({ id, label: `${id}.ts`, error: null, ...over });
const none = new Map<string, ProblemMarker[]>();

describe("collectProblems", () => {
    it("no problems → no groups", () => {
        expect(collectProblems([script("a"), script("b", { typeErrors: [], ruleErrors: [], routeWarnings: [], runtimeError: null })], none)).toEqual([]);
        expect(collectProblems([], none, [])).toEqual([]);
    });

    it("compile error drops engine stack frames", () => {
        const [g] = collectProblems([script("a", { error: "SyntaxError: Unexpected token\n    at x (chrome-extension://abc/background.js:1:2)\n    at a.ts:3:1" })], none);
        expect(g.problems).toEqual([{ severity: "error", kind: "compile", message: "SyntaxError: Unexpected token\n    at a.ts:3:1" }]);
    });

    it("rules errors: one problem each", () => {
        const [g] = collectProblems([script("a", { ruleErrors: ["onRequest #1: bad", "onRequest #2: worse"] })], none);
        expect(g.problems.map((p) => [p.kind, p.severity, p.message])).toEqual([
            ["rules", "error", "onRequest #1: bad"],
            ["rules", "error", "onRequest #2: worse"],
        ]);
    });

    it("runtime error: count/time prefix, dismissible", () => {
        const [g] = collectProblems([script("a", { runtimeError: { message: "TypeError: boom", at: Date.now(), count: 3 } })], none);
        expect(g.problems).toHaveLength(1);
        expect(g.problems[0]).toMatchObject({ kind: "runtime", severity: "error", dismissible: true });
        expect(g.problems[0].message).toMatch(/^Runtime error \(3×, last at .+\): TypeError: boom$/);
        const [one] = collectProblems([script("a", { runtimeError: { message: "x", at: Date.now(), count: 1 } })], none);
        expect(one.problems[0].message).toMatch(/^Runtime error \(at .+\): x$/);
    });

    it("stored type errors (no editor model): line parsed", () => {
        const [g] = collectProblems([script("a", { typeErrors: ["line 7: Type 'string' is not assignable to type 'number'.", "odd"] })], none);
        expect(g.problems).toEqual([
            { severity: "error", kind: "ts", message: "odd" },
            { severity: "error", kind: "ts", message: "Type 'string' is not assignable to type 'number'.", line: 7 },
        ]);
    });

    it("live markers override the stored type errors of a script with a model", () => {
        const live = new Map<string, ProblemMarker[]>([
            ["a", [{ severity: "warning", message: "unused", line: 2, column: 5 }]],
            ["b", []],
        ]);
        const groups = collectProblems([script("a", { typeErrors: ["line 9: stale"] }), script("b", { typeErrors: ["line 1: fixed already"] }), script("c", { typeErrors: ["line 4: saved"] })], live);
        expect(groups.map((g) => g.id)).toEqual(["a", "c"]);
        expect(groups[0].problems).toEqual([{ severity: "warning", kind: "ts", message: "unused", line: 2, column: 5 }]);
        expect(groups[1].problems[0]).toMatchObject({ line: 4, message: "saved" });
    });

    it("route warnings are warnings", () => {
        const [g] = collectProblems([script("a", { routeWarnings: ['onResponseBody: strategy "rules" can\'t do this'] })], none);
        expect(g.problems).toEqual([{ severity: "warning", kind: "route", message: 'onResponseBody: strategy "rules" can\'t do this' }]);
    });

    it("sorts errors before warnings, then by line/column", () => {
        const live = new Map<string, ProblemMarker[]>([
            [
                "a",
                [
                    { severity: "warning", message: "w1", line: 1, column: 1 },
                    { severity: "error", message: "e9", line: 9, column: 1 },
                    { severity: "error", message: "e3b", line: 3, column: 8 },
                    { severity: "error", message: "e3a", line: 3, column: 2 },
                ],
            ],
        ]);
        const [g] = collectProblems([script("a", { routeWarnings: ["r"], ruleErrors: ["onRequest #1: x"] })], live);
        expect(g.problems.map((p) => p.message)).toEqual(["onRequest #1: x", "e3a", "e3b", "e9", "r", "w1"]);
    });

    it("keeps explorer order; settings.yaml first", () => {
        const groups = collectProblems([script("z", { error: "bad" }), script("a", { error: "bad" })], none, [{ severity: "error", message: "unknown key", line: 4, column: 3 }]);
        expect(groups.map((g) => [g.id, g.label, g.file])).toEqual([
            [SETTINGS_GROUP.id, "settings.yaml", "yaml"],
            ["z", "z.ts", "ts"],
            ["a", "a.ts", "ts"],
        ]);
        expect(groups[0].problems).toEqual([{ severity: "error", kind: "settings", message: "unknown key", line: 4, column: 3 }]);
    });

    it("a compile-broken script's stored type errors are ignored; its live markers aren't", () => {
        expect(collectProblems([script("a", { error: "bad", typeErrors: ["line 1: x"] })], none)[0].problems.map((p) => p.kind)).toEqual(["compile"]);
        const live = new Map([["a", [{ severity: "error" as const, message: "';' expected.", line: 2, column: 4 }]]]);
        expect(collectProblems([script("a", { error: "bad" })], live)[0].problems.map((p) => p.kind)).toEqual(["compile", "ts"]);
    });
});

describe("problemCounts / filterProblems", () => {
    const groups = collectProblems(
        [script("alpha", { error: "Boom", routeWarnings: ["helper down"] }), script("beta", { ruleErrors: ["onRequest #1: nope"], routeWarnings: ["x", "y"] })],
        none
    );

    it("counts errors and warnings across groups", () => {
        expect(problemCounts(groups)).toEqual({ errors: 2, warnings: 3 });
        expect(problemCounts([])).toEqual({ errors: 0, warnings: 0 });
    });

    it("filters by message or file name, case-insensitively", () => {
        expect(filterProblems(groups, "")).toBe(groups);
        expect(filterProblems(groups, "HELPER").map((g) => [g.id, g.problems.length])).toEqual([["alpha", 1]]);
        expect(filterProblems(groups, "beta.TS").map((g) => [g.id, g.problems.length])).toEqual([["beta", 3]]);
        expect(filterProblems(groups, "zzz")).toEqual([]);
    });
});

describe("ProblemsBadge", () => {
    it("mirrors the current counts; reset() doesn't clear them", () => {
        const b = new ProblemsBadge();
        expect(b.empty).toBe(true);
        b.set({ errors: 2, warnings: 1 });
        expect(b.counts).toEqual([["error", 2], ["warn", 1]]);
        expect(b.title).toBe("2 errors, 1 warning in Problems");
        b.reset();
        expect(b.empty).toBe(false);
        b.set({ errors: 0, warnings: 3 });
        expect(b.title).toBe("3 warnings in Problems");
        b.set({ errors: 0, warnings: 0 });
        expect(b.empty).toBe(true);
    });
});
