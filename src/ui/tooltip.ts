/**
 * Custom tooltips for every element with a `title`, installed once per page
 * by event delegation. Unlike native tooltips they stay up while the pointer
 * is on the anchor or on the tooltip itself (so it can be reached, read and
 * selected), and a click on one copies its text. Clicks on Monaco hovers
 * (error markers, hover docs) copy their text the same way.
 *
 * While an anchor is hovered its `title` is parked in `data-wt-title` (that
 * suppresses the native tooltip) and put back when the pointer leaves, so
 * code reading `title` afterwards sees the usual value. Title changes made
 * while it's parked (`el.title = …`) are picked up and shown live.
 */
import { copyWithToast } from "./toast";

const SHOW_DELAY = 400;
/** another tooltip shown this recently → show the next one at once */
const WARM_MS = 600;
/** time to cross the gap between the anchor and the tooltip */
const GRACE_MS = 180;
const GAP = 4;
const MARGIN = 6;
const PARKED = "data-wt-title";

let installed = false;

export function installTooltips(): void {
    if (installed) return;
    installed = true;

    const tip = document.createElement("div");
    tip.className = "wt-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;

    let anchor: HTMLElement | null = null;
    let text = "";
    let visible = false;
    let dismissed: HTMLElement | null = null; // clicked/escaped: no tooltip until the pointer leaves it
    let lastHidden = 0;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    const mouse = { x: 0, y: 0 };

    const observer = new MutationObserver(() => {
        if (!anchor || !anchor.hasAttribute("title")) return;
        const t = anchor.getAttribute("title")!;
        if (!t) {
            text = "";
            release();
            return;
        }
        anchor.removeAttribute("title");
        anchor.setAttribute(PARKED, t);
        text = t;
        if (visible) render();
    });

    const cancelHide = (): void => {
        clearTimeout(hideTimer);
        hideTimer = undefined;
    };

    /** stop tracking the anchor: hide the tooltip, give the anchor its title back */
    function release(): void {
        clearTimeout(showTimer);
        cancelHide();
        clearInterval(watch);
        observer.disconnect();
        if (visible) lastHidden = Date.now();
        visible = false;
        tip.hidden = true;
        if (anchor) {
            anchor.removeAttribute(PARKED);
            if (!anchor.hasAttribute("title")) anchor.setAttribute("title", text);
        }
        anchor = null;
    }

    function track(el: HTMLElement, show: boolean): void {
        release();
        anchor = el;
        text = el.getAttribute("title") || "";
        el.removeAttribute("title");
        el.setAttribute(PARKED, text);
        observer.observe(el, { attributes: true, attributeFilter: ["title"] });
        // the anchor going away or hidden (re-render, dialog closed) takes the tooltip with it
        watch = setInterval(() => {
            if (anchor && (!anchor.isConnected || anchor.getClientRects().length === 0)) release();
        }, 250);
        if (show) showTimer = setTimeout(reveal, Date.now() - lastHidden < WARM_MS ? 0 : SHOW_DELAY);
    }

    function reveal(): void {
        if (!anchor || !text) return;
        if (!tip.isConnected) document.body.append(tip);
        visible = true;
        render();
    }

    function render(): void {
        if (!anchor) return;
        tip.textContent = text;
        tip.hidden = false;
        tip.style.left = "0px";
        tip.style.top = "0px";
        const r = anchor.getBoundingClientRect();
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        // big anchors (rows, panels): follow the pointer rather than the box
        const tall = r.height > 48;
        const below = tall ? mouse.y + 18 : r.bottom + GAP;
        const above = tall ? mouse.y - 10 - h : r.top - GAP - h;
        let top = below + h <= vh - MARGIN ? below : above >= MARGIN ? above : vh - below > r.top ? below : above;
        top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
        // just right of the pointer, like native tooltips: moving straight
        // down to the next row passes beside the tooltip instead of into it
        let left = mouse.x + 12;
        left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
    }

    const scheduleHide = (): void => {
        if (anchor && !hideTimer) hideTimer = setTimeout(release, visible ? GRACE_MS : 0);
    };

    function titledFrom(target: Element): HTMLElement | null {
        const t = target.closest<HTMLElement>("[title]");
        // inside the tracked anchor, unless a titled descendant of it is nearer
        if (anchor && anchor.contains(target) && (!t || t.contains(anchor))) return anchor;
        if (!t || !t.getAttribute("title") || t.closest(".monaco-hover")) return null;
        return t;
    }

    function onPoint(e: PointerEvent): void {
        if (e.pointerType === "touch") return;
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        const target = e.target as Element | null;
        if (!target || !(target instanceof Element)) return;
        if (tip.contains(target)) {
            cancelHide();
            return;
        }
        const el = titledFrom(target);
        if (el && el === anchor) {
            cancelHide();
            return;
        }
        if (!el) {
            dismissed = null;
            scheduleHide();
            return;
        }
        if (el !== dismissed) dismissed = null;
        track(el, !dismissed);
    }

    document.addEventListener("pointerover", onPoint, true);
    document.addEventListener("pointermove", onPoint, true);
    document.addEventListener(
        "pointerout",
        (e) => {
            if (!e.relatedTarget) scheduleHide(); // left the window
        },
        true
    );
    window.addEventListener("blur", release);
    document.addEventListener(
        "mousedown",
        (e) => {
            if (!anchor || tip.contains(e.target as Node)) return;
            const a = anchor;
            release();
            if (a.contains(e.target as Node)) dismissed = a;
        },
        true
    );
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape" && visible && anchor) {
                const a = anchor;
                release();
                dismissed = a;
            }
        },
        true
    );
    document.addEventListener(
        "scroll",
        (e) => {
            // only scrolling that moves the anchor (not, say, the log panel streaming)
            if (anchor && (e.target === document || (e.target instanceof Node && e.target.contains(anchor)))) release();
        },
        true
    );
    window.addEventListener("resize", release);

    let focusBefore: Element | null = null;
    tip.addEventListener("mousedown", () => (focusBefore = document.activeElement));
    tip.addEventListener("click", () => {
        if (hasSelectionIn(tip)) return; // the user selected text in it
        if (focusBefore instanceof HTMLElement && focusBefore !== document.body && document.activeElement === document.body) focusBefore.focus({ preventScroll: true });
        void copyWithToast(text);
    });

    document.addEventListener("click", onMonacoHoverClick, true);
}

function hasSelectionIn(el: Element): boolean {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.getRangeAt(0).intersectsNode(el);
}

const INTERACTIVE = 'a, button, input, textarea, select, [role="button"], .verbosity-actions, .status-bar';

function onMonacoHoverClick(e: MouseEvent): void {
    const target = e.target as Element | null;
    const hover = target?.closest?.(".monaco-hover");
    if (!target || !hover || e.button !== 0) return;
    const hit = target.closest(INTERACTIVE);
    if (hit && hover.contains(hit)) return; // type links, commands, Quick Fix: keep their behavior
    if (hasSelectionIn(hover)) return;
    const text = monacoHoverText(hover);
    if (text) void copyWithToast(text);
}

/** a Monaco hover's text, minus its action bar (Quick Fix, View Problem) */
export function monacoHoverText(hover: Element): string {
    const content = hover.querySelector(".monaco-hover-content") ?? hover;
    return Array.from(content.children)
        .filter((c) => !c.classList.contains("status-bar"))
        .map((c) => (c as HTMLElement).innerText.trim())
        .filter(Boolean)
        .join("\n\n");
}
