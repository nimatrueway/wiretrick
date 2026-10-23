import { describe, it, expect } from "vitest";
import { installTooltips } from "../src/ui/tooltip";

const over = (el: Element) => el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));

describe("tooltips", () => {
    it("park titled ancestors while a nested title is shown, so no native tooltip stacks on ours", async () => {
        document.body.innerHTML = `<div id="header" title="Drag to dock"><span id="tools"><button id="b" title="Clear">clear</button></span></div><p id="out">x</p>`;
        installTooltips();
        const header = document.getElementById("header")!;
        const b = document.getElementById("b")!;
        over(b);
        expect(b.hasAttribute("title")).toBe(false);
        expect(header.hasAttribute("title")).toBe(false);
        over(document.getElementById("out")!);
        await new Promise((r) => setTimeout(r, 20));
        expect(b.getAttribute("title")).toBe("Clear");
        expect(header.getAttribute("title")).toBe("Drag to dock");
    });
});
