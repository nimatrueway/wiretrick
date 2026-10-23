import { describe, it, expect } from "vitest";
import { indexTypeDeclarations, resolveTypeName, commandUri, typeRefs, flattenNavTree, declarationName, type NavTreeItem } from "../src/ui/apiLinks";
import { NavHistory } from "../src/ui/navHistory";
import { partsToMarkdown, docsToMarkdown } from "../src/ui/hoverMarkdown";

const t = (text: string, kind = "text") => ({ text, kind });
const sp = (start: number, length = 1) => ({ start, length });
const nav = (text: string, kind: string, start: number, childItems?: NavTreeItem[]): NavTreeItem => ({ text, kind, spans: [sp(start - 1, 50)], nameSpan: sp(start, text.length), childItems });

// (method) onRequest(route: Wiretrick.Route, handler: (ctx: Wiretrick.RequestCtx) => Wiretrick.Awaitable<...>): void
const onRequestParts = [
    t("(method) "), t("onRequest", "methodName"), t("("), t("route", "parameterName"), t(": "),
    t("Wiretrick", "moduleName"), t(".", "punctuation"), t("Route", "aliasName"), t(", "),
    t("handler", "parameterName"), t(": ("), t("ctx", "parameterName"), t(": "),
    t("Wiretrick", "moduleName"), t(".", "punctuation"), t("RequestCtx", "interfaceName"), t(") => "),
    t("Wiretrick", "moduleName"), t(".", "punctuation"), t("Awaitable", "aliasName"), t("<"), t("T", "typeParameterName"), t(" | "),
    t("Wiretrick", "moduleName"), t(".", "punctuation"), t("Route", "aliasName"), t(" | "), t("Response", "interfaceName"), t(">): void"),
];

const tree: NavTreeItem = nav("<global>", "script", 0, [
    nav("Wiretrick", "module", 10, [nav("Route", "type", 100), nav("RequestCtx", "interface", 200, [nav("url", "property", 210)]), nav("Awaitable", "type", 300)]),
    nav("wt", "const", 400),
    nav("URLPattern", "interface", 500),
    nav("URLPattern", "var", 600),
]);

