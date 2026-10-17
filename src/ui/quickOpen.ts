/**
 * Quick-open palette (Cmd/Ctrl+P): a fuzzy-filtered list of all scripts +
 * the ⚙ settings.yaml row. The filter is pure (unit-tested); the palette
 * wires into the manager's select() flow.
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

export interface QuickOpenPalette {
    open(): void;
    close(): void;
    toggle(): void;
    isOpen(): boolean;
}

/** Wire the palette DOM: input filters, ↑/↓ move, Enter selects, Esc closes. */
export function createQuickOpenPalette(
    root: HTMLElement,
    input: HTMLInputElement,
    list: HTMLElement,
    getItems: () => QuickOpenItem[],
    onSelect: (id: string) => void
): QuickOpenPalette {
    let shown: QuickOpenItem[] = [];
    let active = 0;

    const isOpen = (): boolean => !root.classList.contains("hidden");

    function setActive(i: number): void {
        active = i;
        for (const [j, li] of Array.from(list.children).entries()) li.classList.toggle("active", j === active);
    }

    function render(): void {
        shown = filterQuickOpen(getItems(), input.value);
        list.innerHTML = "";
        for (let i = 0; i < shown.length; i++) {
            const li = document.createElement("li");
            li.className = "qo-item" + (i === active ? " active" : "");
            li.textContent = shown[i].name;
            li.dataset.id = shown[i].id;
            li.addEventListener("click", () => pick(i));
            li.addEventListener("mousemove", () => setActive(i));
            list.appendChild(li);
        }
    }

    function pick(i: number): void {
        const item = shown[i];
        close();
        if (item) onSelect(item.id);
    }

    function open(): void {
        root.classList.remove("hidden");
        input.value = "";
        render();
        input.focus();
    }

    function close(): void {
        root.classList.add("hidden");
    }

    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(active + 1, shown.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(active - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            pick(active);
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    });

    return { open, close, toggle: () => (isOpen() ? close() : open()), isOpen };
}
