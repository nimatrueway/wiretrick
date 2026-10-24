/** Network filter query language: parsing, errors, matching, Basic chips ⇄ query and autocomplete. */
import { describe, it, expect } from "vitest";
import { addChip, backspaceStructure, basicStops, basicSuggest, closeGap, commitGap, commitTyped, deleteAtGap, openPath, parenAtGap, compileQuery, complete, emptyBasic, fromBasic, leafChips, nodeToString, parseQuery, removeChips, suggestData, toBasic, toggleConn, typeStructure, type BasicFilter, type BasicGap, type QueryCtx, type SuggestData } from "../src/ui/network/netQuery";
import type { NetEntry, NetOutcome } from "../src/shared/netTypes";

const out = (scriptName: string, kind: NetOutcome["kind"]): NetOutcome => ({ scriptId: scriptName, scriptName, action: "x", level: "info", kind, at: 0 });

function entry(id: string, over: Partial<NetEntry> = {}): NetEntry {
    return {
        id,
        tabId: 1,
        url: `https://api.example.com/v1/${id}?q=1`,
        method: "GET",
        type: "xmlhttprequest",
        status: 200,
        statusText: "OK",
        mime: "application/json",
        size: 100,
        fromCache: false,
        startedAt: 0,
        endedAt: 50,
        state: "done",
        outcomes: [],
        ...over,
    };
}

const rows: NetEntry[] = [
    entry("users"),
    entry("login", { method: "POST", status: 401, requestBody: { text: '{"user":"bob"}', size: 14, truncated: false, binary: false }, outcomes: [out("Auth", "modified")] }),
    entry("app.js", { url: "https://cdn.test/app.js", type: "script", mime: "text/javascript", size: 20480, endedAt: 900, tabId: 2, outcomes: [out("Logger", "observed")] }),
    entry("scopes", {
        status: 500,
        responseHeaders: [
            ["Content-Type", "application/json"],
            ["X-Java-Method", "Scopes.get"],
        ],
        requestHeaders: [["Authorization", "Bearer x"]],
        responseBody: { text: '{"error":"boom"}', size: 16, truncated: false, binary: false },
    }),
    entry("img", { url: "https://cdn.test/logo.png", type: "image", mime: "image/png", status: null, state: "failed", fromCache: true, size: null, endedAt: null }),
];

const ctx: QueryCtx = { tabTitle: (id) => (id === 1 ? "Atlas – Projects" : id === 2 ? "CDN Docs" : undefined) };

function ids(q: string): string[] {
    const { ast, error } = parseQuery(q);
    expect(error).toBeNull();
    const f = compileQuery(ast, ctx);
    return rows.filter(f).map((e) => e.id);
}
const err = (q: string) => parseQuery(q).error;

