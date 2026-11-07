import { describe, expect, it } from "vitest";
import { collectProblems, extensionsLink, type ProblemMarker, type ProblemScript } from "../src/ui/problems";
import { addUiPort, log } from "../src/background/engine/logs";
import { appendLog, shownLines } from "../src/ui/state/log";
import { contextTag } from "../src/shared/scriptLog";
import { NO_SITE_STORE, SITE_DISALLOWED, SITE_NO_HANDLES, SITE_NO_STORES, siteRemote } from "../src/shared/remote";
import "../src/shared/transpile";
import { compileScript, siteProblems } from "../src/shared/compile";
import { userScriptsProblem } from "../src/shared/userScriptsStatus";
import { onPageEdit, siteStoreEdits } from "../src/ui/placeFix";

const script = (id: string, over: Partial<ProblemScript> = {}): ProblemScript => ({ id, label: `${id}.ts`, error: null, ...over });
const none = new Map<string, ProblemMarker[]>();
const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("GUI context tags (Log / Problems)", () => {
    it("tags read context › host", () => {
        expect(contextTag("overlay", "https://shop.example:8080/a")).toBe("overlay › shop.example:8080");
        expect(contextTag("isolated")).toBe("isolated");
        expect(contextTag("page", "not a url")).toBe("page");
    });

    it("the background log carries the tag to the Log view", () => {
        const got: any[] = [];
        addUiPort({ postMessage: (m: any) => got.push(m), onDisconnect: { addListener: () => {} } } as any);
        log(3, "[S] hello", "info", null, undefined, undefined, undefined, "overlay › a.example");
        log(3, "[S] plain", "info");
        const entries = got.filter((m) => m.type === "log").map((m) => m.entry);
        expect(entries.find((e) => e.message === "[S] hello").ctx).toBe("overlay › a.example");
        expect(entries.find((e) => e.message === "[S] plain")).not.toHaveProperty("ctx");
    });

    it("the Log state keeps a string tag", () => {
        appendLog({ at: Date.now(), message: "[S] tagged", ctx: "isolated › a.example" });
        appendLog({ at: Date.now(), message: "[S] untagged", ctx: 3 });
        const items = shownLines().slice(-2);
        expect(items[0]).toMatchObject({ message: "[S] tagged", ctx: "isolated › a.example" });
        expect(items[1]).not.toHaveProperty("ctx");
    });

    it("a runtime error from GUI code says where it came from", () => {
        const [g] = collectProblems([script("a", { runtimeError: { message: "[a] TypeError: boom", at: Date.now(), count: 1, ctx: "overlay › a.example" } })], none);
        expect(g.problems[0]).toMatchObject({ kind: "runtime", context: "overlay › a.example" });
        expect(g.problems[0].message).toMatch(/^Runtime error \([^)]*\): overlay › a\.example › \[a\] TypeError: boom/);
        const [plain] = collectProblems([script("a", { runtimeError: { message: "x", at: Date.now(), count: 1 } })], none);
        expect(plain.problems[0]).not.toHaveProperty("context");
    });

    it("isolated code with user scripts off is an error with a link to the extension's page", () => {
        const msg = userScriptsProblem("onPage #1 (https://a.example/*)", "off", ID);
        const [g] = collectProblems([script("a", { routeWarnings: [msg, "some other route warning"] })], none);
        expect(g.problems.map((p) => p.severity)).toEqual(["error", "warning"]);
        expect(extensionsLink(msg)?.text).toBe(`chrome://extensions/?id=${ID}`);
        expect(extensionsLink("chrome://extensions/?id=short")).toBeNull();
    });
});

