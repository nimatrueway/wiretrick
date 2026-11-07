/**
 * Editor quick fix for where a handler runs: an onSite handler using a
 * store or a handle (which the site's world can't have) moves to wt.onPage.
 */

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
