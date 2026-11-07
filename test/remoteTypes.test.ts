// The onSite / onPage / onOverlay typings (wt-api.d.ts): handles infer the other
// side's functions both ways. The expectTypeOf block is checked by
// `npm run typecheck`; the negative cases compile snippets here.
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

// never called: `wt` only exists inside scripts
function typings() {
    const page = wt.onPage("*://example.com/*", () => ({
        count: (sel: string) => document.querySelectorAll(sel).length,
        later: async (n: number) => ({ n }),
    }));
    expectTypeOf(page.count).toEqualTypeOf<(sel: string) => Promise<number>>();
    expectTypeOf(page.later).parameters.toEqualTypeOf<[n: number]>();
    expectTypeOf(page.later).returns.resolves.toEqualTypeOf<{ n: number }>();
    // @ts-expect-error a wrong argument type
    void page.count(1);
    // @ts-expect-error no such function
    void page.nope();

    const site = wt.onSite("*://example.com/*", () => ({ flags: () => ({ a: true }) }));
    expectTypeOf(site.flags).toEqualTypeOf<() => Promise<{ a: boolean }>>();

    const overlay = wt.onOverlay({ url: "*://example.com/*" }, (ctx) => {
        expectTypeOf(ctx.url).toBeString();
        expectTypeOf(ctx.onNavigate).toEqualTypeOf<(fn: (url: string) => void) => () => void>();
        const off: () => void = ctx.shortcut("Mod+K", async () => {}, { priority: "after-page" });
        off();
        // @ts-expect-error an unknown priority
        ctx.shortcut("Alt+K", () => {}, { priority: "first" });
        return { picked: (tag: string, at: { x: number; y: number }) => tag.length + at.x };
    });
    expectTypeOf(overlay.picked).toEqualTypeOf<(tag: string, at: { x: number; y: number }) => Promise<number>>();

    // handlers returning nothing, a string or an element still compile, and expose nothing
    const none = wt.onPage("*", () => {});
    expectTypeOf(none).toEqualTypeOf<{}>();
    const str = wt.onPage("*", () => "hi");
    expectTypeOf(str).toEqualTypeOf<{}>();
    const el = wt.onPage("*", () => document.body);
    expectTypeOf(el).toEqualTypeOf<{}>();
    // from: "page" fetch options type-check
    void wt.fetch("/api", { from: "page", bypass: true });
}
void typings;

const DTS = readFileSync(new URL("../src/types/wt-api.d.ts", import.meta.url), "utf8");

function errorsOf(snippet: string): string[] {
    const files: Record<string, string> = { "/wt-api.d.ts": DTS, "/snippet.ts": `export {};\n${snippet}` };
    const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], types: [], skipLibCheck: true };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, lang, ...rest) => (name in files ? ts.createSourceFile(name, files[name], lang) : getSourceFile.call(host, name, lang, ...rest));
    host.fileExists = ((exists) => (name: string) => name in files || exists(name))(host.fileExists);
    host.readFile = ((read) => (name: string) => files[name] ?? read(name))(host.readFile);
    const program = ts.createProgram(["/wt-api.d.ts", "/snippet.ts"], options, host);
    return ts.getPreEmitDiagnostics(program, program.getSourceFile("/snippet.ts")).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("onSite / onPage / onOverlay typings", () => {
    it("infers argument and result types both ways", () => {
        expect(
            errorsOf(`
const page = wt.onPage("*", () => ({ count: (sel: string) => 1 }));
const site = wt.onSite("*", () => ({ title: () => document.title }));
wt.onOverlay("*", async () => { const n: number = await page.count("a"); const t: string = await site.title(); return { picked: (t: string) => t }; });
`)
        ).toEqual([]);
    });

    it("a wrong argument, a missing function or a wrong result type fails", () => {
        expect(errorsOf(`const page = wt.onPage("*", () => ({ count: (sel: string) => 1 }));\nvoid page.count(1);`)).toHaveLength(1);
        expect(errorsOf(`const page = wt.onPage("*", () => ({ count: (sel: string) => 1 }));\nvoid page.nope();`)).toHaveLength(1);
        expect(errorsOf(`const page = wt.onPage("*", () => ({ count: (sel: string) => 1 }));\nasync function f() { const s: string = await page.count("a"); }`)).toHaveLength(1);
    });

    it("routes take a pattern or { url, exclude, when }; the removed options don't type-check", () => {
        expect(errorsOf(`wt.onSite({ url: "*", exclude: "*://a/*", when: "document_start" }, () => {});\nwt.onPage(["*://a/*", "*://b/*"], () => {});\nwt.onOverlay({ url: "*", when: "document_idle" }, () => {});`)).toEqual([]);
        expect(errorsOf(`wt.onPage({ url: "*", js: "page" }, () => {});`)).toHaveLength(1);
        expect(errorsOf(`wt.onPage({ url: "*", dom: "overlay" }, () => {});`)).toHaveLength(1);
        expect(errorsOf(`wt.onSite({ url: "*", unsafe: true }, () => {});`)).toHaveLength(1);
        expect(errorsOf(`wt.onPage({ url: "*", when: "later" }, () => {});`)).toHaveLength(1);
        expect(errorsOf(`wt.onPage("*", (ctx) => void ctx.evaluate(() => 1));`)).toHaveLength(1);
    });

    it("handlers returning nothing, a string or an Element still compile", () => {
        expect(errorsOf(`wt.onPage("*", () => {});\nwt.onSite("*", () => "x");\nwt.onPage("*", () => document.body);\nwt.onOverlay("*", async () => {});`)).toEqual([]);
    });

    it("ctx.onNavigate and ctx.shortcut are the overlay's only", () => {
        expect(errorsOf(`wt.onOverlay("*", (ctx) => { const off: () => void = ctx.onNavigate((u: string) => {}); off(); ctx.shortcut("Alt+K", () => {}); });`)).toEqual([]);
        expect(errorsOf(`wt.onPage("*", (ctx) => { ctx.onNavigate(() => {}); });`)).toHaveLength(1);
        expect(errorsOf(`wt.onSite("*", (ctx) => { ctx.shortcut("Alt+K", () => {}); });`)).toHaveLength(1);
    });
});
