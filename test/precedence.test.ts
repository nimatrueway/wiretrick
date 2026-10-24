import { describe, it, expect } from "vitest";
import { HeaderStack, mergeHeaderEdits, skippedBy, skippedLine, winnerOf, type RouteRef, type Winner } from "../src/shared/precedence";
import type { NetKind, RouteMeta, Strategy } from "../src/shared/route";

const URL = "https://api.test/v1/data";
function ref(scriptId: string, order: number, kind: NetKind, strategy: Strategy, index = 0, url = ["*://api.test/*"]): RouteRef {
    const route: RouteMeta = { kind, index, url, exclude: [], strategy };
    return { scriptId, scriptName: scriptId.toUpperCase(), order, route, strategy } as RouteRef;
}
const win = (scriptId: string, kind: NetKind, strategy: Strategy, outcome: Winner["outcome"], index = 0, target?: string): Winner => ({ scriptId, scriptName: scriptId.toUpperCase(), kind, index, strategy, outcome, target });
const names = (rs: RouteRef[]) => rs.map((r) => `${r.scriptId}:${r.route.kind}#${r.route.index}@${r.strategy}`).sort();

describe("skippedBy — same layer", () => {
    const routes = [
        ref("a", 0, "onRequest", "debugger"),
        ref("a", 0, "replaceResponse", "debugger"),
        ref("b", 1, "onRequest", "debugger"),
        ref("b", 1, "onRequest", "debugger", 1),
        ref("b", 1, "replaceResponse", "debugger"),
        ref("b", 1, "onResponseHeaders", "debugger"),
        ref("b", 1, "onResponseBody", "debugger"),
    ];
    it("an onRequest block skips later onRequest, every replaceResponse and every response handler", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("a", "onRequest", "debugger", "block")))).toEqual([
            "a:replaceResponse#0@debugger",
            "b:onRequest#0@debugger",
            "b:onRequest#1@debugger",
            "b:onResponseBody#0@debugger",
            "b:onResponseHeaders#0@debugger",
            "b:replaceResponse#0@debugger",
        ]);
    });
    it("a replaceResponse skips later replaceResponse and the response stage, not onRequest (it ran first)", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("a", "replaceResponse", "debugger", "replace")))).toEqual([
            "b:onResponseBody#0@debugger",
            "b:onResponseHeaders#0@debugger",
            "b:replaceResponse#0@debugger",
        ]);
    });
    it("a later script's handler doesn't skip an earlier script's handler of the same kind", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("b", "onRequest", "debugger", "block", 0)))).toContain("b:onRequest#1@debugger");
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("b", "onRequest", "debugger", "block", 0)))).not.toContain("a:onRequest#0@debugger");
    });
    it("handlers whose route doesn't match aren't skipped", () => {
        const rs = [ref("a", 0, "onRequest", "helper"), ref("b", 1, "onResponseBody", "helper", 0, ["*://other.test/*"])];
        expect(skippedBy(rs, { url: URL }, win("a", "onRequest", "helper", "block"))).toEqual([]);
    });
});

describe("skippedBy — across strategies", () => {
    const routes = [
        ref("p", 0, "onResponseBody", "page"),
        ref("r", 1, "onRequest", "rules"),
        ref("x", 2, "onResponseHeaders", "extension"),
        ref("d", 3, "onRequest", "debugger"),
        ref("h", 4, "onResponseBody", "helper"),
    ];
    it("a rules block skips everything behind it and the page's response handlers", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("r", "onRequest", "rules", "block")))).toEqual([
            "d:onRequest#0@debugger",
            "h:onResponseBody#0@helper",
            "p:onResponseBody#0@page",
            "x:onResponseHeaders#0@extension",
        ]);
    });
    it("a debugger replacement skips the helper only — layers in front see it as a response", () => {
        expect(names(skippedBy(routes, { url: URL, type: "xmlhttprequest" }, win("d", "onRequest", "debugger", "replace")))).toEqual(["h:onResponseBody#0@helper"]);
    });
    it("page handlers only count for fetch/XHR", () => {
        expect(names(skippedBy(routes, { url: URL, type: "script" }, win("r", "onRequest", "rules", "block")))).not.toContain("p:onResponseBody#0@page");
    });
    it("a redirect doesn't count handlers that also match the target", () => {
        const rs = [ref("a", 0, "onRequest", "helper"), ref("b", 1, "onResponseBody", "helper")];
        expect(skippedBy(rs, { url: URL }, win("a", "onRequest", "helper", "redirect", 0, "https://api.test/v2"))).toEqual([]);
        expect(names(skippedBy(rs, { url: URL }, win("a", "onRequest", "helper", "redirect", 0, "https://elsewhere.test/")))).toEqual(["b:onResponseBody#0@helper"]);
    });
});

describe("skippedLine", () => {
    it("names both handlers, the reason and ends with the URL", () => {
        const r = ref("b", 1, "onResponseBody", "helper");
        const line = skippedLine(r, win("a", "onRequest", "rules", "block"), URL);
        expect(line).toBe(`[B] onResponseBody #1 → skipped: [A] onRequest #1 → block took priority (strategy "rules" comes before "helper", so the request never got there) ${URL}`);
    });
});

describe("winnerOf", () => {
    const who = { scriptId: "a", scriptName: "A", kind: "onRequest" as const, index: 0 };
    it("maps runOp results", () => {
        expect(winnerOf({ kind: "cancel", who }, "helper")?.outcome).toBe("block");
        expect(winnerOf({ kind: "redirect", url: "https://t/", who }, "helper")).toMatchObject({ outcome: "redirect", target: "https://t/" });
        expect(winnerOf({ kind: "respond", who }, "page")?.outcome).toBe("replace");
        expect(winnerOf({ mime: "x", content: "", who: { ...who, kind: "replaceResponse" } }, "page")?.outcome).toBe("replace");
        expect(winnerOf({ kind: "headers", changes: {} }, "page")).toBeNull();
        expect(winnerOf(null, "page")).toBeNull();
    });
});

describe("header edits: the later one wins per header", () => {
    const A = { scriptId: "a", scriptName: "A", kind: "onRequest" as const, index: 0 };
    const B = { scriptId: "b", scriptName: "B", kind: "onRequest" as const, index: 0 };
    it("a later remove deletes an earlier set (case-insensitive)", () => {
        expect(mergeHeaderEdits({ set: { "X-Token": "1" } }, { remove: ["x-token"] })).toEqual({ set: {}, remove: ["x-token"] });
    });
    it("a later set drops an earlier remove", () => {
        expect(mergeHeaderEdits({ remove: ["x-token"] }, { set: { "X-Token": "2" } })).toEqual({ set: { "X-Token": "2" }, remove: [] });
    });
    it("reports the override, not a repeat of the same value", () => {
        const s = new HeaderStack();
        expect(s.add({ set: { a: "1", b: "1" } }, A)).toEqual([]);
        expect(s.add({ set: { a: "2", b: "1" } }, B)).toEqual([{ header: "a", by: B, over: A }]);
        expect(s.result()).toEqual({ set: { a: "2", b: "1" }, remove: [] });
    });
});
