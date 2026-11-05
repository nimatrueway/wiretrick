/** a line diff for reviewing an update (LCS; null when the files are too big to diff) */
export interface DiffLine {
    op: " " | "+" | "-";
    text: string;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] | null {
    const a = before.split("\n");
    const b = after.split("\n");
    // the common head and tail cost nothing
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const x = a.slice(head, a.length - tail);
    const y = b.slice(head, b.length - tail);
    const n = x.length;
    const m = y.length;
    if ((n + 1) * (m + 1) > MAX_CELLS) return null;
    // lcs[i][j]: of x[i..] and y[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: " ", text }));
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && x[i] === y[j]) {
            out.push({ op: " ", text: x[i] });
            i++;
            j++;
        } else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) out.push({ op: "-", text: x[i++] });
        else out.push({ op: "+", text: y[j++] });
    }
    for (const text of a.slice(a.length - tail)) out.push({ op: " ", text });
    return out;
}

/** the changed lines with `context` unchanged lines around them; a gap is a `null` */
export function diffHunks(lines: DiffLine[], context = 3): (DiffLine | null)[] {
    const keep = new Array(lines.length).fill(false);
    lines.forEach((l, k) => {
        if (l.op === " ") return;
        for (let d = Math.max(0, k - context); d <= Math.min(lines.length - 1, k + context); d++) keep[d] = true;
    });
    const out: (DiffLine | null)[] = [];
    lines.forEach((l, k) => {
        if (keep[k]) out.push(l);
        else if (out.length && out[out.length - 1] !== null) out.push(null);
    });
    if (out.length && out[out.length - 1] === null) out.pop();
    return out;
}