describe("netQuery matching", () => {
    it("empty query matches everything; bare words are URL contains (AND)", () => {
        expect(ids("")).toEqual(["users", "login", "app.js", "scopes", "img"]);
        expect(ids("cdn")).toEqual(["app.js", "img"]);
        expect(ids("cdn logo")).toEqual(["img"]);
        expect(ids("-cdn")).toEqual(["users", "login", "scopes"]);
        expect(ids("LOGIN")).toEqual(["login"]);
    });

    it("fields, comma lists, OR, NOT and groups", () => {
        expect(ids("method:post")).toEqual(["login"]);
        expect(ids("method:GET,POST host:cdn")).toEqual(["app.js", "img"]);
        expect(ids("status:4xx OR status:5xx")).toEqual(["login", "scopes"]);
        expect(ids("NOT host:api.example.com")).toEqual(["app.js", "img"]);
        expect(ids("-(type:fetch OR type:img)")).toEqual(["app.js"]);
        expect(ids("(users OR app) host:cdn")).toEqual(["app.js"]);
        expect(ids("users AND host:api")).toEqual(["users"]);
    });

    it("status: codes, classes, comparisons and ranges; pending/failed rows never match a number", () => {
        expect(ids("status:200")).toEqual(["users", "app.js"]);
        expect(ids("status:>=400")).toEqual(["login", "scopes"]);
        expect(ids("status:<300")).toEqual(["users", "app.js"]);
        expect(ids("status:400..499")).toEqual(["login"]);
    });

    it("size and time with units", () => {
        expect(ids("size:>10kb")).toEqual(["app.js"]);
        expect(ids("size:<1kb")).toEqual(["users", "login", "scopes"]);
        expect(ids("time:>500ms")).toEqual(["app.js"]);
        expect(ids("time:<0.1s")).toEqual(["users", "login", "scopes"]);
    });

    it("type matches the category, the Type column label or the raw type", () => {
        expect(ids("type:fetch")).toEqual(["users", "login", "scopes"]);
        expect(ids("type:xhr")).toEqual(["users", "login", "scopes"]);
        expect(ids("type:js")).toEqual(["app.js"]);
        expect(ids("type:img")).toEqual(["img"]);
    });

    it("headers: presence, value contains, value regex, name wildcard", () => {
        expect(ids("req-header:authorization")).toEqual(["scopes"]);
        expect(ids("res-header:x-java-method")).toEqual(["scopes"]);
        expect(ids("res-header:content-type=json")).toEqual(["scopes"]);
        expect(ids('res-header:content-type="application/json"')).toEqual(["scopes"]);
        expect(ids("res-header:content-type=/^text/")).toEqual([]);
        expect(ids("res-header:x-java-*")).toEqual(["scopes"]);
        expect(ids("-res-header:x-java-method")).toEqual(["users", "login", "app.js", "img"]);
    });

    it("bodies, tab titles/ids, scripts, mime", () => {
        expect(ids("req-body:bob")).toEqual(["login"]);
        expect(ids('res-body:"boom"')).toEqual(["scopes"]);
        expect(ids('tab:"cdn docs"')).toEqual(["app.js"]);
        expect(ids("tab:2")).toEqual(["app.js"]);
        expect(ids("script:auth")).toEqual(["login"]);
        expect(ids("mime:image/")).toEqual(["img"]);
    });

    it("is: qualifiers", () => {
        expect(ids("is:touched")).toEqual(["login", "app.js"]);
        expect(ids("is:modified")).toEqual(["login"]);
        expect(ids("is:observed")).toEqual(["app.js"]);
        expect(ids("is:failed")).toEqual(["img"]);
        expect(ids("is:cached")).toEqual(["img"]);
        expect(ids("is:failed,modified")).toEqual(["login", "img"]);
    });

    it("exact (=), wildcard (*) and /regex/ values", () => {
        expect(ids("host:=cdn.test")).toEqual(["app.js", "img"]);
        expect(ids("host:=cdn")).toEqual([]);
        expect(ids("host:*.example.com")).toEqual(["users", "login", "scopes"]);
        expect(ids("/v1\\/(users|login)/")).toEqual(["users", "login"]);
        expect(ids("path:/\\.png$/")).toEqual(["img"]);
        expect(ids("path:/v1/")).toEqual(["users", "login", "scopes"]);
    });

    it("pasted URLs and host:port stay bare words", () => {
        expect(ids("https://cdn.test/app.js")).toEqual(["app.js"]);
        expect(parseQuery("localhost:3000").error).toBeNull();
    });
});

