import { describe, it, expect } from "vitest";
import { resolveFileRef, runOp } from "../src/shared/bodyOps";
import { normalizeRoute, NET_KINDS } from "../src/shared/route";

/** bare fns → routed handlers on "*://x.test/*" (every kind present) */
const routed = (h: Record<string, Function[]>): any =>
    Object.fromEntries([...NET_KINDS, "onDocument"].map((k) => [k, (h[k] ?? []).map((fn, i) => ({ fn, route: normalizeRoute(k as any, "*://x.test/*", i) }))]));

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
        expect(out).toMatchObject({ mime: "text/plain", content: "from file", who: { scriptId: "s", kind: "replaceResponse", index: 0 } });
    });
});

describe("observed vs modified logging", () => {
    const url = "https://x.test/api";
    function run(op: any, handlers: any, args: any = {}) {
        const lines: { level: string; msg: string; kind?: string }[] = [];
        const scripts = [{ id: "s", name: "S", handlers: routed(handlers) }];
        return runOp(scripts as any, op, { url, method: "GET", ...args }, { log: (_id: string, level: string, msg: string, kind?: string) => lines.push({ level, msg, kind }) } as any).then((out) => ({ out, lines }));
    }

    it("handlers that change nothing log one DEBUG 'observed (no change)' line each", async () => {
        const observed = (handler: string) => ({ level: "debug", msg: `[S] ${handler} → observed (no change) ${url}`, kind: "observed" });
        expect((await run("requestDecision", { onRequest: [() => undefined, () => ({})] })).lines).toEqual([observed("onRequest"), observed("onRequest")]);
        expect((await run("responseHeaders", { onResponseHeaders: [() => ({ headers: { set: {} } })] })).lines).toEqual([observed("onResponseHeaders")]);
        expect((await run("replace", { replaceResponse: [() => null] })).lines).toEqual([observed("replaceResponse")]);
        // returning the identical body is no change
        const same = await run("transform", { onResponseBody: [(_c: any, b: string) => b, () => undefined] }, { body: "abc" });
        expect(same.lines).toEqual([
            { ...observed("onResponseBody"), msg: `[S] onResponseBody → observed (no change) — it returned the same body it received ${url}` },
            observed("onResponseBody"),
        ]);
    });

    it("changes keep their INFO lines (no observed line)", async () => {
        const { out, lines } = await run("transform", { onResponseBody: [(_c: any, b: string) => b + "!"] }, { body: "abc" });
        expect(out).toBe("abc!");
        expect(lines).toEqual([{ level: "info", msg: `[S] onResponseBody applied (3b → 4b) ${url}`, kind: undefined }]);
        const hdr = await run("requestDecision", { onRequest: [() => ({ headers: { set: { "x-a": "1" } } })] });
        expect(hdr.lines.map((l) => l.level)).toEqual(["info"]);
    });
});

describe("precedence in runOp", () => {
    it("request headers: the later handler wins per header, with a warning", async () => {
        const logs: string[] = [];
        const scripts = [
            { id: "a", name: "A", handlers: routed({ onRequest: [() => ({ headers: { set: { "X-Who": "a" } } })] }) },
            { id: "b", name: "B", handlers: routed({ onRequest: [() => ({ headers: { remove: ["x-who"] } })] }) },
        ];
        const out = await runOp(scripts as any, "requestDecision", { url: "https://x.test/prec", method: "GET" }, { log: (_id: string, level: string, msg: string) => level === "warn" && logs.push(msg) } as any);
        expect(out).toEqual({ kind: "headers", changes: { set: {}, remove: ["x-who"] } });
        expect(logs).toEqual([`[B] onRequest #1 overrides request header "x-who" from [A] onRequest #1 (the later one in the list wins) https://x.test/prec`]);
    });

    it("an onRequest result is one thing: a combination keeps the first (replaceResponse > redirect > block > headers) and warns once", async () => {
        const logs: string[] = [];
        const env = { log: (_id: string, level: string, msg: string) => level === "warn" && logs.push(msg) } as any;
        const scripts = [{ id: "m", name: "M", handlers: routed({ onRequest: [() => ({ redirect: "https://x.test/to", headers: { set: { a: "1" } }, block: false })] }) }];
        const req = { url: "https://x.test/mixed", method: "GET" };
        expect(await runOp(scripts as any, "requestDecision", req, env)).toMatchObject({ kind: "redirect", url: "https://x.test/to" });
        expect(await runOp(scripts as any, "requestDecision", req, env)).toMatchObject({ kind: "redirect" });
        expect(logs).toEqual([
            "[M] onRequest #1 returned `redirect` and `headers` — an onRequest result is one of replaceResponse, redirect, block or headers, so only `redirect` applied (to change the redirected request's headers, add an onRequest handler for the target URL) https://x.test/mixed",
        ]);
        const both = [{ id: "n", name: "N", handlers: routed({ onRequest: [() => ({ block: true, redirect: "https://x.test/to" })] }) }];
        expect(await runOp(both as any, "requestDecision", req, env)).toMatchObject({ kind: "redirect" });
    });

    it("a final decision names the handler that made it", async () => {
        const scripts = [{ id: "a", name: "A", handlers: routed({ onRequest: [() => null, () => ({ block: true })] }) }];
        const out = await runOp(scripts as any, "requestDecision", { url: "https://x.test/y", method: "GET" }, { log: () => {} } as any);
        expect(out).toEqual({ kind: "cancel", who: { scriptId: "a", scriptName: "A", kind: "onRequest", index: 1 } });
    });
});
