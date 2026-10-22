import { describe, it, expect } from "vitest";
import { resolveFileRef, runOp } from "../src/shared/bodyOps";
import { normalizeRoute, NET_KINDS } from "../src/shared/route";

/** bare fns → routed handlers on "*://x.test/*" (every kind present) */
const routed = (h: Record<string, Function[]>): any =>
    Object.fromEntries([...NET_KINDS, "onDom"].map((k) => [k, (h[k] ?? []).map((fn, i) => ({ fn, route: normalizeRoute(k as any, "*://x.test/*", i) }))]));

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
        const scripts = [{ id: "s", name: "S", handlers: routed({ replaceResponse: [() => ({ file: "data:text/plain;base64," + btoa("from file") })] }) }];
        const out = await runOp(scripts as any, "replace", { url: "https://x.test/robots.txt", method: "GET" }, { log: () => {} } as any);
        expect(out).toEqual({ mime: "text/plain", content: "from file" });
    });
});

describe("tapped vs modified logging", () => {
    const url = "https://x.test/api";
    function run(op: any, handlers: any, args: any = {}) {
        const lines: { level: string; msg: string; kind?: string }[] = [];
        const scripts = [{ id: "s", name: "S", handlers: routed(handlers) }];
        return runOp(scripts as any, op, { url, method: "GET", ...args }, { log: (_id: string, level: string, msg: string, kind?: string) => lines.push({ level, msg, kind }) } as any).then((out) => ({ out, lines }));
    }

    it("handlers that change nothing log one DEBUG 'tapped (no change)' line each", async () => {
        const tapped = (handler: string) => ({ level: "debug", msg: `[S] ${handler} → tapped (no change) ${url}`, kind: "tapped" });
        expect((await run("requestDecision", { onRequest: [() => undefined, () => ({})] })).lines).toEqual([tapped("onRequest"), tapped("onRequest")]);
        expect((await run("responseHeaders", { onResponseHeaders: [() => ({ headers: { set: {} } })] })).lines).toEqual([tapped("onResponseHeaders")]);
        expect((await run("replace", { replaceResponse: [() => null] })).lines).toEqual([tapped("replaceResponse")]);
        // returning the identical body is no change
        const same = await run("transform", { onResponseBody: [(_c: any, b: string) => b, () => undefined] }, { body: "abc" });
        expect(same.lines).toEqual([tapped("onResponseBody"), tapped("onResponseBody")]);
    });

    it("changes keep their INFO lines (no tapped line)", async () => {
        const { out, lines } = await run("transform", { onResponseBody: [(_c: any, b: string) => b + "!"] }, { body: "abc" });
        expect(out).toBe("abc!");
        expect(lines).toEqual([{ level: "info", msg: `[S] onResponseBody applied (3b → 4b) ${url}`, kind: undefined }]);
        const hdr = await run("requestDecision", { onRequest: [() => ({ headers: { set: { "x-a": "1" } } })] });
        expect(hdr.lines.map((l) => l.level)).toEqual(["info"]);
    });
});
