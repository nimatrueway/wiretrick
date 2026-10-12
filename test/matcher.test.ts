import { describe, it, expect } from "vitest";
import { match, matchReplace, matchAny } from "../src/shared/matcher";

// Ported from test/matchTest.js — [pattern, replace, input, expected]
const cases: [string, string, string, string][] = [
    ["asd", "qwe", "asd", "qwe"],
    ["asd", "qwe", "asd ", "asd "],
    ["asd*", "qwe", "asd", "qwe"],
    ["asd*", "qwe", "asd ", "qwe"],
    ["asd*", "qwe", "asdzxc", "qwe"],
    ["asd*", "qwe", " asd", " asd"],
    ["*a", "qwe", "asda", "asda"], // matching is greedy!
    ["*asd", "qwe", "asd", "qwe"],
    ["*asd", "qwe", "asd ", "asd "],
    ["*asd", "qwe", "zxcasd", "qwe"],
    ["*asd*", "qwe", "asd", "qwe"],
    ["*asd*", "qwe", "zxcasd", "qwe"],
    ["*asd*", "qwe", "asdzxc", "qwe"],
    ["*asd*", "qwe", "zxcasd123", "qwe"],
    ["*asd*", "qwe", "zxca5d123", "zxca5d123"],
    ["asd*", "qwe*", "asd", "qwe"],
    ["asd*", "qwe*", "asdzxc", "qwezxc"],
    ["asd*", "qwe*", "a2dzxc", "a2dzxc"],
    ["asd*", "*qwe", "asd", "qwe"],
    ["asd*", "*qwe", "asdzxc", "zxcqwe"],
    ["asd*", "*qwe", "1asdzxc", "1asdzxc"],
    ["asd*", "*qwe", "a2dzxc", "a2dzxc"],
    ["*asd", "qwe*", "asd", "qwe"],
    ["*asd", "qwe*", "zxcasd", "qwezxc"],
    ["*asd", "qwe*", "asdz", "asdz"],
    ["*asd", "qwe*", "a2d", "a2d"],
    ["*asd*", "*qwe*", "asd", "qwe"],
    ["*asd*", "*qwe*", "zxcasd123", "zxcqwe123"],
    ["*asd*", "*qwe*", "zxca2d123", "zxca2d123"],
    ["asd*qwe**", "123*456**", "asdqwe", "123456"],
    ["asd*qwe**", "123*456**", "asdfghqwe", "123fgh456"],
    ["asd*qwe**", "123*456**", "asdqwefgh", "123456fgh"],
    ["asd*qwe**", "123*456**", "asdfghqwerty", "123fgh456rty"],
    ["asd*qwe**", "123*456**", "qasdqwe", "qasdqwe"],
    ["asd*qwe**", "123*456**", "qasdnnqwe", "qasdnnqwe"],
    ["asd**qwe*", "123*456**", "asdqwe", "123456"],
    ["asd**qwe*", "123*456**", "asdfghqwe", "123456fgh"],
    ["asd**qwe*", "123*456**", "asdqwefgh", "123fgh456"],
    ["asd**qwe*", "123*456**", "asdfghqwerty", "123rty456fgh"],
    ["asd**qwe*", "123*456**", "qasdqwe", "qasdqwe"],
    ["asd**qwe*", "123*456**", "qasdnnqwe", "qasdnnqwe"],
    ["asd**qwe*zxc**Q", "123**456**789*0", "asd$%$qwe^&zxc!@Q", "123$%$456!@789^&0"],
    ["asd**qwe*zxc**Q", "123**456**789*0", "asd$%$qwe^&zxcQ", "123$%$456789^&0"],
    ["asd**qwe*zxc**Q", "123**456**789*0", "asd$%$qWe^&zxc!@Q", "asd$%$qWe^&zxc!@Q"],
    ["a*b**c***d", "e***f*g**h****", "a1b2c3d", "e3f1g2h****"],
    ["a*b**c***d", "e***f*g**h****", "a1bc3d", "e3f1gh****"],
    ["a*b**c***d", "e***f*g**h****", "aaabbccccd", "ecccfaagbh****"],
    ["a*b**c***d", "e***f*g**h****", "aaaccccd", "aaaccccd"],
    ["a*b**c***d", "e***f*g**h****", "a**b***c*d", "e*f**g***h****"],
];

describe("matchReplace (ported from matchTest.js)", () => {
    it.each(cases)("%s + %s on %s → %s", (pattern, replace, input, expected) => {
        expect(matchReplace(pattern, replace, input)).toBe(expected);
    });
});

describe("match", () => {
    it("matches url patterns", () => {
        expect(match("*://*.example.com/api/*", "https://app.example.com/api/users").matched).toBe(true);
        expect(match("*://*.example.com/api/*", "https://other.com/api/users").matched).toBe(false);
        expect(match("*://example.com/", "https://example.com/").matched).toBe(true);
    });

    it("captures free vars", () => {
        const r = match("https://x.com/*", "https://x.com/foo/bar");
        expect(r.matched).toBe(true);
        expect(r.freeVars[1]).toEqual(["foo/bar"]);
    });
});

describe("matchAny", () => {
    it("any-match semantics; empty list matches nothing", () => {
        expect(matchAny([], "https://x.com/a")).toBe(false);
        expect(matchAny(["*://a.com/*", "*://b.com/*"], "https://b.com/x")).toBe(true);
    });
});
