import { describe, expect, it } from "vitest";
import { asCurl, asFetch, copyRequests, shellQuote } from "../src/ui/network/netCopy";
import type { NetEntry } from "../src/shared/netTypes";

const req = (over: Partial<NetEntry> = {}): NetEntry =>
    ({ id: "1", tabId: 1, url: "https://api.test/v1/items?q=a'b", method: "GET", type: "xmlhttprequest", status: 200, statusText: "OK", mime: "", size: 0, fromCache: false, startedAt: 0, endedAt: 1, state: "done", outcomes: [], ...over }) as NetEntry;

describe("Network copy", () => {
    it("quotes for bash", () => {
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
        expect(shellQuote("a\nb\\c'")).toBe(`$'a\\nb\\\\c\\''`);
    });

    it("copies a GET as cURL, dropping pseudo/managed headers", () => {
        const e = req({ requestHeaders: [[":authority", "api.test"], ["Accept", "application/json"], ["Accept-Encoding", "gzip, br"], ["Content-Length", "0"], ["Cookie", "sid=1"]] });
        expect(asCurl(e)).toBe(["curl 'https://api.test/v1/items?q=a'\\''b'", "-H 'Accept: application/json'", "-H 'Cookie: sid=1'", "--compressed"].join(" \\\n  "));
    });

    it("copies a body, and says when it can't", () => {
        const post = req({ method: "POST", requestHeaders: [["Content-Type", "application/json"], ["Referer", "https://app.test/"]], requestBody: { text: '{"a":1}', size: 7, truncated: false, binary: false } });
        expect(asCurl(post)).toBe(["curl 'https://api.test/v1/items?q=a'\\''b'", "-H 'Content-Type: application/json'", "-H 'Referer: https://app.test/'", `--data-raw '{"a":1}'`].join(" \\\n  "));
        expect(JSON.parse(asFetch(post).replace(/^fetch\("[^"]*", /, "").replace(/\);$/, ""))).toEqual({ headers: { "Content-Type": "application/json" }, referrer: "https://app.test/", body: '{"a":1}', method: "POST" });
        const put = req({ method: "PUT", requestBody: { text: "", size: 9000, truncated: false, binary: true } });
        expect(asCurl(put)).toBe("# binary request body (9000 bytes) not captured\ncurl 'https://api.test/v1/items?q=a'\\''b' \\\n  -X 'PUT'");
        expect(asFetch(put)).toMatch(/^\/\/ binary request body \(9000 bytes\) not captured\nfetch\(/);
    });

    it("joins several like devtools' Copy all", () => {
        const two = [req({ url: "https://a.test/1" }), req({ url: "https://a.test/2" })];
        expect(copyRequests(two, "url")).toBe("https://a.test/1\nhttps://a.test/2");
        expect(copyRequests(two, "curl")).toBe("curl 'https://a.test/1' ;\ncurl 'https://a.test/2'");
        expect(copyRequests(two, "fetch").split("\n\n")).toHaveLength(2);
    });
});
