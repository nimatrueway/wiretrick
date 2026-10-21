import { describe, it, expect } from "vitest";
import { quickInfoToMarkdown, partsToMarkdown } from "../src/ui/hoverMarkdown";

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
});
