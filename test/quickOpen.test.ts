import { describe, it, expect } from "vitest";
import { filterQuickOpen } from "../src/ui/quickOpen";

const items = [
    { id: "a", name: "Debug header" },
    { id: "b", name: "Notes" },
    { id: "c", name: "settings.yaml" },
];

describe("quick-open filter", () => {
    it("empty query returns everything", () => {
        expect(filterQuickOpen(items, "")).toEqual(items);
        expect(filterQuickOpen(items, "   ")).toEqual(items);
    });

    it("matches substrings case-insensitively", () => {
        expect(filterQuickOpen(items, "debug")).toEqual([items[0]]);
        expect(filterQuickOpen(items, "SET")).toEqual([items[2]]);
        expect(filterQuickOpen(items, "notes")).toEqual([items[1]]);
    });

    it("matches subsequences (fuzzy)", () => {
        expect(filterQuickOpen(items, "dbh")).toEqual([items[0]]); // D…e…b…ug h…eader
        expect(filterQuickOpen(items, "stg")).toEqual([items[2]]); // s…e…t…t…ings…g…
    });

    it("no match → empty", () => {
        expect(filterQuickOpen(items, "zzz")).toEqual([]);
    });

    it("orders by match position, then name length", () => {
        const its = [
            { id: "1", name: "ab" },
            { id: "2", name: "xab" },
            { id: "3", name: "xxab" },
        ];
        expect(filterQuickOpen(its, "ab").map((i) => i.id)).toEqual(["1", "2", "3"]);
    });
});
