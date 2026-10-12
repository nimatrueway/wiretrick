import { describe, it, expect } from "vitest";
import { parseMeta, DEFAULT_META } from "../src/shared/metaParser";

const sample = `// ==ResScript==
// @name       Mock /api/user
// @match      *://app.example.com/api/user*
// @match      https://api.example.com/v2/user
// @phase      response
// @strategy   cdp
// ==/ResScript==

res.modifyResponse((ctx, body) => JSON.parse(body));
`;

describe("parseMeta", () => {
    it("parses all supported keys", () => {
        const meta = parseMeta(sample);
        expect(meta.name).toBe("Mock /api/user");
        expect(meta.match).toEqual(["*://app.example.com/api/user*", "https://api.example.com/v2/user"]);
        expect(meta.phase).toEqual(["response"]);
        expect(meta.strategy).toBe("cdp");
    });

    it("falls back to defaults without a block", () => {
        const meta = parseMeta("res.onRequest(() => {});");
        expect(meta.name).toBe("res.onRequest(() => {});");
        expect(meta.match).toEqual([]);
        expect(meta.phase).toEqual(DEFAULT_META.phase);
    });

    it("defaults phase to both when omitted", () => {
        const meta = parseMeta(`// ==ResScript==\n// @name X\n// @match *\n// ==/ResScript==\n`);
        expect(meta.phase).toEqual(["request", "response"]);
        expect(meta.strategy).toBe("auto");
    });

    it("ignores unknown keys", () => {
        const meta = parseMeta(`// ==ResScript==\n// @name X\n// @whatever zzz\n// ==/ResScript==\n`);
        expect(meta.name).toBe("X");
    });
});
