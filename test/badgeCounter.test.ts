import { describe, it, expect } from "vitest";
import { createBadgeCounter } from "../src/background/badgeCounter";

const script = (id: string, match: string[], enabled = true, active = true) => ({ id, enabled, meta: { match, active } }) as any;

describe("badge counter", () => {
    it("counts enabled scripts matching the page or its requests", () => {
        const scripts = [script("a", ["*://site.test/*"]), script("b", ["*://api.test/*"]), script("c", ["*://other.test/*"])];
        const b = createBadgeCounter(() => scripts);
        expect(b.note(1, "https://site.test/", true)).toBe(1);
        expect(b.note(1, "https://api.test/x")).toBe(2);
        expect(b.note(1, "https://api.test/y")).toBe(2);
    });

    it("never counts a disabled or route-less script", () => {
        const b = createBadgeCounter(() => [script("a", ["*://site.test/*"], false), script("b", ["*://site.test/*"], true, false)]);
        expect(b.note(1, "https://site.test/", true)).toBe(0);
        expect(b.note(1, "https://site.test/x")).toBe(0);
    });

    it("drops a script disabled after it matched", () => {
        const scripts = [script("a", ["*://site.test/*"]), script("b", ["*://site.test/*"])];
        const b = createBadgeCounter(() => scripts);
        expect(b.note(1, "https://site.test/", true)).toBe(2);
        scripts[0].enabled = false;
        expect(b.count(1)).toBe(1);
        expect(b.note(1, "https://site.test/")).toBe(1);
        scripts.splice(1, 1);
        expect(b.count(1)).toBe(0);
    });

    it("starts over on a new page load and forgets closed tabs", () => {
        const b = createBadgeCounter(() => [script("a", ["*://one.test/*"]), script("b", ["*://two.test/*"])]);
        b.note(1, "https://one.test/", true);
        expect(b.note(1, "https://two.test/", true)).toBe(1);
        expect(b.note(1, "chrome://newtab/", true)).toBe(0);
        b.note(2, "https://one.test/", true);
        b.forget(2);
        expect(b.count(2)).toBe(0);
    });
});