describe("onSite code calling a handle", () => {
    it("the site remote reports the call and throws right there", () => {
        const seen: Error[] = [];
        const r: any = siteRemote((e) => seen.push(e));
        expect(() => r.pick()).toThrow(SITE_NO_HANDLES);
        expect(seen).toHaveLength(1);
        expect(seen[0].name).toBe("SiteCannotCallError");
        expect(r.then).toBeUndefined();
    });

    const fix = (code: string, at = code.indexOf("overlay.")) => {
        const e = onPageEdit(code, at);
        return e && code.slice(0, e.start) + e.text + code.slice(e.end);
    };
    it("the quick fix moves the nearest onSite handler to onPage", () => {
        expect(fix(`wt.onSite("https://a/*", (x) => overlay.pick());`)).toBe(`wt.onPage("https://a/*", (x) => overlay.pick());`);
        const two = `wt.onSite("https://a/*", () => {});\nwt.onSite({ url: "https://b/*" }, () => overlay.pick());`;
        expect(fix(two)).toBe(`wt.onSite("https://a/*", () => {});\nwt.onPage({ url: "https://b/*" }, () => overlay.pick());`);
        expect(onPageEdit(`x.overlay.pick()`, 2)).toBeNull();
        expect(onPageEdit(`wt.onPage("https://a/*", () => overlay.pick());`, 30)).toBeNull();
    });

    it("an onSite store/handle warning points at its registration line, and the fix applies from the marker's end", () => {
        const code = `const ps = wt.pageStore("ps", { n: 0 });\nwt.onSite("https://a/*", () => {\n    ps.n++;\n});`;
        const routes = compileScript(code).handlers.onDocument.map((h) => h.route);
        const msg = siteProblems(code, routes)[0];
        expect(msg).toContain(SITE_DISALLOWED);
        expect(msg).toMatch(/^onSite #1\b.*uses `ps`/);
        const moved = code.replace("onSite", "onPage");
        expect(siteProblems(moved, compileScript(moved).handlers.onDocument.map((h) => h.route))).toEqual([]);
        const [g] = collectProblems([script("a", { code, routeWarnings: [msg], routes })], none);
        const p = g.problems[0] as any;
        expect(p.line).toBe(3);
        const lines = code.split("\n");
        const end = lines.slice(0, p.endLine - 1).reduce((n, l) => n + l.length + 1, 0) + p.endColumn - 1;
        expect(fix(code, end)).toBe(moved);
        expect(msg).toContain(SITE_NO_STORES);
        expect(toSite(code, end)).toBe(code.replace("wt.pageStore", "wt.siteStore"));
    });

    it("wt.siteStore in a network handler is an error at its use; in onSite code it's fine", () => {
        const code = `const flags = wt.siteStore("flags", { on: false });\nwt.onRequest("https://a/*", (req) => {\n    if (flags.on) req.url = "https://b/";\n});\nwt.onSite("https://a/*", () => { flags.on = true; });\nwt.onResponseBody("https://a/*", () => wt.siteStore("x", {}));`;
        const all = [
            { kind: "onRequest", index: 0, url: ["https://a/*"], line: 2 },
            { kind: "onDocument", api: "onSite", index: 0, n: 0, url: ["https://a/*"], line: 5 },
            { kind: "onResponseBody", index: 0, url: ["https://a/*"], line: 6 },
        ] as any[];
        const msgs = siteProblems(code, all);
        expect(msgs).toEqual([`onRequest #1: uses \`flags\` — ${NO_SITE_STORE}`, `onResponseBody #1: uses \`wt.siteStore\` — ${NO_SITE_STORE}`]);
        const [g] = collectProblems([script("a", { code, routeWarnings: msgs, routes: all })], none);
        expect(g.problems.map((p: any) => [p.severity, p.line, p.column])).toEqual([
            ["error", 3, 9],
            ["error", 6, 40],
        ]);
    });

    const toSite = (code: string, at: number) => {
        let out = code;
        for (const e of siteStoreEdits(code, at).reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
        return out;
    };
    it("the siteStore fix changes the stores the nearest onSite handler uses, bound or direct, and drops a globalStore's persist", () => {
        const code = [
            `const a = wt.globalStore("a", { n: 0 }, { persist: "local" });`,
            `const b: { n: number } = wt.pageStore("b", { n: 0 });`,
            `const c = wt.pageStore("c", { n: 0 });`,
            `wt.onSite("https://a/*", () => { a.n++; b.n++; wt.globalStore("d", { x: [1, 2] }, "session").x; });`,
        ].join("\n");
        expect(toSite(code, code.indexOf("a.n++"))).toBe(
            [
                `const a = wt.siteStore("a", { n: 0 });`,
                `const b: { n: number } = wt.siteStore("b", { n: 0 });`,
                `const c = wt.pageStore("c", { n: 0 });`,
                `wt.onSite("https://a/*", () => { a.n++; b.n++; wt.siteStore("d", { x: [1, 2] }).x; });`,
            ].join("\n")
        );
        // "a.n" in a string, and a handler that uses none
        expect(siteStoreEdits(`const a = wt.pageStore("a", {});\nwt.onSite("x", () => "a.n");`, 40)).toEqual([]);
        expect(siteStoreEdits(`const a = wt.pageStore("a", {});`, 10)).toEqual([]);
    });
});
