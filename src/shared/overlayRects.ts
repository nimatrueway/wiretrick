/**
 * The overlay frame covers the whole viewport, but only where it draws
 * something may it take clicks: it reports its visible areas (`rects`)
 * and the bridge clips the frame to their union (`clip-path`), so clicks
 * on empty areas reach the page underneath.
 */

/** `[x, y, width, height]` in CSS pixels */
export type Rect = [number, number, number, number];

/** more than this and the frame is clipped to their bounding box */
export const MAX_RECTS = 200;

/** clip to the viewport, round outward, drop empty and duplicate or contained rects; past MAX_RECTS: the bounding box */
export function normalizeRects(rects: Rect[], vw: number, vh: number): Rect[] {
    const seen = new Set<string>();
    let out: Rect[] = [];
    for (const r of rects) {
        if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
        const x0 = Math.max(0, Math.floor(r[0]));
        const y0 = Math.max(0, Math.floor(r[1]));
        const x1 = Math.min(vw, Math.ceil(r[0] + r[2]));
        const y1 = Math.min(vh, Math.ceil(r[1] + r[3]));
        if (x1 <= x0 || y1 <= y0) continue;
        const key = `${x0},${y0},${x1},${y1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([x0, y0, x1 - x0, y1 - y0]);
    }
    if (out.length > MAX_RECTS * 4) return [boundingBox(out)];
    out.sort((a, b) => b[2] * b[3] - a[2] * a[3]);
    out = out.filter((r, i) => !out.slice(0, i).some((o) => contains(o, r)));
    return out.length > MAX_RECTS ? [boundingBox(out)] : out;
}

function contains(o: Rect, r: Rect): boolean {
    return o[0] <= r[0] && o[1] <= r[1] && o[0] + o[2] >= r[0] + r[2] && o[1] + o[3] >= r[1] + r[3];
}

function boundingBox(rects: Rect[]): Rect {
    const x0 = Math.min(...rects.map((r) => r[0]));
    const y0 = Math.min(...rects.map((r) => r[1]));
    const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
    const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
    return [x0, y0, x1 - x0, y1 - y0];
}

/** the `clip-path` showing the union of `rects` (nonzero fill: overlapping rects add up); none: nothing */
export function clipPathFor(rects: Rect[]): string {
    if (!rects.length) return "polygon(0 0, 0 0, 0 0)";
    return `path("${rects.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}z`).join("")}")`;
}

// ---- visible areas ----

const PAINTS_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "SVG", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "IFRAME", "OBJECT", "EMBED", "PROGRESS", "METER", "DIALOG", "LABEL", "A"]);
const MAX_ELEMENTS = 5000;

const transparent = (c: string) => !c || c === "transparent" || /^rgba\(.*,\s*0(?:\.0+)?\)$/.test(c);

/** does the element's own box show (background, border, shadow, a control), beyond its text and children? */
function paints(el: Element, cs: CSSStyleDeclaration): boolean {
    if (PAINTS_TAGS.has(el.tagName.toUpperCase())) return true;
    if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
    if (!transparent(cs.backgroundColor)) return true;
    if (cs.boxShadow && cs.boxShadow !== "none") return true;
    if (cs.cursor === "pointer") return true;
    for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat((cs as any)[`border${side}Width`]) > 0 && !transparent((cs as any)[`border${side}Color`])) return true;
    return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight;
}

/**
 * The boxes of everything visible: painted elements whole, text by its
 * line boxes. Null when there's too much to walk (the whole viewport).
 */
export function collectRects(doc: Document, win: Window): Rect[] | null {
    const out: Rect[] = [];
    let count = 0;
    const range = doc.createRange();
    const add = (r: DOMRect) => {
        if (r.width > 0 && r.height > 0) out.push([r.left, r.top, r.width, r.height]);
    };
    const walk = (el: Element): boolean => {
        if (++count > MAX_ELEMENTS) return false;
        const cs = win.getComputedStyle(el);
        if (cs.display === "none") return true;
        const visible = cs.visibility !== "hidden" && cs.visibility !== "collapse";
        const root = el === doc.documentElement || el === doc.body;
        if (visible && (root ? !transparent(cs.backgroundColor) || cs.backgroundImage !== "none" : paints(el, cs))) {
            // the whole box: its contents are inside (or overflow visibly — measured below)
            add(el.getBoundingClientRect());
        }
        const kids = (el as any).shadowRoot ? [...((el as any).shadowRoot as ShadowRoot).childNodes, ...el.childNodes] : [...el.childNodes];
        for (const n of kids) {
            if (n.nodeType === 1) {
                if (!walk(n as Element)) return false;
            } else if (visible && n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
                range.selectNodeContents(n);
                for (const r of Array.from(range.getClientRects?.() ?? [])) add(r as DOMRect);
            }
        }
        return true;
    };
    if (!doc.documentElement) return [];
    return walk(doc.documentElement) ? out : null;
}

/** call `measure` (debounced) whenever the overlay's layout may have changed */
export function watchRects(doc: Document, win: Window, measure: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // timers, not requestAnimationFrame: a clipped-away frame may not get frames
    const schedule = () => {
        timer ??= setTimeout(() => {
            timer = null;
            measure();
        }, 30);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    const events = ["resize", "scroll", "transitionend", "animationend", "load", "input", "pointerup", "keyup"];
    for (const e of events) win.addEventListener(e, schedule, true);
    // animations and media move things without any event
    const poll = setInterval(measure, 500);
    return () => {
        mo.disconnect();
        for (const e of events) win.removeEventListener(e, schedule, true);
        clearInterval(poll);
        if (timer) clearTimeout(timer);
    };
}
