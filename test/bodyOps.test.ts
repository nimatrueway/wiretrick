import { describe, it, expect } from "vitest";
import { resolveFileRef, runOp } from "../src/shared/bodyOps";

describe("replaceResponse { file }", () => {
    it("decodes base64 data: URLs and uses their media type", () => {
        const ref = "data:text/plain;base64," + btoa("served ok");
        expect(resolveFileRef(ref, "https://x.test/robots.txt")).toEqual({ mime: "text/plain", content: "served ok" });
    });

    it("decodes UTF-8 in base64 data: URLs", () => {
        const bytes = new TextEncoder().encode("héllo");
        const ref = "data:text/html;base64," + btoa(String.fromCharCode(...bytes));
        expect(resolveFileRef(ref, "https://x.test/")).toEqual({ mime: "text/html", content: "héllo" });
    });

    it("decodes percent-encoded data: URLs, defaulting the type", () => {
        expect(resolveFileRef("data:,a%20b", "https://x.test/a.js")).toEqual({ mime: "text/plain", content: "a b" });
    });

    it("passes non-data refs through with the URL's mime", () => {
        expect(resolveFileRef("/tmp/lib.js", "https://x.test/lib.js")).toEqual({ mime: "application/javascript", content: "/tmp/lib.js" });
    });

    it("the replace op serves the decoded file", async () => {
        const scripts = [{ id: "s", name: "S", match: ["*://x.test/*"], handlers: { replaceResponse: [() => ({ file: "data:text/plain;base64," + btoa("from file") })] } }];
        const out = await runOp(scripts as any, "replace", { url: "https://x.test/robots.txt", method: "GET" }, { log: () => {} } as any);
        expect(out).toEqual({ mime: "text/plain", content: "from file" });
    });
});

describe("seen vs altered logging", () => {
    const url = "https://x.test/api";
    function run(op: any, handlers: any, args: any = {}) {
        const lines: { level: string; msg: string; kind?: string }[] = [];
        const scripts = [{ id: "s", name: "S", match: ["*://x.test/*"], handlers }];
        return runOp(scripts as any, op, { url, method: "GET", ...args }, { log: (_id: string, level: string, msg: string, kind?: string) => lines.push({ level, msg, kind }) } as any).then((out) => ({ out, lines }));
    }

    it("handlers that change nothing log one DEBUG 'seen (no change)' line each", async () => {
        const seen = (handler: string) => ({ level: "debug", msg: `[S] ${handler} → seen (no change) ${url}`, kind: "seen" });
        expect((await run("requestDecision", { onRequest: [() => undefined, () => ({})] })).lines).toEqual([seen("onRequest"), seen("onRequest")]);
        expect((await run("responseHeaders", { onResponseHeaders: [() => ({ headers: { set: {} } })] })).lines).toEqual([seen("onResponseHeaders")]);
        expect((await run("replace", { replaceResponse: [() => null] })).lines).toEqual([seen("replaceResponse")]);
        // returning the identical body is no change
        const same = await run("transform", { modifyResponse: [(_c: any, b: string) => b, () => undefined] }, { body: "abc" });
        expect(same.lines).toEqual([seen("modifyResponse"), seen("modifyResponse")]);
    });

    it("changes keep their INFO lines (no seen line)", async () => {
        const { out, lines } = await run("transform", { modifyResponse: [(_c: any, b: string) => b + "!"] }, { body: "abc" });
        expect(out).toBe("abc!");
        expect(lines).toEqual([{ level: "info", msg: `[S] modifyResponse applied (3b → 4b) ${url}`, kind: undefined }]);
        const hdr = await run("requestDecision", { onRequest: [() => ({ headers: { set: { "x-a": "1" } } })] });
        expect(hdr.lines.map((l) => l.level)).toEqual(["info"]);
    });
});
