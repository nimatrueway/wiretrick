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

    it("renders a larger icon in the tooltip when data-tt-icon is set, with or without title text", async () => {
        document.body.innerHTML = `
            <span id="with-desc" title="Atlas bundle" data-tt-icon="data:image/png;base64,AAAA">Redwood</span>
            <span id="icon-only" data-tt-icon="data:image/png;base64,BBBB">Logo</span>
            <p id="away">x</p>
        `;
        installTooltips();
        const withDesc = document.getElementById("with-desc")!;
        const iconOnly = document.getElementById("icon-only")!;

        over(withDesc);
        await new Promise((r) => setTimeout(r, 450));
        const tip = document.querySelector<HTMLElement>(".tt-tip")!;
        expect(tip.hidden).toBe(false);
        expect(tip.classList.contains("has-icon")).toBe(true);
        expect(tip.classList.contains("icon-only")).toBe(false);
        expect(tip.querySelector<HTMLImageElement>("img.tt-tip-icon")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
        expect(tip.textContent).toBe("Atlas bundle");

        over(iconOnly);
        await new Promise((r) => setTimeout(r, 250));
        expect(tip.hidden).toBe(false);
        expect(tip.classList.contains("icon-only")).toBe(true);
        expect(tip.querySelector<HTMLImageElement>("img.tt-tip-icon")?.getAttribute("src")).toBe("data:image/png;base64,BBBB");
        expect(tip.textContent).toBe("");

        over(document.getElementById("away")!);
        await new Promise((r) => setTimeout(r, 220));
        expect(tip.hidden).toBe(true);
        expect(withDesc.getAttribute("title")).toBe("Atlas bundle");
        expect(iconOnly.hasAttribute("title")).toBe(false);
    });
});
