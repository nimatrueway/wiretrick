// @vitest-environment happy-dom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickOpen } from "../src/ui/dialogs/QuickOpen";
import { filterQuickOpen } from "../src/ui/quickOpen";
import { actions } from "../src/ui/shell/actions";
import { dialogs } from "../src/ui/state/dialogs";

afterEach(() => {
    dialogs.quickOpen = false;
    cleanup();
});

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

    it("steps by viewport page on PageDown/PageUp, scrolls the active item into view, and opens on Enter", () => {
        const list = Array.from({ length: 25 }, (_, i) => ({ id: `s_${i}`, name: `script-${i}` }));
        vi.spyOn(actions, "quickOpenItems").mockReturnValue(list);
        const openQuick = vi.spyOn(actions, "openQuick").mockImplementation(() => {});
        dialogs.quickOpen = true;
        const { container } = render(createElement(QuickOpen));
        const input = container.querySelector<HTMLInputElement>("#qo-input")!;
        const ul = container.querySelector<HTMLUListElement>("#qo-list")!;
        Object.defineProperty(ul, "clientHeight", { value: 180, configurable: true });
        let scrolledId = "";
        for (const li of ul.querySelectorAll<HTMLElement>(".qo-item")) {
            Object.defineProperty(li, "offsetHeight", { value: 30, configurable: true });
            li.scrollIntoView = () => {
                scrolledId = li.dataset.id!;
            };
        }
        // floor(180 / 30) - 1 = 5 rows per PageDown/PageUp
        fireEvent.keyDown(input, { key: "PageDown" });
        expect(container.querySelector(".qo-item.active")?.getAttribute("data-id")).toBe("s_5");
        expect(scrolledId).toBe("s_5");

        fireEvent.keyDown(input, { key: "PageDown" });
        expect(container.querySelector(".qo-item.active")?.getAttribute("data-id")).toBe("s_10");

        fireEvent.keyDown(input, { key: "PageUp" });
        expect(container.querySelector(".qo-item.active")?.getAttribute("data-id")).toBe("s_5");

        fireEvent.keyDown(input, { key: "PageUp" });
        fireEvent.keyDown(input, { key: "PageUp" });
        expect(container.querySelector(".qo-item.active")?.getAttribute("data-id")).toBe("s_0");

        fireEvent.keyDown(input, { key: "Enter" });
        expect(openQuick).toHaveBeenCalledWith("s_0");
    });
});
