import { describe, expect, it } from "vitest";
import { logSegments, opensInTab } from "../src/ui/logLinks";

const uris = (text: string) => logSegments(text).filter((s) => s.uri).map((s) => s.uri);

describe("Log links", () => {
    it("finds URIs of any scheme", () => {
        expect(uris("continues UNMODIFIED https://api.example.com/v1/data?a=1#x")).toEqual(["https://api.example.com/v1/data?a=1#x"]);
        expect(uris("launching cursor://file/home/me/a.ts:12 and vscode://file/x")).toEqual(["cursor://file/home/me/a.ts:12", "vscode://file/x"]);
        expect(uris("see chrome://extensions, file:///tmp/a.txt; mailto:me@x.io")).toEqual(["chrome://extensions", "file:///tmp/a.txt", "mailto:me@x.io"]);
        expect(uris("blob:https://x.com/1-2 data:text/plain,hi about:blank urn:isbn:123")).toEqual(["blob:https://x.com/1-2", "data:text/plain,hi", "about:blank", "urn:isbn:123"]);
    });

    it("leaves look-alikes and unsafe schemes as text", () => {
        expect(uris("[12:30:01] onRequest: Error: boom at 10:20")).toEqual([]);
        expect(uris("javascript://%0aalert(1) ws://h/s wss://h/s https://")).toEqual([]);
    });

    it("drops punctuation and unbalanced brackets glued to the end", () => {
        expect(uris("(see https://a.io/x).")).toEqual(["https://a.io/x"]);
        expect(uris("https://en.wikipedia.org/wiki/Foo_(bar), next")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
        expect(uris('url "https://a.io/q?x=[1]"')).toEqual(["https://a.io/q?x=[1]"]);
    });

    it("splits around links and the find highlight", () => {
        const text = "get https://a.io/x ok";
        expect(logSegments(text)).toEqual([{ text: "get " }, { text: "https://a.io/x", uri: "https://a.io/x" }, { text: " ok" }]);
        expect(logSegments(text, [0, 9])).toEqual([
            { text: "get ", mark: true },
            { text: "https", uri: "https://a.io/x", mark: true },
            { text: "://a.io/x", uri: "https://a.io/x" },
            { text: " ok" },
        ]);
    });

    it("opens browser schemes in a tab, hands the rest to the OS", () => {
        expect(["https://a", "chrome://x", "file:///a", "data:,x", "about:blank"].map(opensInTab)).toEqual([true, true, true, true, true]);
        expect(["vscode://file/a", "cursor://file/a", "mailto:a@b", "zed://file/a"].map(opensInTab)).toEqual([false, false, false, false]);
    });
});
