import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { releaseNotes } from "../scripts/release-notes.mjs";

const log = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-01-02

### Added

- A thing, see [docs](docs/a.md#x) and [web](https://x.test)
  and [here](#y).

\`\`\`text
kept
as is
\`\`\`

## [1.0.0] - 2026-01-01

First.

[1.1.0]: https://example.test
`;

describe("release notes", () => {
    it("takes the version's section, makes relative links absolute, links install and compare", () => {
        expect(releaseNotes(log, "1.1.0", "o/r")).toBe(`### Added

- A thing, see [docs](https://github.com/o/r/blob/v1.1.0/docs/a.md#x) and [web](https://x.test) and [here](#y).

\`\`\`text
kept
as is
\`\`\`

**Install:** see [docs/install.md](https://github.com/o/r/blob/v1.1.0/docs/install.md).
**Full changelog:** https://github.com/o/r/compare/v1.0.0...v1.1.0
`);
    });

    it("the oldest version has no compare link", () => {
        expect(releaseNotes(log, "1.0.0", "o/r")).not.toContain("compare");
    });

    it("fails on a missing or empty section", () => {
        expect(() => releaseNotes(log, "2.0.0")).toThrow(/no "## \[2.0.0\]"/);
        expect(() => releaseNotes(log.replace("## [Unreleased]", "## [3.0.0]"), "3.0.0")).toThrow(/empty/);
    });

    it("CHANGELOG.md has a section for the current version", () => {
        const { version } = JSON.parse(readFileSync("package.json", "utf8"));
        expect(() => releaseNotes(readFileSync("CHANGELOG.md", "utf8"), version)).not.toThrow();
    });
});
