import { describe, expect, it } from "vitest";
import { problemsSection } from "../src/background/diagnostics";

describe("diagnostics: Problems section", () => {
    it("lists the Problems view per file with counts", () => {
        const out = problemsSection([
            {
                id: "s1",
                label: "redwood/cdn.tsx",
                file: "tsx",
                problems: [
                    { severity: "error", kind: "runtime", message: "boom\nat x", line: 3, column: 7, context: "onPage #1" },
                    { severity: "warning", kind: "route", message: "onPage #3: ctx.evaluate's function uses `cfg`", line: 69 },
                ],
            },
        ]).join("\n");
        expect(out).toContain("## Problems (1 error, 1 warning)");
        expect(out).toContain("redwood/cdn.tsx\n  error   3:7     [runtime] boom\n            at x\n            context: onPage #1");
        expect(out).toContain("  warning 69      [route] onPage #3");
    });

    it("says when there are none, or when they weren't collected", () => {
        expect(problemsSection([]).join("\n")).toContain("## Problems (0 errors, 0 warnings)\n\n_none_");
        expect(problemsSection(undefined).join("\n")).toContain("_not collected");
    });
});