describe("netQuery errors point at the problem", () => {
    it("reports syntax errors with their position", () => {
        expect(err("method:GET (status:200")).toMatchObject({ message: "Missing )", start: 11 });
        expect(err("a )")).toMatchObject({ message: "Unmatched )", start: 2, end: 3 });
        expect(err('url:"abc')).toMatchObject({ message: "Unclosed quote", start: 4 });
        expect(err("a OR")).toMatchObject({ message: "OR needs a filter after it", start: 2 });
        expect(err("NOT")).toMatchObject({ message: "NOT needs a filter after it" });
        expect(err("method:")).toMatchObject({ message: '"method:" needs a value' });
    });

    it("reports unknown fields and bad values", () => {
        expect(err("methd:GET")).toMatchObject({ start: 0, end: 5 });
        expect(err("methd:GET")!.message).toContain('Unknown field "methd"');
        expect(err("status:abc")).toMatchObject({ start: 7, end: 10 });
        expect(err("size:>10zz")!.message).toContain("size:");
        expect(err("is:nope")!.message).toContain("touched");
        expect(err("url:/[/")!.message).toBe("Invalid regular expression");
        expect(err("x status:200,abc")).toMatchObject({ start: 13, end: 16 });
    });
});

describe("Basic chips ⇄ query", () => {
    const chip = (field: string, values: string[], negate = false) => ({ k: "chip", chip: { field, negate, values } });
    const round = (q: string) => fromBasic(toBasic(parseQuery(q).ast));

    it("splits a flat AND into text and chips (OR of one field = one chip)", () => {
        const b = toBasic(parseQuery('api -cdn method:GET,POST -status:4xx (type:js OR type:css) tab:"My tab"').ast);
        expect(b).toEqual({
            text: "api -cdn",
            expr: {
                items: [chip("method", ["GET", "POST"]), chip("status", ["4xx"], true), chip("type", ["js", "css"]), chip("tab", ['"My tab"'])],
                conns: ["AND", "AND", "AND"],
            },
        });
        expect(fromBasic(b)).toBe('api -cdn method:GET,POST -status:4xx type:js,css tab:"My tab"');
    });

    it("keeps any AND / OR / NOT / group: Basic ⇄ Advanced round-trips to the same meaning", () => {
        const b = toBasic(parseQuery("method:GET OR status:500").ast);
        expect(b).toEqual({ text: "", expr: { items: [chip("method", ["GET"]), chip("status", ["500"])], conns: ["OR"] } });
        expect(round("method:GET OR status:500")).toBe("method:GET OR status:500");
        expect(round("api b OR c")).toBe("api b OR c");
        expect(round("a (b OR host:c) -(d e)")).toBe("a (b OR host:c) -(d e)");
        expect(round("x (host:a OR status:5xx) is:modified")).toBe("x (host:a OR status:5xx) is:modified");
        expect(toBasic(parseQuery("-(a b)").ast).expr.items[0]).toMatchObject({ k: "group", negate: true });
        expect(toBasic(parseQuery("").ast)).toEqual(emptyBasic());
        // text and an OR'ed expression are each kept together
        expect(fromBasic({ text: "api", expr: toBasic(parseQuery("host:a OR host:b x").ast).expr })).toBe("api (host:a OR host:b x)");
    });

    it("adding a chip to an OR'ed expression groups it first; same-field picks merge only when all-AND", () => {
        const or = toBasic(parseQuery("host:a OR status:500").ast);
        expect(fromBasic(addChip(or, { field: "method", negate: false, values: ["GET"] }))).toBe("(host:a OR status:500) method:GET");
        const and = addChip(addChip(emptyBasic(), { field: "method", negate: false, values: ["GET"] }), { field: "method", negate: false, values: ["POST"] });
        expect(fromBasic(and)).toBe("method:GET,POST");
    });

    it("connectors toggle; removing chips collapses groups", () => {
        const b = toBasic(parseQuery("is:modified (host:x OR host:y status:2) method:GET").ast);
        expect(fromBasic({ ...b, expr: toggleConn(b.expr, [], 0) })).toBe("is:modified OR (host:x OR host:y status:2) method:GET");
        expect(fromBasic({ ...b, expr: toggleConn(b.expr, [1], 0) })).toBe("is:modified (host:x host:y status:2) method:GET");
        const [, x, , st] = leafChips(b.expr);
        expect(fromBasic({ ...b, expr: removeChips(b.expr, new Set([x])) })).toBe("is:modified (host:y status:2) method:GET");
        expect(fromBasic({ ...b, expr: removeChips(b.expr, new Set([x, st])) })).toBe("is:modified host:y method:GET");
        expect(removeChips(b.expr, new Set(leafChips(b.expr)))).toEqual({ items: [], conns: [] });
    });

    it("typing AND / OR / ( / ) turns them into chips as you go", () => {
        /** type char by char into the text box (caret at the end), like the bar does */
        const type = (b: BasicFilter, str: string) => [...str].reduce((x, ch) => typeStructure(x, x.text + ch) ?? { ...x, text: x.text + ch }, b);
        let b = type(emptyBasic(), "method:GET OR ");
        expect(b).toMatchObject({ text: "", conn: "OR" });
        expect(fromBasic(b)).toBe("method:GET");
        b = type(b, "(host:a AND status:5xx");
        expect(b.text).toBe("status:5xx"); // the last word waits for the next keystroke
        expect(fromBasic(b)).toBe("method:GET OR (host:a status:5xx)"); // live: the words being typed count where they go
        b = type(b, ")");
        expect(b).toMatchObject({ text: "" });
        expect(fromBasic(b)).toBe("method:GET OR (host:a status:5xx)");
        b = type(b, " -(api");
        expect(fromBasic(commitTyped(b)!)).toBe("method:GET OR (host:a status:5xx) -(api)"); // still open: Enter keeps it open
        // nothing to join yet: "OR " is just text; a word can contain "or"
        expect(type(emptyBasic(), "OR ")).toEqual({ ...emptyBasic(), text: "OR " });
        expect(type(emptyBasic(), "fooOR ").conn).toBeUndefined();
        // Backspace: the typed connector, then an empty open group, then the last chip
        b = type(emptyBasic(), "host:a OR (");
        expect(b.expr.items).toHaveLength(2);
        b = backspaceStructure(b)!;
        expect(fromBasic(b)).toBe("host:a");
        expect(b.conn).toBe("OR");
        b = backspaceStructure(b)!;
        expect(b.conn).toBeUndefined();
        expect(fromBasic(backspaceStructure(b)!)).toBe("");
        // a picked chip goes where you're typing
        b = type(emptyBasic(), "host:a OR ");
        expect(fromBasic(addChip(b, { field: "method", negate: false, values: ["GET"] }))).toBe("host:a OR method:GET");
    });

    it("prints an AST back with the needed parentheses", () => {
        expect(nodeToString(parseQuery("a (b OR c) -(d e)").ast!)).toBe("a (b OR c) -(d e)");
        expect(nodeToString(parseQuery("a b OR c").ast!)).toBe("(a b) OR c");
    });
});

