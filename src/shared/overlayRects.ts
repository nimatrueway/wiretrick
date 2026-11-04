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
