/**
 * Quick-open palette (Cmd/Ctrl+P): a fuzzy-filtered list of all scripts +
 * the ⚙ settings.yaml row. The filter is pure (unit-tested); the palette
 * is dialogs/QuickOpen.tsx.
 */

export interface QuickOpenItem {
    id: string;
    name: string;
}

/**
 * Case-insensitive subsequence ("fuzzy") match. Matching items, best first:
 * earlier first-match position wins, then shorter name, then alphabetical.
 */
export function filterQuickOpen(items: QuickOpenItem[], query: string): QuickOpenItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const scored: { item: QuickOpenItem; score: number }[] = [];
    for (const item of items) {
        const name = item.name.toLowerCase();
        let pos = 0;
        let first = -1;
        for (const ch of q) {
            const i = name.indexOf(ch, pos);
            if (i < 0) {
                first = -1;
                break;
            }
            if (first < 0) first = i;
            pos = i + 1;
        }
        if (first >= 0) scored.push({ item, score: first * 1000 + name.length });
    }
    scored.sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name));
    return scored.map((s) => s.item);
}