describe("Basic: the text box among the chips", () => {
    const at = (q: string, gap: BasicGap): BasicFilter => ({ ...toBasic(parseQuery(q).ast), at: gap });
    it("inserts where the caret is: the left connector stays, the right one is AND", () => {
        const b = commitGap(at("method:POST OR host:cdn", { path: [], index: 1, text: "a.js" }))!;
        expect(fromBasic(b)).toBe("method:POST OR a.js host:cdn");
        expect(b.at).toEqual({ path: [], index: 2, text: "" });
        expect(fromBasic(commitGap(at("a OR b", { path: [], index: 0, text: "x" }))!)).toBe("x a OR b");
    });
    it("an OR'ed insert is grouped; an edit replaces its chip; an emptied edit removes it", () => {
        expect(fromBasic(commitGap(at("host:a host:b", { path: [], index: 1, text: "x OR y" }))!)).toBe("host:a (x OR y) host:b");
        expect(fromBasic(commitGap(at("a OR b", { path: [], index: 1, edit: true, text: "-c" }))!)).toBe("a OR -c");
        const gone = commitGap(at("a OR b", { path: [], index: 0, edit: true, text: "" }))!;
        expect([fromBasic(gone), gone.at]).toEqual(["b", undefined]);
        expect(commitGap(at("a", { path: [], index: 0, text: 'x"' }))).toBeNull(); // doesn't parse: stays put
    });
    it("counts live while typed; closing keeps the structure", () => {
        expect(fromBasic(at("host:a host:b", { path: [], index: 1, text: "x" }))).toBe("host:a x host:b");
        expect(closeGap({ ...at("host:a host:b", { path: [], index: 1, text: "x" }), text: "c" })).toMatchObject({ text: "c x", at: undefined });
        expect(closeGap(at("host:a host:b", { path: [], index: 1, edit: true, text: "x" })).text).toBe("");
    });
    it("stops: a gap before each item and at the end of closed groups, then the end", () => {
        const e = toBasic(parseQuery("host:a (host:b OR method:GET)").ast).expr;
        expect(basicStops(e)).toEqual([
            { k: "gap", path: [], index: 0 },
            { k: "chip", leaf: 0 },
            { k: "gap", path: [], index: 1 },
            { k: "gap", path: [1], index: 0 },
            { k: "chip", leaf: 1 },
            { k: "gap", path: [1], index: 1 },
            { k: "chip", leaf: 2 },
            { k: "gap", path: [1], index: 2 },
            { k: "end" },
        ]);
    });
    it("removing a chip can keep the connector on its left", () => {
        const b = toBasic(parseQuery("a OR x b").ast);
        const x = leafChips(b.expr)[1];
        expect(fromBasic({ ...b, expr: removeChips(b.expr, new Set([x])) })).toBe("a b");
        expect(fromBasic({ ...b, expr: removeChips(b.expr, new Set([x]), true, true) })).toBe("a OR b");
    });
});

