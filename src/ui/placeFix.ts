/**
 * Editor quick fixes for where a handler runs: an onSite handler using a
 * store or a handle (which the site's world can't have) moves to
 * wt.onPage — or the stores it uses become `wt.siteStore`s.
 */
import { closeOf, codeOnly } from "../shared/codeScan";

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

/** `wt.onSite` registrations' `onSite` name, at or before `offset`: the nearest one becomes `onPage` */
export function onPageEdit(code: string, offset: number): TextEdit | null {
    const re = /\bwt\s*\.\s*(onSite)\s*\(/g;
    let at = -1;
    for (let m = re.exec(code); m && m.index < offset; m = re.exec(code)) at = m.index + m[0].indexOf("onSite");
    return at < 0 ? null : { start: at, end: at + "onSite".length, text: "onPage" };
}

/**
 * The nearest `wt.onSite(` handler at or before `offset`: the
 * `wt.pageStore` / `wt.globalStore` it uses — directly, or through the
 * top-level variables bound to them — become `wt.siteStore` (a
 * `wt.globalStore`'s persist option goes: site stores aren't saved).
 * Empty when it uses none.
 */
export function siteStoreEdits(code: string, offset: number): TextEdit[] {
    const src = codeOnly(code);
    const re = /(?<![\w$.])wt\s*\.\s*onSite\s*(?:<[^()]*>\s*)?\(/g;
    let from = -1;
    for (let m = re.exec(src); m && m.index < offset; m = re.exec(src)) from = m.index + m[0].length;
    if (from < 0) return [];
    const to = closeOf(src, from) - 1;
    const args = src.slice(from, to);
    const out: TextEdit[] = [];
    const change = (kindAt: number, kind: string) => {
        out.push({ start: kindAt, end: kindAt + kind.length, text: "siteStore" });
        if (kind === "globalStore") {
            const drop = thirdArg(src, kindAt + kind.length);
            if (drop) out.push(drop);
        }
    };
    for (const d of args.matchAll(/(?<![\w$.])wt\s*\.\s*(pageStore|globalStore)\b/g)) change(from + d.index! + d[0].length - d[1].length, d[1]);
    for (const b of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*wt\s*\.\s*(pageStore|globalStore)\b/g)) {
        if (b.index! >= from && b.index! < to) continue;
        if (!new RegExp(`(?<![\\w$.])${b[1].replace(/\$/g, "\\$")}(?![\\w$]|\\s*:(?!:))`).test(args)) continue;
        change(b.index! + b[0].length - b[2].length, b[2]);
    }
    return out.sort((a, b) => a.start - b.start);
}

/** a `wt.globalStore(name, initial, persist)` call's third argument, from just past `globalStore` */
function thirdArg(src: string, at: number): TextEdit | null {
    const open = /^\s*(?:<[^()]*>\s*)?\(/.exec(src.slice(at));
    if (!open) return null;
    const from = at + open[0].length;
    const close = closeOf(src, from) - 1;
    const commas: number[] = [];
    let depth = 0;
    for (let i = from; i < close; i++) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "," && !depth) commas.push(i);
    }
    if (commas.length < 2 || !src.slice(commas[1] + 1, close).trim()) return null;
    return { start: commas[1], end: close, text: "" };
}
