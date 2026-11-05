import { describe, expect, it } from "vitest";
import { collectProblems, extensionsLink, type ProblemMarker, type ProblemScript } from "../src/ui/problems";
import { addUiPort, log } from "../src/background/engine/logs";
import { appendLog, shownLines } from "../src/ui/state/log";
import { contextTag } from "../src/shared/scriptLog";
import { inertRemote, MAIN_WORLD_DISALLOWED, REMOTE_MAIN_WORLD } from "../src/shared/remote";
import "../src/shared/transpile";
import { compileScript, mainWorldProblems } from "../src/shared/compile";
import { userScriptsProblem } from "../src/shared/userScriptsStatus";
import { isolatedRouteEdit } from "../src/ui/isolatedFix";

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

describe("page-world overlay.fn()", () => {
    it("the inert remote reports the call (with the call site) and rejects", async () => {
        const seen: Error[] = [];
        const r: any = inertRemote(REMOTE_MAIN_WORLD, (e) => seen.push(e));
        await expect(r.pick()).rejects.toThrow(REMOTE_MAIN_WORLD);
        expect(seen).toHaveLength(1);
        expect(seen[0].name).toBe("WtCallError");
    });

    const fix = (code: string, at = code.indexOf("overlay.")) => {
        const e = isolatedRouteEdit(code, at);
        return e && code.slice(0, e.start) + e.text + code.slice(e.end);
    };
    it("the quick fix moves the handler to the isolated world", () => {
        expect(fix(`wt.onPage({ url: "https://a/*", js: "page" }, (x) => x.overlay.pick());`)).toBe(`wt.onPage({ url: "https://a/*", js: "isolated" }, (x) => x.overlay.pick());`);
        expect(fix(`wt.onPage({ url: "https://a/*", js: 'page' }, (x) => x.overlay.pick());`)).toBe(`wt.onPage({ url: "https://a/*", js: "isolated" }, (x) => x.overlay.pick());`);
        expect(fix(`wt.onPage({ url: "https://a/*", js: "page", dom: "overlay", unsafe: true }, (x) => x.overlay.pick());`)).toBe(`wt.onPage({ url: "https://a/*", js: "isolated", dom: "overlay", unsafe: true }, (x) => x.overlay.pick());`);
    });
    it("picks the nearest handler and gives up on what it can't rewrite", () => {
        const two = `wt.onPage({ url: "https://a/*", js: "page" }, () => {});\nwt.onPage({ url: "https://b/*", js: "page" }, (x) => x.overlay.pick());`;
        expect(fix(two)).toBe(`wt.onPage({ url: "https://a/*", js: "page" }, () => {});\nwt.onPage({ url: "https://b/*", js: "isolated" }, (x) => x.overlay.pick());`);
        expect(isolatedRouteEdit(`x.overlay.pick()`, 2)).toBeNull();
        expect(isolatedRouteEdit(`wt.onPage({ url: "https://a/*", js: w }, (x) => x.overlay.pick());`, 50)).toBeNull();
        expect(isolatedRouteEdit(`wt.onPage("https://a/*", (x) => x.overlay.pick());`, 30)).toBeNull();
        expect(isolatedRouteEdit(`wt.onPage("https://a/*`, 20)).toBeNull();
    });

    it("a page-world store/overlay route warning points at its registration line, and the fix applies from the marker's end", () => {
        const code = `const ps = wt.pageStore("ps", { n: 0 });\nwt.onPage({ url: "https://a/*", js: "page" }, () => {\n    ps.n++;\n});`;
        const msg = mainWorldProblems(code, compileScript(code).handlers.onDocument.map((h) => h.route))[0];
        expect(msg).toContain(MAIN_WORLD_DISALLOWED);
        expect(msg).toContain('drop js: "page"');
        expect(mainWorldProblems(code.replace(', js: "page"', ""), compileScript(code.replace(', js: "page"', "")).handlers.onDocument.map((h) => h.route))).toEqual([]);
        const [g] = collectProblems([script("a", { code, routeWarnings: [msg], routes: compileScript(code).handlers.onDocument.map((h) => h.route) })], none);
        const p = g.problems[0] as any;
        expect(p.line).toBe(2);
        const lines = code.split("\n");
        const end = lines.slice(0, p.endLine - 1).reduce((n, l) => n + l.length + 1, 0) + p.endColumn - 1;
        expect(fix(code, end)).toBe(`const ps = wt.pageStore("ps", { n: 0 });\nwt.onPage({ url: "https://a/*", js: "isolated" }, () => {\n    ps.n++;\n});`);
    });
});