describe("api type links", () => {
    it("indexes namespace members and top-level types from the navigation tree", () => {
        const index = indexTypeDeclarations(tree);
        expect([...index.keys()]).toEqual(["Wiretrick.Route", "Wiretrick.RequestCtx", "Wiretrick.Awaitable", "URLPattern"]);
        expect(index.get("URLPattern")).toEqual(sp(500, 10)); // the interface, not the var
        expect(index.get("Wiretrick.RequestCtx")).toEqual(sp(200, 10));
    });

    it("resolves bare namespace members only inside the typings", () => {
        const index = indexTypeDeclarations(tree);
        expect(resolveTypeName(index, "Wiretrick.Route", false)).toEqual(sp(100, 5));
        expect(resolveTypeName(index, "Route", false)).toBeUndefined();
        expect(resolveTypeName(index, "Route", true)).toEqual(sp(100, 5));
        expect(resolveTypeName(index, "Response", true)).toBeUndefined();
    });

    it("finds every wt-api.d.ts type in a signature, minus the hovered declaration itself", () => {
        const index = indexTypeDeclarations(tree);
        const sig = partsToMarkdown(onRequestParts);
        const refs = typeRefs(onRequestParts, index, false);
        expect(refs.map((r) => sig.slice(r.start, r.end))).toEqual(["Route", "RequestCtx", "Awaitable", "Route"]);
        expect(refs.map((r) => r.name)).toEqual(["Wiretrick.Route", "Wiretrick.RequestCtx", "Wiretrick.Awaitable", "Wiretrick.Route"]);
        expect(refs[1].span).toEqual(sp(200, 10));
        expect(typeRefs(onRequestParts, index, false, sp(100, 5)).map((r) => r.name)).toEqual(["Wiretrick.RequestCtx", "Wiretrick.Awaitable"]);
        // inside the typings TS doesn't qualify namespace members
        expect(typeRefs([t("x: "), t("Route", "aliasName")], index, true)).toEqual([{ start: 3, end: 8, name: "Route", span: sp(100, 5) }]);
        expect(typeRefs([t("x: "), t("Route", "aliasName")], index, false)).toEqual([]);
        expect(typeRefs(undefined, index, false)).toEqual([]);
    });

    it("maps a {@link} target (a whole declaration) to the declaration's name", () => {
        const items = flattenNavTree(tree);
        expect(items.map((i) => i.text)).toEqual(["Wiretrick", "Route", "RequestCtx", "url", "Awaitable", "wt", "URLPattern", "URLPattern"]);
        expect(declarationName(items, sp(199, 50))).toEqual(sp(200, 10)); // interface RequestCtx
        expect(declarationName(items, sp(209, 50))).toEqual(sp(210, 3)); // RequestCtx.url
        expect(declarationName(items, sp(205, 3))).toEqual(sp(200, 10)); // inside RequestCtx: innermost container
        expect(declarationName(items, sp(5000, 3))).toBeUndefined();
    });

    it("builds command links Monaco can execute", () => {
        const uri = commandUri("wt.x", { start: 5, label: "Route" });
        expect(uri).toBe(`command:wt.x?${encodeURIComponent('{"start":5,"label":"Route"}')}`);
        expect(JSON.parse(decodeURIComponent(uri.split("?")[1]))).toEqual({ start: 5, label: "Route" });
        expect(commandUri("x", { a: "f(1)" })).not.toMatch(/[()]/);
    });

    it("links {@link X} when the resolver knows its target, else keeps `X`", () => {
        const target = { fileName: "file:///wt-api.d.ts", textSpan: sp(100, 5) };
        const parts = [t("See "), t("{@link ", "link"), { ...t("Wiretrick.Route", "linkName"), target }, t("}", "link"), t(" and "), t("{@link ", "link"), t("Other", "linkName"), t("}", "link")];
        const resolve = (_: string, p: any) => (p.target?.fileName === "file:///wt-api.d.ts" ? "command:go" : undefined);
        expect(partsToMarkdown(parts, resolve)).toBe("See [`Wiretrick.Route`](command:go) and `Other`");
        expect(partsToMarkdown(parts)).toBe("See `Wiretrick.Route` and `Other`");
        const labelled = [t("{@link ", "link"), { ...t("A", "linkName"), target }, t("the A", "linkText"), t("}", "link")];
        expect(partsToMarkdown(labelled, resolve)).toBe("[the A](command:go)");
        // tags too, but never inside @example code
        const tags = [{ name: "see", text: parts }, { name: "example", text: parts }];
        expect(docsToMarkdown(undefined, tags, undefined, resolve)).toBe(
            "*@see* — See [`Wiretrick.Route`](command:go) and `Other`\n\n*@example*  \n```typescript\nSee `Wiretrick.Route` and `Other`\n```"
        );
    });
});

describe("navigation history", () => {
    const go = (log: string[]) => (to: string) => (log.push(to), true);

    it("goes back and forward VS Code style; a new jump drops the forward branch", () => {
        const h = new NavHistory<string>();
        const log: string[] = [];
        expect(h.back("a", go(log))).toBe(false);
        h.push("a"); // a → b
        h.push("b"); // b → c
        expect(h.back("c", go(log))).toBe(true);
        expect(h.back("b", go(log))).toBe(true);
        expect(h.canGoBack).toBe(false);
        expect(h.forward("a", go(log))).toBe(true);
        expect(log).toEqual(["b", "a", "b"]);
        h.push("b"); // jump b → d
        expect(h.canGoForward).toBe(false);
        expect(h.back("d", go(log))).toBe(true);
        expect(log[log.length - 1]).toBe("b");
    });

    it("skips gone entries and keeps a cancelled one", () => {
        const h = new NavHistory<string>();
        h.push("gone-before");
        h.push("x");
        h.push("gone");
        expect(h.back("here", (to) => (to.startsWith("gone") ? "skip" : false))).toBe(false); // x cancelled
        expect(h.canGoBack).toBe(true);
        const log: string[] = [];
        expect(h.back("here", (to) => (to.startsWith("gone") ? "skip" : (log.push(to), true)))).toBe(true);
        expect(log).toEqual(["x"]);
        expect(h.back("x", (to) => (to.startsWith("gone") ? "skip" : true))).toBe(false); // only a gone one left
        expect(h.forward("x", go(log))).toBe(true);
        expect(log[log.length - 1]).toBe("here");
    });

    it("caps its length", () => {
        const h = new NavHistory<number>(3);
        for (let i = 0; i < 10; i++) h.push(i);
        const seen: number[] = [];
        while (h.back(-1, (to) => (seen.push(to), true)));
        expect(seen).toEqual([9, 8, 7]);
    });
});
