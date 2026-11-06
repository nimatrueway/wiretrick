/** The toolbar badge's inputs from the log: page code ran/failed on a tab, and scripts' problems. */
import { describe, it, expect, vi } from "vitest";
import { log, noteRan, onScriptActivity, onScriptProblemsChanged, getScriptProblems, recordScriptError, clearScriptErrors, setScriptTypeErrors, setScriptRouteWarnings } from "../src/background/engine/logs";

describe("badge signals", () => {
    it("reports page code that ran or failed on a tab", () => {
        const seen: [number, string][] = [];
        const off = onScriptActivity((t, s) => seen.push([t, s]));
        noteRan(3, "a", "A", "onPage", "https://site.test/");
        noteRan(3, "b", "B", "onOverlay", "https://site.test/");
        noteRan(3, "c", "C", "nope", "https://site.test/"); // not a ran api
        noteRan(3, "d", "D", "onPage", "chrome://newtab/"); // not a web page
        noteRan(-1, "e", "E", "onPage", "https://site.test/"); // no tab
        log(3, "[F] onPage: boom", "error", "f");
        log(3, "[G] console.error: hi", "error", "g"); // the script's own console.error
        log(3, "[H] fine", "info", "h");
        off();
        noteRan(3, "z", "Z", "onPage", "https://site.test/");
        expect(seen).toEqual([
            [3, "a"],
            [3, "b"],
            [3, "f"],
        ]);
    });

    it("lists each script's worst problem and says when they change", async () => {
        await clearScriptErrors();
        const changed = vi.fn();
        const off = onScriptProblemsChanged(changed);
        recordScriptError("r", "[R] boom");
        await setScriptTypeErrors("t", "T", ["bad type"]);
        await setScriptRouteWarnings(new Map([["w", ["slow route"]], ["t", ["also a warning"]]]));
        await new Promise((r) => setTimeout(r, 400));
        expect(changed).toHaveBeenCalled();
        const p = await getScriptProblems();
        expect(p.get("r")).toBe("error");
        expect(p.get("t")).toBe("error");
        expect(p.get("w")).toBe("warning");
        expect(p.has("x")).toBe(false);
        off();
    });
});
