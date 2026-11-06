import { describe, it, expect } from "vitest";
import { createBadgeCounter, badgeLook, BADGE_OK, BADGE_WARN, BADGE_ERROR } from "../src/background/badgeCounter";

const net = (url: string, exclude: string[] = []) => ({ kind: "onRequest", url: [url], exclude });
const page = (url: string, kind = "onDocument") => ({ kind, url: [url], exclude: [], when: "document_start" });
const script = (id: string, routes: any[], enabled = true, active = true) => ({ id, enabled, meta: { name: id.toUpperCase(), routes, active } }) as any;

describe("badge counter", () => {
    it("counts enabled scripts whose network routes match the page or its requests", () => {
        const scripts = [script("a", [net("*://site.test/*")]), script("b", [net("*://api.test/*")]), script("c", [net("*://other.test/*")])];
        const b = createBadgeCounter(() => scripts);
        expect(b.note(1, "https://site.test/", true)).toBe(1);
        expect(b.note(1, "https://api.test/x")).toBe(2);
        expect(b.note(1, "https://api.test/y")).toBe(2);
    });

    it("honors a route's exclude", () => {
        const b = createBadgeCounter(() => [script("a", [net("*://site.test/*", ["*://site.test/skip*"])])]);
        expect(b.note(1, "https://site.test/skip", true)).toBe(0);
        expect(b.note(1, "https://site.test/x")).toBe(1);
    });

    it("counts onPage code only once it ran on the tab, not when its URL matches", () => {
        const scripts = [script("p", [page("*://site.test/*")]), script("o", [page("*://site.test/*", "onOverlay")])];
        const b = createBadgeCounter(() => scripts);
        expect(b.note(1, "https://site.test/", true)).toBe(0);
        expect(b.ran(1, "p")).toBe(1);
        expect(b.ran(1, "p")).toBe(1);
        expect(b.ran(1, "o")).toBe(2);
        // the next page load starts over until the code runs again
        expect(b.note(1, "https://site.test/next", true)).toBe(0);
    });

    it("never counts a disabled or route-less script", () => {
        const b = createBadgeCounter(() => [script("a", [net("*://site.test/*")], false), script("b", [net("*://site.test/*")], true, false), script("c", [page("*://site.test/*")], false)]);
        expect(b.note(1, "https://site.test/", true)).toBe(0);
        expect(b.note(1, "https://site.test/x")).toBe(0);
        expect(b.ran(1, "c")).toBe(0);
        expect(b.ran(1, "unknown")).toBe(0);
    });

    it("drops a script disabled after it matched", () => {
        const scripts = [script("a", [net("*://site.test/*")]), script("b", [net("*://site.test/*")])];
        const b = createBadgeCounter(() => scripts);
        expect(b.note(1, "https://site.test/", true)).toBe(2);
        scripts[0].enabled = false;
        expect(b.count(1)).toBe(1);
        expect(b.note(1, "https://site.test/")).toBe(1);
        scripts.splice(1, 1);
        expect(b.count(1)).toBe(0);
    });

    it("lists the ids it counts", () => {
        const scripts = [script("a", [net("*://site.test/*")]), script("b", [net("*://api.test/*")]), script("c", [net("*://other.test/*")])];
        const b = createBadgeCounter(() => scripts);
        b.note(1, "https://site.test/", true);
        b.note(1, "https://api.test/x");
        expect(b.ids(1).sort()).toEqual(["a", "b"]);
        scripts[0].enabled = false;
        expect(b.ids(1)).toEqual(["b"]);
        expect(b.ids(9)).toEqual([]);
    });

    it("starts over on a new page load and forgets closed tabs", () => {
        const b = createBadgeCounter(() => [script("a", [net("*://one.test/*")]), script("b", [net("*://two.test/*")])]);
        b.note(1, "https://one.test/", true);
        expect(b.note(1, "https://two.test/", true)).toBe(1);
        expect(b.note(1, "chrome://newtab/", true)).toBe(0);
        b.note(2, "https://one.test/", true);
        b.forget(2);
        expect(b.count(2)).toBe(0);
    });

    it("saves and restores its counts (merging what was recorded since)", () => {
        const scripts = [script("a", [net("*://site.test/*")]), script("p", [page("*://site.test/*")])];
        const b = createBadgeCounter(() => scripts);
        b.note(1, "https://site.test/", true);
        b.ran(1, "p");
        const saved = JSON.parse(JSON.stringify(b.save()));
        const b2 = createBadgeCounter(() => scripts);
        b2.note(2, "https://site.test/", true);
        b2.restore(saved);
        b2.restore({ 3: "junk", 4: [1, "a"] });
        expect(b2.ids(1).sort()).toEqual(["a", "p"]);
        expect(b2.ids(2)).toEqual(["a"]);
        expect(b2.ids(4)).toEqual(["a"]);
    });
});

describe("badge look", () => {
    it("is the usual color with a list of the active scripts", () => {
        expect(badgeLook([], [])).toEqual({ color: BADGE_OK, title: "Wiretrick" });
        expect(badgeLook(["One"], [undefined])).toEqual({ color: BADGE_OK, title: "Wiretrick — 1 active script\n• One" });
    });

    it("turns amber for warnings and red for errors, and says which", () => {
        expect(badgeLook(["A", "B"], [undefined, "warning"]).color).toBe(BADGE_WARN);
        const look = badgeLook(["A", "B", "C"], ["error", "warning", undefined]);
        expect(look.color).toBe(BADGE_ERROR);
        expect(look.title).toBe("Wiretrick — 3 active scripts\n✖ A\n⚠ B\n• C\n1 with errors, 1 with warnings — see Problems in the Editor");
    });
});