describe("Basic: parentheses among the chips, as in text", () => {
    const at = (q: string, path: number[], index: number): BasicFilter => ({ ...toBasic(parseQuery(q).ast), at: { path, index, text: "" } });
    it("( here, then ) further on", () => {
        const open = parenAtGap(at("host:a OR path:b host:c", [], 0), "(")!;
        expect(open.at).toEqual({ path: [0], index: 0, text: "" });
        expect(open.expr.items[0]).toMatchObject({ k: "group", open: true });
        const closed = parenAtGap({ ...open, at: { path: [0], index: 2, text: "" } }, ")")!;
        expect(fromBasic(closed)).toBe("(host:a OR path:b) host:c");
        expect(closed.at).toEqual({ path: [], index: 1, text: "" });
    });
    it(") first, then ( before it; -( negates", () => {
        const u = parenAtGap(at("host:x host:a OR path:b host:c", [], 3), ")")!;
        expect(u.expr.items[0]).toMatchObject({ k: "group", unopened: true });
        expect(u.at).toEqual({ path: [], index: 1, text: "" });
        const done = parenAtGap({ ...u, at: { path: [0], index: 1, text: "" } }, "-(")!;
        expect(fromBasic(done)).toBe("host:x -(host:a OR path:b) host:c");
        expect(done.at).toEqual({ path: [1], index: 0, text: "" });
    });
    it("Backspace / Delete next to a parenthesis deletes just it", () => {
        const reopened = deleteAtGap(at("(host:a OR path:b) host:c", [], 1), -1)!; // ")" goes: the group runs to the end
        expect(reopened.expr.items).toHaveLength(1);
        expect(reopened.expr.items[0]).toMatchObject({ open: true });
        expect(reopened.at).toEqual({ path: [0], index: 2, text: "" });
        const flat = deleteAtGap({ ...reopened, at: { path: [0], index: 0, text: "" } }, -1)!; // and its "(" too
        expect([fromBasic(flat), flat.at]).toEqual(["host:a OR path:b host:c", { path: [], index: 0, text: "" }]);
        const fromStart = deleteAtGap(at("host:x (host:a OR path:b)", [], 1), 1)!; // "(" goes: the group runs from the start
        expect(fromStart.expr.items[0]).toMatchObject({ unopened: true });
        expect(fromStart.at).toEqual({ path: [0], index: 1, text: "" });
        expect(deleteAtGap(at("host:a host:b", [], 1), -1)).toBeNull(); // a chip: removed as before
    });
    it("at the end: a lone ) closes everything so far; Backspace takes a group's ) back", () => {
        expect(typeStructure(toBasic(parseQuery("host:a OR path:b").ast), ")")!.expr.items[0]).toMatchObject({ unopened: true });
        const b = backspaceStructure(toBasic(parseQuery("host:c (host:a OR path:b)").ast))!;
        expect(openPath(b.expr)).toEqual([1]);
    });
});

