import { describe, expect, it } from "vitest";
import { SHORTCUTS, filterShortcuts, formatKey } from "../src/ui/shortcuts";

describe("shortcuts", () => {
    it("formats per platform", () => {
        expect(formatKey("Mod+Shift+E", true)).toBe("⌘⇧E");
        expect(formatKey("Mod+Shift+E", false)).toBe("Ctrl+Shift+E");
    });

    it("filters by words in action, context or keys", () => {
        expect(filterShortcuts(SHORTCUTS, "", false)).toHaveLength(SHORTCUTS.length);
        expect(filterShortcuts(SHORTCUTS, "bottom panel", false).map((s) => s.keys)).toEqual([["Mod+J", "Mod+`"]]);
        expect(filterShortcuts(SHORTCUTS, "ctrl+j", false)).toHaveLength(1);
        expect(filterShortcuts(SHORTCUTS, "⌘j", true)).toHaveLength(1);
        expect(filterShortcuts(SHORTCUTS, "explorer rename", false)[0].keys).toEqual(["F2"]);
        expect(filterShortcuts(SHORTCUTS, "zzz", false)).toEqual([]);
    });
});
