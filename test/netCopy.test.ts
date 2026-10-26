import { describe, expect, it } from "vitest";
import { asCurl, asFetch, asHar, copyRequests, shellQuote } from "../src/ui/network/netCopy";
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

    it("copies requests as one HAR 1.2 log, oldest first", () => {
        const post = req({
            id: "2",
            url: "https://api.test/save?x=1&y=two",
            method: "POST",
            type: "xmlhttprequest",
            mime: "application/json",
            size: 40,
            startedAt: Date.UTC(2026, 0, 2),
            endedAt: Date.UTC(2026, 0, 2) + 125,
            ip: "10.0.0.1",
            requestHeaders: [["Content-Type", "application/json"], ["Cookie", "sid=1; theme=dark"]],
            responseHeaders: [["Set-Cookie", "tok=abc; Path=/; HttpOnly"]],
            requestBody: { text: '{"a":1}', size: 7, truncated: false, binary: false },
            responseBody: { text: '{"ok', size: 4000, truncated: true, binary: false },
            outcomes: [{ scriptId: "s", scriptName: "Mock", action: "onResponseBody → body", level: "info", kind: "modified", at: 0 }],
        });
        const doc = JSON.parse(copyRequests([post, req({ type: "main_frame", startedAt: Date.UTC(2026, 0, 1), status: 302, redirectTo: "https://b.test/" })], "har"));
        expect(doc.log).toMatchObject({ version: "1.2", creator: { name: "Wiretrick" }, pages: [] });
        const [first, e] = doc.log.entries;
        expect(first).toMatchObject({ _resourceType: "document", response: { status: 302, redirectURL: "https://b.test/", content: { comment: "response body not captured" } } });
        expect(e).toMatchObject({
            startedDateTime: "2026-01-02T00:00:00.000Z",
            time: 125,
            serverIPAddress: "10.0.0.1",
            _resourceType: "xhr",
            _wiretrick: [{ script: "Mock", action: "onResponseBody → body", kind: "modified" }],
            request: {
                method: "POST",
                queryString: [{ name: "x", value: "1" }, { name: "y", value: "two" }],
                cookies: [{ name: "sid", value: "1" }, { name: "theme", value: "dark" }],
                headers: [{ name: "Content-Type", value: "application/json" }, { name: "Cookie", value: "sid=1; theme=dark" }],
                postData: { mimeType: "application/json", text: '{"a":1}' },
                bodySize: 7,
            },
            response: { cookies: [{ name: "tok", value: "abc" }], content: { size: 4000, mimeType: "application/json", text: '{"ok' }, bodySize: 40 },
            timings: { send: 0, wait: 125, receive: 0 },
        });
        expect(e.response.content.comment).toMatch(/cut/);
        expect(e.request.postData.comment).toBeUndefined();
        expect(JSON.parse(asHar([req({ requestBody: { text: "", size: 9, truncated: false, binary: true } })])).log.entries[0].request.postData).toEqual({ mimeType: "", text: "", comment: "binary body (9 bytes) not captured" });
    });
});