describe("Basic suggestions", () => {
    const data: SuggestData = { methods: ["GET", "POST"], statuses: ["200", "404"], hosts: ["api.test", "cdn.test"], mimes: [], scripts: ["Posty"], tabs: ["Home"], reqHeaders: [], resHeaders: ["content-type"] };
    const labels = (t: string) => basicSuggest(t, data).map((s) => s.label);

    it("matches fields by prefix, then known values as ready chips", () => {
        expect(labels("sta")).toEqual(["status:"]);
        expect(labels("po")).toEqual(["method: POST", "script: Posty"]);
        expect(labels("4")).toContain("status: 404");
        expect(labels("4")).toContain("status: 4xx");
        expect(basicSuggest("po", data)[0]).toMatchObject({ kind: "chip", chip: { field: "method", negate: false, values: ["POST"] } });
    });

    it("'-word' negates; 'field:' narrows to that field; URLs suggest nothing", () => {
        expect(basicSuggest("-get", data)[0]).toMatchObject({ kind: "chip", label: "method ≠ GET", chip: { negate: true } });
        expect(labels("host:cd")).toEqual(["host:cd", "host: cdn.test"]);
        expect(basicSuggest("res-header:", data)[0]).toMatchObject({ kind: "field", field: { name: "res-header" } });
        expect(labels("http://x")).toEqual([]);
        expect(labels("")).toEqual([]);
    });
});

describe("autocomplete", () => {
    const data = suggestData(rows, ctx.tabTitle);

    it("suggests field names for a bare word, replacing the whole word", () => {
        const c = complete("api me", 6, data)!;
        expect(c.from).toBe(4);
        expect(c.to).toBe(6);
        expect(c.items[0].insert).toBe("method:");
        expect(complete("-st", 3, data)!.items[0]).toMatchObject({ insert: "status:" });
        expect(complete("zzz", 3, data)).toBeNull();
    });

    it("suggests values after field: and after a comma", () => {
        const c = complete("method:P", 8, data)!;
        expect(c.from).toBe(7);
        expect(c.items.map((i) => i.label)).toEqual(["POST", "PUT", "PATCH", "OPTIONS"]);
        const d = complete("method:GET,", 11, data)!;
        expect(d.from).toBe(11);
        expect(d.items.map((i) => i.label)).toContain("POST");
        expect(complete("status:", 7, data)!.items.map((i) => i.label)).toEqual(["200", "401", "500", "2xx", "3xx", "4xx", "5xx", ">=400"]);
        expect(complete("is:mo", 5, data)!.items[0].insert).toBe("modified");
    });

    it("quotes text values that need it and suggests seen header names / tab titles", () => {
        expect(complete("tab:cdn", 7, data)!.items[0]).toMatchObject({ label: "CDN Docs", insert: '"CDN Docs"' });
        expect(complete("res-header:x-", 13, data)!.items.map((i) => i.label)).toEqual(["x-java-method"]);
        expect(complete("res-header:content-type=", 24, data)).toBeNull();
        expect(complete('url:"a b', 8, data)).toBeNull();
    });
});
