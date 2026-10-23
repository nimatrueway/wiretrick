import { describe, it, expect } from "vitest";
import { quickInfoToMarkdown, partsToMarkdown, formatSignature, docsToMarkdown, mapToFormatted, signatureHtml } from "../src/ui/hoverMarkdown";

const t = (text: string, kind = "text") => ({ text, kind });

describe("hover markdown", () => {
    it("fences the signature and keeps documentation markdown as-is", () => {
        const md = quickInfoToMarkdown({
            displayParts: [t("(method) "), t("onDom", "methodName"), t("(): void")],
            documentation: [t("Line one\n\n- a\n- b")],
        });
        expect(md).toEqual(["```typescript\n(method) onDom(): void\n```", "Line one\n\n- a\n- b"]);
    });

    it("renders @example as a code block, keeping existing fences and captions", () => {
        const [, body] = quickInfoToMarkdown({
            displayParts: [t("x")],
            tags: [
                { name: "example", text: [t("wt.log(1);\nwt.log(2);")] },
                { name: "example", text: [t("```js\nfoo()\n```")] },
                { name: "example", text: [t("<caption>Cap</caption>\nbar()")] },
            ],
        });
        expect(body).toBe(
            "*@example*  \n```typescript\nwt.log(1);\nwt.log(2);\n```\n\n" +
                "*@example*  \n```js\nfoo()\n```\n\n" +
                "*@example*  \nCap\n```typescript\nbar()\n```"
        );
    });

    it("renders @param as `name` — text and separates tags with blank lines", () => {
        const [, body] = quickInfoToMarkdown({
            displayParts: [t("x")],
            documentation: [t("Doc.")],
            tags: [
                { name: "param", text: [t("handler", "parameterName"), t(" ", "space"), t("The handler.")] },
                { name: "param", text: [t("opts", "parameterName")] },
                { name: "deprecated", text: [t("use x")] },
            ],
        });
        expect(body).toBe("Doc.\n\n*@param* `handler` — The handler.\n\n*@param* `opts`\n\n*@deprecated* — use x");
    });

    it("renders {@link} as code (or its label) and restores the swallowed space", () => {
        expect(partsToMarkdown([t("See "), t("{@link ", "link"), t("A.b", "linkName"), t("}", "link"), t("for more")])).toBe(
            "See `A.b` for more"
        );
        expect(partsToMarkdown([t("{@link ", "link"), t("A", "linkName"), t("the A", "linkText"), t("}", "link"), t(".")])).toBe("the A.");
    });

    it("wraps long signatures: one parameter per line, long unions one member per line", () => {
        expect(formatSignature("(method) onDom(): void")).toBe("(method) onDom(): void");
        expect(formatSignature("(method) f<T extends Record<string, X>>(def: Wiretrick.ScriptDef<T>, opts?: { a: (x: number) => void; b: string }): R<T>", 40)).toBe(
            "(method) f<T extends Record<string, X>>(\n    def: Wiretrick.ScriptDef<T>,\n    opts?: { a: (x: number) => void; b: string }\n): R<T>"
        );
        expect(formatSignature('(property) A.when?: "document_idle" | "DOMContentLoaded" | "a, b" | "document_end"', 40)).toBe(
            '(property) A.when?:\n    | "document_idle"\n    | "DOMContentLoaded"\n    | "a, b"\n    | "document_end"'
        );
    });

    it("docsToMarkdown can skip @param (signature help shows them per parameter)", () => {
        expect(docsToMarkdown([t("Doc.")], [{ name: "param", text: [t("x", "parameterName")] }, { name: "example", text: "f()" }], (tag) => tag.name === "param")).toBe(
            "Doc.\n\n*@example*  \n```typescript\nf()\n```"
        );
    });
});

describe("signature html", () => {
    it("maps offsets into the wrapped signature", () => {
        const raw = "(method) onRequest(route: Wiretrick.Route, handler: (ctx: Wiretrick.RequestCtx) => void, extra: Wiretrick.Route): void";
        const wrapped = formatSignature(raw);
        expect(wrapped).toContain("\n    route: Wiretrick.Route,\n");
        for (const name of ["Route", "RequestCtx"]) {
            const at = raw.indexOf(name);
            const [s, e] = mapToFormatted(raw, wrapped, at, at + name.length);
            expect(wrapped.slice(s, e)).toBe(name);
        }
        const last = raw.lastIndexOf("Route");
        const [s, e] = mapToFormatted(raw, wrapped, last, last + 5);
        expect([wrapped.slice(s, e), s]).toEqual(["Route", wrapped.lastIndexOf("Route")]);
    });

    it("keeps token colors and wraps links around their tokens, escaping text", () => {
        const html = signatureHtml(
            [
                { text: "x", color: "#001080" },
                { text: ": ", color: "#000000" },
                { text: "Wiretrick.Route", color: "#267f99" },
                { text: " | " },
                { text: "Map<a, b>", color: "#267f99" },
            ],
            [
                { start: 13, end: 18, href: "command:go?1", title: 'W.R "x"' },
                { start: 21, end: 24, href: "command:go?2" },
            ]
        );
        expect(html).toBe(
            '<pre><span style="color:#001080;">x</span><span style="color:#000000;">: </span>' +
                '<span style="color:#267f99;">Wiretrick.</span><a href="command:go?1" title="W.R &quot;x&quot;"><span style="color:#267f99;">Route</span></a> | ' +
                '<a href="command:go?2"><span style="color:#267f99;">Map</span></a><span style="color:#267f99;">&lt;a, b&gt;</span></pre>'
        );
    });

    it("lets a link span several tokens and renders uncolored text plainly", () => {
        expect(signatureHtml([{ text: "a" }, { text: "b", color: "#111111" }, { text: "c" }], [{ start: 0, end: 2, href: "h" }])).toBe(
            '<pre><a href="h">a<span style="color:#111111;">b</span></a>c</pre>'
        );
        expect(signatureHtml([{ text: "a\nb" }])).toBe("<pre>a\nb</pre>");
    });
});
