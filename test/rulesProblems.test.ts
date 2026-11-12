import { describe, expect, it } from "vitest";
import { rulesProblems } from "../src/shared/compile";
import { collectProblems, type ProblemMarker } from "../src/ui/problems";
import type { RouteMeta } from "../src/shared/route";

const route = (over: Partial<RouteMeta>): RouteMeta => ({ kind: "onRequest", index: 0, url: ["*://a/*"], strategy: "rules", ...over }) as RouteMeta;

const code = `const counts = tt.globalStore("c", { n: 0 });
tt.onRequest({ url: "*://a/*", strategy: "rules" }, (ctx) => {
    console.log("blocked", ctx.url);
    counts.n++;
    tt.log(\`console.log("x")\`);
    return { block: true };
});
tt.onRequest({ url: "*://b/*", strategy: "extension" }, () => {
    console.log("per request");
    fetch("https://log.example/");
});
tt.onResponseHeaders({ url: "*://c/*", strategy: "rules" }, () => {
    counts.n = counts.n + 1;
    setTimeout(() => {}, 1);
    void tt.fetch("https://x/");
    return { headers: { remove: ["x"] } };
});`;
const routes = [route({ index: 0, line: 2 }), route({ index: 1, line: 8, strategy: "extension" }), route({ kind: "onResponseHeaders", index: 0, line: 12 })];

describe("rulesProblems", () => {
    it("flags per-request-looking code in rules handlers only, in source order", () => {
        const out = rulesProblems(code, routes);
        expect(out.map((m) => /^(\w+ #\d+): `([^`]+)`/.exec(m)!.slice(1).join(" "))).toEqual([
            "onRequest #1 console.log",
            "onRequest #1 counts",
            "onRequest #1 tt.log",
            "onResponseHeaders #1 counts",
            "onResponseHeaders #1 setTimeout",
            "onResponseHeaders #1 tt.fetch",
        ]);
        expect(out[0]).toMatch(/runs once, when scripts load — not for each request.*To log each request, use a per-request strategy/);
    });

    it("nothing on rules: nothing to say; a store read is fine", () => {
        expect(rulesProblems(code, [routes[1]])).toEqual([]);
        expect(rulesProblems(`const s = tt.globalStore("c", { on: true });\ntt.onRequest({ url: "*://a/*", strategy: "rules" }, () => (s.on ? { block: true } : null));`, [route({ line: 2 })])).toEqual([]);
    });

    it("each warning points at its own call in the handler", () => {
        const routeWarnings = rulesProblems(code, routes);
        const [g] = collectProblems([{ id: "a", label: "a.ts", error: null, code, routes, routeWarnings }], new Map<string, ProblemMarker[]>());
        expect(g.problems.map((p) => [p.line, p.column, p.endColumn])).toEqual([
            [3, 5, 16],
            [4, 5, 11],
            [5, 5, 11],
            [13, 5, 11],
            [14, 5, 15],
            [15, 10, 18],
        ]);
    });
});
