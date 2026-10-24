/**
 * Network filter bar: one query, two editors. Basic builds it from a text
 * box and chips ("+ Filter": field → operator → value); Advanced edits the
 * query directly with autocomplete, error underlines and a "?" syntax help.
 */
import { Fragment, type JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import {
    FIELDS,
    addChip,
    backspaceStructure,
    commitTyped,
    openPath,
    typeStructure,
    basicSuggest,
    chipToString,
    editItem,
    emptyBasic,
    leafChips,
    removeChips,
    toggleConn,
    complete,
    fieldValues,
    fromBasic,
    parseQuery,
    quoteValue,
    toBasic,
    type BasicExpr,
    type BasicFilter,
    type BasicSuggestion,
    type Chip,
    type Completion,
    type FieldDef,
    type FieldKind,
    type QueryError,
    type SuggestData,
    basicStops,
    chipsBefore,
    closeGap,
    commitGap,
    insertAtGap,
    isGap,
    leafPath,
    type BasicStop,
} from "./netQuery";

export type FilterMode = "basic" | "advanced";
export interface FilterState {
    mode: FilterMode;
    basic: BasicFilter;
    query: string;
}

const MODE_KEY = "wt.network.filterMode";
export function initialFilterState(): FilterState {
    let mode: FilterMode = "basic";
    try {
        if (localStorage.getItem(MODE_KEY) === "advanced") mode = "advanced";
    } catch {}
    // by default only what scripts touched — a chip, so removing it shows everything
    const query = "is:touched";
    return { mode, basic: toBasic(parseQuery(query).ast), query };
}
export function effectiveQuery(s: FilterState): string {
    return s.mode === "basic" ? fromBasic(s.basic) : s.query;
}

/** Close a popup on outside mousedown or Escape. */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void, escape: () => void = close) {
    useEffect(() => {
        if (!open) return;
        const onDown = (ev: MouseEvent) => {
            if (!ref.current?.contains(ev.target as Node)) close();
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === "Escape") {
                ev.stopPropagation();
                escape();
            }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [open]);
}

/** Keep an open popup inside the window: cap its height, flip it above its anchor when there's more room there. */
function useFit(ref: RefObject<HTMLElement | null>, open: boolean, cap = Infinity) {
    useLayoutEffect(() => {
        const el = ref.current;
        if (!open || !el) return;
        el.style.top = el.style.bottom = el.style.maxHeight = "";
        const anchor = el.parentElement!.getBoundingClientRect();
        const below = Math.min(cap, innerHeight - anchor.bottom - 8);
        const above = Math.min(cap, anchor.top - 8);
        if (el.getBoundingClientRect().height > below && above > below) {
            el.style.top = "auto";
            el.style.bottom = "calc(100% + 4px)";
            el.style.maxHeight = `${above}px`;
        } else el.style.maxHeight = `${below}px`;
        el.style.overflow = "auto";
    });
}

export function FilterBar({ state, onChange, error, data }: { state: FilterState; onChange: (s: FilterState) => void; error: QueryError | null; data: SuggestData }) {
    const [warn, setWarn] = useState(false);
    const setMode = (mode: FilterMode) => {
        if (mode === state.mode) return;
        try {
            localStorage.setItem(MODE_KEY, mode);
        } catch {}
        if (mode === "advanced") return onChange({ ...state, mode, query: fromBasic(state.basic) });
        const parsed = parseQuery(state.query);
        if (parsed.error) return setWarn(true);
        onChange({ ...state, mode, basic: toBasic(parsed.ast) });
    };
    const warnRef = useRef<HTMLDivElement>(null);
    useDismiss(warnRef, warn, () => setWarn(false));
    const advanced = state.mode === "advanced";
    return (
        <div class="net-qbar">
            <div class="net-qmode" role="group" aria-label="Filter mode" ref={warnRef}>
                <button aria-pressed={!advanced} class={advanced ? "" : "on"} title="Build the filter with chips" onClick={() => setMode("basic")}>
                    Basic
                </button>
                <button aria-pressed={advanced} class={advanced ? "on" : ""} title="Type a query: field:value, OR, NOT, ( )" onClick={() => setMode("advanced")}>
                    Advanced
                </button>
                {warn && (
                    <div class="net-pop net-qwarn" role="alertdialog" aria-label="Query has an error">
                        <p>This query has an error, so Basic can't show it.</p>
                        <div class="net-pop-actions">
                            <button class="primary" onClick={() => setWarn(false)}>
                                Stay in Advanced
                            </button>
                            <button
                                onClick={() => {
                                    setWarn(false);
                                    onChange({ ...state, mode: "basic", basic: emptyBasic() });
                                }}
                            >
                                Clear and switch
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {advanced ? (
                <QueryInput value={state.query} onInput={(query) => onChange({ ...state, query })} error={error} data={data} />
            ) : (
                <BasicInput value={state.basic} onInput={(basic) => onChange({ ...state, basic })} error={error} data={data} />
            )}
            <SyntaxHelp onPick={(query) => (setWarn(false), onChange({ ...state, mode: "advanced", query }))} />
        </div>
    );
}

// ── Basic ────────────────────────────────────────────────────────────

const unquote = (raw: string) => (/^".*"$/.test(raw) ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw);
/** "+ Filter" opened from a typed suggestion, at this field */
interface AddRequest {
    field: FieldDef;
    negate: boolean;
    value: string;
}
/** text-like selection over the chips (indices into leafChips); `withText` = Ctrl+A also took the text box */
type Sel = { anchor: number; focus: number; withText?: boolean };

/** what a highlighted suggestion puts in the text box: query text, not its display label */
const suggestionText = (s: BasicSuggestion) => (s.kind === "chip" ? chipToString(s.chip) : s.label);

/** typing within this long after the last keystroke joins the same undo step */
const TYPING_JOIN_MS = 1000;
const UNDO_DEPTH = 100;

/**
 * Undo/redo over the Basic filter: chips aren't text, so the input's native
 * undo can't bring them back. Every change is a step, wherever it came from
 * (Clear included); consecutive typing joins one step.
 */
function useBasicUndo(value: BasicFilter, onInput: (b: BasicFilter) => void) {
    // where the caret sits isn't a change
    const keyOf = (b: BasicFilter) => JSON.stringify(b.at && !b.at.text && !b.at.edit ? { ...b, at: undefined } : b);
    const h = useRef({ past: [] as BasicFilter[], future: [] as BasicFilter[], cur: value, key: keyOf(value), typedAt: 0, typing: false, nav: false }).current;
    const key = keyOf(value);
    if (key !== h.key) {
        const now = Date.now();
        if (!h.nav) {
            if (!(h.typing && now - h.typedAt < TYPING_JOIN_MS)) h.past = [...h.past, h.cur].slice(-UNDO_DEPTH);
            h.future = [];
        }
        h.typedAt = h.typing && !h.nav ? now : 0;
        h.nav = false;
        h.key = key;
    }
    h.cur = value;
    h.typing = false;
    const go = (from: BasicFilter[], to: BasicFilter[]) => {
        const v = from.pop();
        if (!v) return null;
        to.push(h.cur);
        h.nav = true;
        onInput(v);
        return v;
    };
    return {
        /** the next change is a keystroke in the text box */
        typed: () => void (h.typing = true),
        undo: () => go(h.past, h.future),
        redo: () => go(h.future, h.past),
    };
}

function BasicInput({ value, onInput, error, data }: { value: BasicFilter; onInput: (b: BasicFilter) => void; error: QueryError | null; data: SuggestData }) {
    const box = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const dragging = useRef(false);
    /** the text box selection to set after the render (the box may have moved) */
    const pendingCaret = useRef<[number, number] | null>(null);
    const [sel, setSel] = useState<Sel | null>(null);
    /** `kb`: the highlight came from ↑/↓, so the text box shows it (hover doesn't) */
    const [ac, setAc] = useState<{ from: number; to: number; items: BasicSuggestion[]; active: number; kb?: boolean } | null>(null);
    const [request, setRequest] = useState<AddRequest | null>(null);
    useFit(listRef, !!ac, 260);
    const history = useBasicUndo(value, onInput);
    useLayoutEffect(() => {
        if (pendingCaret.current === null || !input.current) return;
        input.current.focus();
        input.current.setSelectionRange(...pendingCaret.current);
        pendingCaret.current = null;
    });
    useEffect(() => {
        const up = () => (dragging.current = false);
        document.addEventListener("mouseup", up);
        return () => document.removeEventListener("mouseup", up);
    }, []);
    useEffect(() => {
        document.getElementById(`net-bopt-${ac?.active}`)?.scrollIntoView?.({ block: "nearest" });
    }, [ac?.active]);

    const leaves = leafChips(value.expr);
    /** the text box among the chips (null: at the end) */
    const gap = value.at ?? null;
    /** what the text box holds, wherever it is */
    const cur = gap ? gap.text : value.text;
    const withText = (text: string): BasicFilter => (gap ? { ...value, at: { ...gap, text } } : { ...value, text });
    const previewItem = ac?.kb && ac.active >= 0 ? ac.items[ac.active] : null;
    const shown = previewItem ? cur.slice(0, ac!.from) + suggestionText(previewItem) + cur.slice(ac!.to) : cur;
    const lo = sel ? Math.min(sel.anchor, sel.focus) : -1;
    const hi = sel ? Math.max(sel.anchor, sel.focus) : -2;
    const setExpr = (expr: BasicExpr) => onInput({ ...value, expr });
    const toInput = (caret: number) => {
        setSel(null);
        pendingCaret.current = [caret, caret];
        input.current?.focus();
        input.current?.setSelectionRange(caret, caret);
    };
    const selectChips = (anchor: number, focus: number) => {
        setAc(null);
        setSel({ anchor, focus });
        box.current?.focus();
    };
    /** the text box back at the end: what was typed among the chips becomes chips there; `map` follows a chip index across that */
    const settle = (): { base: BasicFilter; map: (i: number) => number } => {
        if (!gap) return { base: value, map: (i) => i };
        const c = commitGap(value);
        if (!c) return { base: closeGap(value), map: (i) => i };
        const before = chipsBefore(value.expr, gap.path, gap.index);
        const d = leafChips(c.expr).length - leaves.length;
        return { base: { ...c, at: undefined }, map: (i) => (i < before ? i : i + d) };
    };
    /** put the caret at a stop: select a chip, or the text box in a gap / at the end */
    const goStop = (s: BasicStop | undefined, base: BasicFilter, caretAtEnd = false) => {
        if (!s) return;
        setAc(null);
        if (s.k === "chip") {
            if (base !== value || value.at) onInput({ ...base, at: undefined });
            return selectChips(s.leaf, s.leaf);
        }
        onInput({ ...base, at: s.k === "gap" ? { path: s.path, index: s.index, text: "" } : undefined });
        toInput(s.k === "end" && caretAtEnd ? base.text.length : 0);
    };
    /** ←/→ out of the gap: what was typed there becomes chips first (stays put while it doesn't parse) */
    const leaveGap = (dir: -1 | 1) => {
        const g = gap!;
        const c = commitGap(value);
        if (!c) return;
        const st = basicStops(c.expr);
        if (c.at) return goStop(st[st.findIndex((x) => isGap(x, g.path, dir < 0 ? g.index : c.at!.index)) + dir], c);
        // the edited chip was emptied away
        const before = chipsBefore(value.expr, g.path, g.index);
        const n = leafChips(c.expr).length;
        goStop(dir < 0 ? (before ? { k: "chip", leaf: before - 1 } : st[0]) : before < n ? { k: "chip", leaf: before } : { k: "end" }, c);
    };
    /** Enter / Space / double-click on a chip: it turns back into text, in place */
    const editChip = (leaf: number) => {
        const path = leafPath(value.expr, leaf);
        if (!path) return;
        const text = chipToString(leaves[leaf]);
        setAc(null);
        onInput({ ...value, at: { path: path.slice(0, -1), index: path[path.length - 1], edit: true, text } });
        toInput(text.length);
    };
    const selectAll = () => {
        const { base } = settle();
        if (base !== value) onInput(base);
        setAc(null);
        setSel({ anchor: 0, focus: leafChips(base.expr).length - 1, withText: true });
        pendingCaret.current = [0, base.text.length];
        input.current?.focus();
        input.current?.select();
    };
    /** chips lo..hi removed; the caret goes where they were. `typed` (a printed key) replaces them, as in a text box; `all`: the end text too */
    const removeLeaves = (base: BasicFilter, lo: number, hi: number, typed = "", all = false, keepLeft = false) => {
        const expr = removeChips(base.expr, new Set(leafChips(base.expr).slice(lo, hi + 1)), true, keepLeft);
        const st = basicStops(expr);
        const before = all ? undefined : st[st.findIndex((x) => x.k === "chip" && x.leaf === lo) - 1];
        const next: BasicFilter =
            before?.k === "gap" ? { ...base, expr, at: { path: before.path, index: before.index, text: typed } } : { ...base, expr, at: undefined, text: typed + (all ? "" : base.text) };
        onInput(next);
        toInput(typed.length);
        if (typed) suggest(next.at ? typed : next.text, typed.length);
    };
    const replaceSel = (typed = "") => removeLeaves(value, lo, hi, typed, !!sel?.withText);
    const selectedQuery = () => (sel?.withText ? fromBasic(value) : leaves.slice(lo, hi + 1).map(chipToString).join(" "));

    const suggest = (text: string, caret: number) => {
        let from = caret;
        while (from > 0 && !/\s/.test(text[from - 1])) from--;
        let to = caret;
        while (to < text.length && !/\s/.test(text[to])) to++;
        const items = basicSuggest(text.slice(from, to), data);
        setAc(items.length ? { from, to, items, active: -1 } : null);
    };
    const accept = (i: number) => {
        if (!ac) return;
        const item = ac.items[i];
        const text = (cur.slice(0, ac.from) + cur.slice(ac.to)).replace(/\s+/g, " ").trim();
        setAc(null);
        if (item.kind === "chip") {
            const one: BasicExpr = { items: [{ k: "chip", chip: item.chip }], conns: [] };
            return (onInput(gap ? insertAtGap(withText(text), one) : addChip({ ...value, text }, item.chip)), toInput(text.length));
        }
        onInput(withText(text));
        setRequest({ field: item.field, negate: item.negate, value: item.value });
    };
    /** Enter with nothing picked: what the text box holds besides plain words becomes chips (among the chips: all of it) */
    const chipify = () => {
        if (gap) {
            const c = commitGap(value);
            if (c) (onInput(c), toInput(c.at ? 0 : c.text.length));
            return;
        }
        const next = commitTyped(value);
        if (next) (onInput(next), toInput(next.text.length));
    };

    const onChipKey = (ev: KeyboardEvent) => {
        const n = leaves.length;
        const mod = ev.ctrlKey || ev.metaKey;
        const key = ev.key;
        if (!ev.shiftKey && (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End")) {
            // the caret stops on either side of each chip
            ev.preventDefault();
            const st = basicStops(value.expr);
            if (key === "Home") return goStop(st[0], value);
            if (key === "End") return goStop({ k: "end" }, value, true);
            const left = key === "ArrowLeft";
            return goStop(st[st.findIndex((x) => x.k === "chip" && x.leaf === (left ? lo : hi)) + (left ? -1 : 1)], value);
        } else if ((key === "Enter" || key === " ") && lo === hi && !sel!.withText && !mod) {
            ev.preventDefault();
            editChip(lo);
        } else if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
            ev.preventDefault();
            const to = key === "Home" ? 0 : key === "End" ? n : key === "ArrowLeft" ? (ev.shiftKey ? sel!.focus - 1 : lo - 1) : ev.shiftKey ? sel!.focus + 1 : hi + 1;
            if (ev.shiftKey) return selectChips(sel!.withText ? n - 1 : sel!.anchor, Math.max(0, Math.min(n - 1, to)));
            if (to >= n) return toInput(key === "End" ? value.text.length : 0);
            selectChips(Math.max(0, to), Math.max(0, to));
        } else if (key === "Backspace" || key === "Delete") {
            ev.preventDefault();
            replaceSel();
        } else if (mod && key.toLowerCase() === "a") {
            ev.preventDefault();
            selectAll();
        } else if (mod && (key.toLowerCase() === "c" || key.toLowerCase() === "x")) {
            ev.preventDefault();
            void navigator.clipboard?.writeText(selectedQuery()).catch(() => {});
            if (key.toLowerCase() === "x") replaceSel();
        } else if (key === "Escape") {
            ev.stopPropagation();
            toInput(0);
        } else if (key.length === 1 && !mod && !ev.altKey) {
            ev.preventDefault();
            replaceSel(key);
        }
    };
    const onInputKey = (ev: KeyboardEvent) => {
        const el = input.current!;
        const n = leaves.length;
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
        const mod = ev.ctrlKey || ev.metaKey;
        const plain = !mod && !ev.shiftKey && !ev.altKey;
        if (gap && plain) {
            const key = ev.key;
            if ((key === "ArrowLeft" && atStart) || (key === "ArrowRight" && atEnd)) return (ev.preventDefault(), leaveGap(key === "ArrowLeft" ? -1 : 1));
            if ((key === "Home" && atStart) || (key === "End" && atEnd)) {
                ev.preventDefault();
                const { base } = settle();
                return goStop(key === "Home" ? basicStops(base.expr)[0] : { k: "end" }, base, true);
            }
            if (!el.value && !gap.edit && ((key === "Backspace" && atStart) || (key === "Delete" && atEnd))) {
                // like a character: the chip before / after the caret goes, with the connector between them
                ev.preventDefault();
                const leaf = chipsBefore(value.expr, gap.path, gap.index) - (key === "Backspace" ? 1 : 0);
                if (leaf >= 0 && leaf < n) removeLeaves({ ...value, at: undefined }, leaf, leaf, "", false, true);
                return;
            }
            if (key === "Escape" && !ac) {
                // an edit is dropped; anything else typed here is kept
                ev.stopPropagation();
                const base = gap.edit ? { ...value, at: undefined } : settle().base;
                return (onInput(base), toInput(base.text.length));
            }
        }
        if (!gap && atStart && ev.key === "Backspace") {
            const next = backspaceStructure(value);
            if (next) (ev.preventDefault(), onInput(next));
            return;
        }
        if (!gap && n && atStart && (ev.key === "ArrowLeft" || ev.key === "Home")) {
            ev.preventDefault();
            if (ev.shiftKey) return selectChips(ev.key === "Home" ? 0 : n - 1, n - 1);
            const st = basicStops(value.expr);
            return goStop(ev.key === "Home" ? st[0] : st[st.length - 2], value);
        }
        if (n && mod && ev.key.toLowerCase() === "a" && (!cur || (el.selectionStart === 0 && el.selectionEnd === cur.length))) {
            ev.preventDefault();
            return selectAll();
        }
        if (ev.key === "Enter" && (!ac || ac.active < 0)) return (setAc(null), chipify());
        if (!ac) return;
        const k = ac.items.length;
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            const active = ev.key === "ArrowDown" ? (ac.active + 1) % k : ac.active < 0 ? k - 1 : (ac.active + k - 1) % k;
            const caret = ac.from + suggestionText(ac.items[active]).length;
            pendingCaret.current = [caret, caret];
            setAc({ ...ac, active, kb: true });
        } else if (ev.key === "Enter" || ev.key === "Tab") {
            ev.preventDefault();
            accept(Math.max(0, ac.active));
        } else if (ev.key === "Escape") {
            ev.stopPropagation();
            // first Esc puts back what was typed, the next one closes the list
            if (previewItem) (setAc({ ...ac, active: -1, kb: false }), (pendingCaret.current = [ac.to, ac.to]));
            else setAc(null);
        }
    };

    const textBox = (
        <div class={"net-qtext" + (gap ? " gap" : "")}>
            <input
                ref={input}
                class="net-filter"
                type="text"
                placeholder={gap ? "" : "Filter URL, or type a field or value (-word excludes)"}
                size={gap ? Math.max(1, shown.length + 1) : undefined}
                aria-label="Filter URL"
                spellcheck={false}
                autocomplete="off"
                aria-autocomplete="list"
                aria-expanded={!!ac}
                aria-controls="net-bsuggest"
                aria-activedescendant={ac && ac.active >= 0 ? `net-bopt-${ac.active}` : undefined}
                value={shown}
                onMouseDown={() => setSel(null)}
                onInput={(e) => {
                    const el = e.currentTarget;
                    setSel(null);
                    // AND / OR / ( / ) turn into capsules as they're typed at the end; among the chips they wait for Enter
                    const atEnd = (el.selectionStart ?? el.value.length) === el.value.length;
                    const typed = atEnd && !gap ? typeStructure(value, el.value) : null;
                    if (typed) return (setAc(null), onInput(typed), toInput(typed.text.length)); // its own undo step
                    history.typed();
                    onInput(withText(el.value));
                    suggest(el.value, el.selectionStart ?? el.value.length);
                }}
                onBlur={(ev) => {
                    setAc(null);
                    if (!box.current?.contains(ev.relatedTarget as Node)) setSel(null);
                }}
            />
            {ac && (
                <ul class="net-pop net-qsuggest" ref={listRef} id="net-bsuggest" role="listbox" aria-label="Suggestions">
                    {ac.items.map((s, i) => (
                        <li key={s.label} id={`net-bopt-${i}`} role="option" aria-selected={i === ac.active} class={i === ac.active ? "active" : ""} onMouseDown={(e) => (e.preventDefault(), accept(i))} onMouseEnter={() => !ac.kb && setAc({ ...ac, active: i })}>
                            <span class="net-qlist-main">{s.label}</span>
                            {s.detail && <span class="net-qlist-detail">{s.detail}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
    /** × on a chip / group: the text box goes back to the end first (the structure stays as it is, so `path` holds) */
    const removeItem = (path: number[]) => {
        const base = closeGap(value);
        onInput({ ...base, expr: editItem(value.expr, path, () => null) });
        toInput(base.text.length);
    };
    const gapHere = (path: number[], i: number) => !!gap && gap.index === i && gap.path.join(".") === path.join(".");

    /** back to the end of the box (a click on its background, or on the text left there) */
    const toEnd = () => {
        const { base } = settle();
        if (base !== value) onInput(base);
        toInput(base.text.length);
    };

    let leaf = 0;
    const insertAt = openPath(value.expr).join(".");
    /** the connector typed for the next item, shown where that item will go */
    const pendingConn = (path: number[]) =>
        value.conn && path.join(".") === insertAt ? (
            <button key="pending-conn" class={"net-qconn pending" + (value.conn === "OR" ? " or" : "")} title={`${value.conn} joins the next filter — click for ${value.conn === "OR" ? "AND" : "OR"}`} aria-label={`${value.conn}, joins the next filter, click to switch`} onClick={() => onInput({ ...value, conn: value.conn === "OR" ? "AND" : "OR" })}>
                {value.conn}
            </button>
        ) : null;
    const renderExpr = (e: BasicExpr, path: number[]): JSX.Element[] => [
        ...e.items.map((it, i) => {
            const p = [...path, i];
            const c = e.conns[i - 1];
            const conn = i > 0 && (
                <button class={"net-qconn" + (c === "OR" ? " or" : "")} title={`${c} — click for ${c === "OR" ? "AND" : "OR"}`} aria-label={`${c}, click to switch`} onClick={() => setExpr(toggleConn(value.expr, path, i - 1))}>
                    {c}
                </button>
            );
            const here = gapHere(path, i) && textBox;
            if (it.k === "group")
                return (
                    <Fragment key={p.join(".")}>
                        {conn}
                        {here}
                        <span class={"net-qgroup" + (it.negate ? " neg" : "") + (it.open ? " open" : "")} title={it.open ? "Type ) to close the group" : undefined}>
                            <button class="net-qgroup-op" title={it.negate ? "Excluding the group — click to include" : "Group — click to exclude"} onClick={() => setExpr(editItem(value.expr, p, (g) => (g.k === "group" ? { ...g, negate: !g.negate } : g)))}>
                                {it.negate ? "NOT (" : "("}
                            </button>
                            {renderExpr(it.expr, p)}
                            {!it.open && <span class="net-qgroup-op">)</span>}
                            <button class="net-qchip-x" aria-label="Remove group" title="Remove group" onClick={() => removeItem(p)}>
                                ×
                            </button>
                        </span>
                    </Fragment>
                );
            const ch = it.chip;
            const idx = leaf++;
            const name = ch.field || "url";
            if (here && gap!.edit)
                return (
                    <Fragment key={p.join(".")}>
                        {conn}
                        {here}
                    </Fragment>
                );
            return (
                <Fragment key={p.join(".")}>
                    {conn}
                    {here}
                    <span
                        class={"net-qchip" + (ch.negate ? " neg" : "") + (idx >= lo && idx <= hi ? " sel" : "")}
                        title={chipToString(ch)}
                        aria-selected={idx >= lo && idx <= hi}
                        onMouseDown={(ev) => {
                            if ((ev.target as HTMLElement).closest("button")) return;
                            ev.preventDefault();
                            dragging.current = true;
                            const { base, map } = settle();
                            if (base !== value) onInput(base);
                            if (ev.shiftKey && sel) selectChips(sel.withText ? lo : sel.anchor, map(idx));
                            else selectChips(map(idx), map(idx));
                        }}
                        onDblClick={(ev) => !(ev.target as HTMLElement).closest("button") && !gap && editChip(idx)}
                        onMouseEnter={(ev) => dragging.current && ev.buttons & 1 && sel && setSel({ anchor: sel.anchor, focus: idx })}
                    >
                        <button class="net-qchip-op" title={ch.negate ? "Excluding — click to include" : "Including — click to exclude"} onClick={() => setExpr(editItem(value.expr, p, (x) => (x.k === "chip" ? { k: "chip", chip: { ...x.chip, negate: !x.chip.negate } } : x)))}>
                            {name}
                            {ch.negate ? " ≠" : ":"}
                        </button>
                        <span class="net-qchip-vals">{ch.values.map(unquote).join(", ")}</span>
                        <button class="net-qchip-x" aria-label={`Remove ${name} filter`} title="Remove" onClick={() => removeItem(p)}>
                            ×
                        </button>
                    </span>
                </Fragment>
            );
        }),
        gapHere(path, e.items.length) ? <Fragment key="gap-end">{textBox}</Fragment> : null,
        pendingConn(path),
    ].filter((x): x is JSX.Element => !!x);

    return (
        <div
            ref={box}
            tabIndex={-1}
            class={"net-qbox" + (error ? " error" : "")}
            title={error ? error.message : undefined}
            onKeyDown={(ev) => {
                const k = ev.key.toLowerCase();
                const ownField = ev.target instanceof HTMLInputElement && ev.target !== input.current;
                if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (k === "z" || k === "y") && !ownField) {
                    ev.preventDefault();
                    const v = k === "y" || ev.shiftKey ? history.redo() : history.undo();
                    if (v) (setAc(null), toInput((v.at ? v.at.text : v.text).length));
                    return;
                }
                if (ev.target !== box.current && ev.target !== input.current) return;
                if (sel && leaves.length) onChipKey(ev);
                else if (ev.target === input.current) onInputKey(ev);
            }}
            onMouseDown={(ev) => ev.target === box.current && (ev.preventDefault(), toEnd())}
            onBlur={(ev) => !box.current?.contains(ev.relatedTarget as Node) && setSel(null)}
        >
            {renderExpr(value.expr, [])}
            {gap ? (
                value.text && (
                    <span class="net-qtext-idle" title="Click to type here" onMouseDown={(ev) => (ev.preventDefault(), toEnd())}>
                        {value.text}
                    </span>
                )
            ) : (
                textBox
            )}
            <AddFilter
                data={data}
                onAdd={(chip) => (gap ? (onInput(insertAtGap(value, { items: [{ k: "chip", chip }], conns: [] })), toInput(cur.length)) : (onInput(addChip(value, chip)), toInput(value.text.length)))}
                request={request}
                onRequestDone={() => setRequest(null)}
            />
        </div>
    );
}

type OpId = "contains" | "not-contains" | "is" | "is-not" | "matches" | "gt" | "lt" | "exists" | "missing" | "has-value";
const OP_LABEL: Record<OpId, string> = {
    contains: "contains",
    "not-contains": "does not contain",
    is: "is",
    "is-not": "is not",
    matches: "matches regex",
    gt: ">",
    lt: "<",
    exists: "exists",
    missing: "is missing",
    "has-value": "value contains",
};
const OPS: Record<FieldKind, OpId[]> = {
    text: ["contains", "not-contains", "is", "is-not", "matches"],
    enum: ["is", "is-not"],
    is: ["is", "is-not"],
    status: ["is", "is-not", "gt", "lt"],
    number: ["gt", "lt"],
    header: ["exists", "missing", "has-value"],
};

function buildChip(f: FieldDef, op: OpId, value: string, headerValue: string): Chip {
    const negate = op === "not-contains" || op === "is-not" || op === "missing";
    let raw: string;
    if (f.kind === "header") raw = quoteValue(op === "has-value" ? `${value}=${headerValue}` : value, f.name);
    else if (op === "matches") raw = `/${value}/`;
    else if (op === "gt" || op === "lt") raw = (op === "gt" ? ">" : "<") + value.replace(/\s+/g, "");
    else if ((op === "is" || op === "is-not") && f.kind === "text") raw = "=" + quoteValue(value, f.name);
    else raw = quoteValue(value, f.name);
    return { field: f.name, negate, values: [raw] };
}

/** the operator a "-word" suggestion starts with */
const NEG_OP: Record<FieldKind, OpId> = { text: "not-contains", enum: "is-not", is: "is-not", status: "is-not", number: "gt", header: "missing" };

function AddFilter({ data, onAdd, request, onRequestDone }: { data: SuggestData; onAdd: (c: Chip) => void; request?: AddRequest | null; onRequestDone?: () => void }) {
    const [open, setOpen] = useState(false);
    const [field, setField] = useState<FieldDef | null>(null);
    const [op, setOp] = useState<OpId | null>(null);
    const [value, setValue] = useState("");
    const [headerValue, setHeaderValue] = useState("");
    const [err, setErr] = useState<string | null>(null);
    /** the highlighted value suggestion (-1: none); `kb`: moved with ↑/↓, so the text box shows it */
    const [hl, setHl] = useState({ i: -1, kb: false });
    const active = hl.i;
    const setActive = (i: number, kb = false) => setHl({ i, kb });
    const previewing = useRef(false);
    const ref = useRef<HTMLDivElement>(null);
    const reset = () => (setField(null), setOp(null), setValue(""), setHeaderValue(""), setErr(null), setActive(-1));
    const close = () => (setOpen(false), reset());
    useDismiss(ref, open, close, () => (previewing.current ? setActive(-1) : close()));
    const popRef = useRef<HTMLDivElement>(null);
    useFit(popRef, open, 360);
    const valueInput = useRef<HTMLInputElement>(null);
    useEffect(() => valueInput.current?.focus(), [field, op, open]);
    useEffect(() => {
        if (!request) return;
        reset();
        setField(request.field);
        setOp(request.negate ? NEG_OP[request.field.kind] : OPS[request.field.kind][0]);
        setValue(request.value);
        setOpen(true);
        onRequestDone?.();
    }, [request]);
    const commit = (v = value) => {
        if (!field || !op) return;
        if (!v.trim() || (op === "has-value" && !headerValue.trim())) return setErr("Enter a value");
        const chip = buildChip(field, op, v.trim(), headerValue.trim());
        const e = parseQuery(chipToString(chip)).error;
        if (e) return setErr(e.message);
        onAdd(chip);
        close();
    };
    const opsFor = field ? OPS[field.kind] : [];
    const needsList = field && op && op !== "matches" && op !== "gt" && op !== "lt";
    const suggestions = needsList ? fieldValues(field!.name, data).filter((s) => !/^[<>]/.test(s.value) && s.value.toLowerCase().includes(value.toLowerCase())).slice(0, 50) : [];
    const preview = hl.kb && active >= 0 && active < suggestions.length ? suggestions[active].value : null;
    previewing.current = preview !== null;
    const pick = (v: string) => (op === "has-value" ? (setValue(v), setActive(-1)) : commit(v));
    useEffect(() => setActive(-1), [field, op, value]);
    useEffect(() => {
        document.getElementById(`net-qadd-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
    }, [active]);
    /** what the box shows: the ↑/↓-highlighted suggestion, else what was typed */
    const shown = preview ?? value;
    const onValueKey = (e: KeyboardEvent) => {
        const k = suggestions.length;
        const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
        if (arrow && field?.kind === "text" && op) {
            // text fields: ↑/↓ steps through the operators (contains, is, matches…)
            e.preventDefault();
            const i = opsFor.indexOf(op), n = opsFor.length;
            setOp(opsFor[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]);
        } else if (k && arrow) {
            e.preventDefault();
            setActive(e.key === "ArrowDown" ? (active + 1) % k : active < 0 ? k - 1 : (active + k - 1) % k, true);
        } else if (e.key === "Enter") {
            if (active >= 0 && active < k) pick(suggestions[active].value);
            else if (op !== "has-value") commit();
        } else if (e.key === "Tab" && !e.shiftKey && shown.trim()) {
            // Tab = done: same as Add (for "value contains", it takes the name and moves on to the value)
            if (op === "has-value") return preview !== null && (setValue(preview), setActive(-1));
            e.preventDefault();
            commit(shown);
        }
    };
    return (
        <div class="net-qadd" ref={ref}>
            <button class="net-qadd-btn" aria-haspopup="dialog" aria-expanded={open} title="Add a filter" onClick={() => (open ? close() : setOpen(true))}>
                + Filter
            </button>
            {open && (
                <div class="net-pop net-qadd-pop" ref={popRef} role="dialog" aria-label="Add filter">
                    {!field && (
                        <ul class="net-qlist" aria-label="Field">
                            {FIELDS.map((f) => (
                                <li key={f.name}>
                                    <button
                                        onClick={() => (setField(f), setOp(OPS[f.kind][0]))}
                                    >
                                        <span class="net-qlist-main">{f.name}</span>
                                        <span class="net-qlist-detail">{f.help}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {field && (
                        <div class="net-qadd-form">
                            <div class="net-qadd-head">
                                <button class="net-qadd-back" title="Pick another field" aria-label="Back" onClick={reset}>
                                    ‹
                                </button>
                                <b>{field.name}</b>
                                <span class="net-qadd-ops" role="group" aria-label="Operator">
                                    {opsFor.map((o) => (
                                        <button key={o} class={o === op ? "on" : ""} aria-pressed={o === op} onClick={() => setOp(o)}>
                                            {OP_LABEL[o]}
                                        </button>
                                    ))}
                                </span>
                            </div>
                            {op && (
                                <>
                                    <div class="net-qadd-row">
                                        <input
                                            ref={valueInput}
                                            type="text"
                                            spellcheck={false}
                                            aria-label={field.kind === "header" ? "Header name" : "Value"}
                                            placeholder={field.kind === "header" ? "header name" : field.kind === "number" ? (field.name === "size" ? "10kb" : "500ms") : op === "matches" ? "regex" : "value"}
                                            value={shown}
                                            aria-controls="net-qadd-list"
                                            aria-activedescendant={active >= 0 ? `net-qadd-opt-${active}` : undefined}
                                            onInput={(e) => (setValue(e.currentTarget.value), setErr(null))}
                                            onKeyDown={onValueKey}
                                        />
                                        {op === "has-value" && (
                                            <input type="text" spellcheck={false} aria-label="Header value" placeholder="value" value={headerValue} onInput={(e) => (setHeaderValue(e.currentTarget.value), setErr(null))} onKeyDown={(e) => (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && headerValue.trim())) && (e.preventDefault(), commit())} />
                                        )}
                                        <button class="primary" onClick={() => commit(shown)}>
                                            Add
                                        </button>
                                    </div>
                                    {err && <div class="net-qadd-err">{err}</div>}
                                    {suggestions.length > 0 && (
                                        <ul class="net-qlist" id="net-qadd-list" role="listbox" aria-label="Suggestions">
                                            {suggestions.map((s, i) => (
                                                <li key={s.value} id={`net-qadd-opt-${i}`} role="option" aria-selected={i === active} class={i === active ? "active" : ""} onMouseEnter={() => !hl.kb && setActive(i)}>
                                                    <button onClick={() => pick(s.value)}>
                                                        <span class="net-qlist-main">{s.value}</span>
                                                        {s.detail && <span class="net-qlist-detail">{s.detail}</span>}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Advanced ─────────────────────────────────────────────────────────

function QueryInput({ value, onInput, error, data }: { value: string; onInput: (q: string) => void; error: QueryError | null; data: SuggestData }) {
    const input = useRef<HTMLInputElement>(null);
    const mirror = useRef<HTMLDivElement>(null);
    const [ac, setAc] = useState<(Completion & { active: number }) | null>(null);
    const pendingCaret = useRef<number | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    useFit(listRef, !!ac, 260);
    const syncScroll = () => {
        if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
    };
    useLayoutEffect(() => {
        if (pendingCaret.current !== null && input.current) {
            input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
            pendingCaret.current = null;
        }
        syncScroll();
    });
    const suggest = (text: string, caret: number, force = false) => {
        let from = caret;
        while (from > 0 && !/[\s(]/.test(text[from - 1])) from--;
        const c = force || caret > from ? complete(text, caret, data) : null;
        setAc(c ? { ...c, active: 0 } : null);
    };
    const accept = (i: number) => {
        if (!ac) return;
        const item = ac.items[i];
        let next = value.slice(0, ac.from) + item.insert + value.slice(ac.to);
        let caret = ac.from + item.insert.length;
        const field = item.insert.endsWith(":");
        if (!field && caret === next.length) (next += " "), caret++;
        pendingCaret.current = caret;
        onInput(next);
        if (field) suggest(next, caret, true);
        else setAc(null);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === " " && ev.ctrlKey) {
            ev.preventDefault();
            return suggest(value, input.current!.selectionStart ?? value.length, true);
        }
        if (!ac) return;
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            const n = ac.items.length;
            setAc({ ...ac, active: (ac.active + (ev.key === "ArrowDown" ? 1 : n - 1)) % n });
        } else if (ev.key === "Enter" || ev.key === "Tab") {
            ev.preventDefault();
            accept(ac.active);
        } else if (ev.key === "Escape") {
            ev.stopPropagation();
            setAc(null);
        }
    };
    useEffect(() => {
        const el = document.getElementById(`net-qopt-${ac?.active}`);
        el?.scrollIntoView?.({ block: "nearest" });
    }, [ac?.active]);
    const errEnd = error ? Math.min(error.end, value.length) : 0;
    return (
        <div class={"net-qbox net-qadv" + (error ? " error" : "")}>
            <div class="net-qmirror" ref={mirror} aria-hidden="true">
                {error ? (
                    <>
                        {value.slice(0, error.start)}
                        <span class="net-qerr">{error.start < value.length ? value.slice(error.start, errEnd) : "\u00a0"}</span>
                        {value.slice(errEnd)}
                    </>
                ) : (
                    value
                )}
            </div>
            <input
                ref={input}
                class="net-query"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder="method:POST status:>=400 -host:cdn   (Ctrl+Space for suggestions)"
                aria-label="Filter query"
                aria-invalid={!!error}
                aria-autocomplete="list"
                aria-expanded={!!ac}
                aria-controls="net-qsuggest"
                aria-activedescendant={ac ? `net-qopt-${ac.active}` : undefined}
                title={error ? error.message : undefined}
                value={value}
                onInput={(e) => {
                    const el = e.currentTarget;
                    onInput(el.value);
                    suggest(el.value, el.selectionStart ?? el.value.length);
                }}
                onKeyDown={onKeyDown}
                onScroll={syncScroll}
                onKeyUp={syncScroll}
                onBlur={() => setAc(null)}
            />
            {error && (
                <span class="net-qerr-msg" role="status">
                    {error.message}
                </span>
            )}
            {ac && (
                <ul class="net-pop net-qsuggest" ref={listRef} id="net-qsuggest" role="listbox" aria-label="Suggestions">
                    {ac.items.map((s, i) => (
                        <li key={s.label} id={`net-qopt-${i}`} role="option" aria-selected={i === ac.active} class={i === ac.active ? "active" : ""} onMouseDown={(e) => (e.preventDefault(), accept(i))} onMouseEnter={() => setAc({ ...ac, active: i })}>
                            <span class="net-qlist-main">{s.label}</span>
                            {s.detail && <span class="net-qlist-detail">{s.detail}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ── "?" syntax help ──────────────────────────────────────────────────

const SYNTAX: [string, string][] = [
    ["word", "URL contains word (space = AND)"],
    ["field:value", "Field contains / equals value"],
    ["field:a,b", "Either value"],
    ["-term   NOT term", "Exclude"],
    ["a OR b   ( … )", "Either side; group with parentheses"],
    ['"two words"', "Quote spaces, commas, parentheses"],
    ["=value   val*   /re/", "Exact, wildcard (whole value), regex"],
    [">  >=  <  <=", "Compare status, size (kb, mb), time (ms, s)"],
    ["4xx   400..499", "Status class or range"],
];
const EXAMPLES: [string, string][] = [
    ["status:>=400", "Errors"],
    ["is:modified -type:img", "Changed by a script, no images"],
    ["method:POST,PUT host:api", "Writes to an API host"],
    ["res-header:content-type=json", "JSON responses"],
    ["req-header:authorization", "Authenticated requests"],
    ['res-body:"error"', "Recorded response body mentions error"],
    ["size:>100kb OR time:>1s", "Heavy or slow"],
    ["(type:fetch OR type:doc) -is:cached", "Fresh XHR/fetch and documents"],
];

function SyntaxHelp({ onPick }: { onPick: (q: string) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useDismiss(ref, open, () => setOpen(false));
    const popRef = useRef<HTMLDivElement>(null);
    useFit(popRef, open);
    return (
        <div class="net-qhelp" ref={ref}>
            <button class="net-qhelp-btn" aria-label="Filter syntax" aria-expanded={open} title="Filter syntax" onClick={() => setOpen(!open)}>
                ?
            </button>
            {open && (
                <div class="net-pop net-qhelp-pop" ref={popRef} role="dialog" aria-label="Filter syntax">
                    <table class="net-qhelp-table">
                        <tbody>
                            {SYNTAX.map(([k, v]) => (
                                <tr key={k}>
                                    <td>
                                        <code>{k}</code>
                                    </td>
                                    <td>{v}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div class="net-qhelp-h">Fields</div>
                    <div class="net-qhelp-fields">
                        {FIELDS.map((f) => (
                            <code key={f.name} title={f.help}>
                                {f.name}
                            </code>
                        ))}
                    </div>
                    <div class="net-qhelp-h">Examples — click to use</div>
                    <ul class="net-qlist">
                        {EXAMPLES.map(([q, d]) => (
                            <li key={q}>
                                <button onClick={() => (setOpen(false), onPick(q))}>
                                    <code class="net-qlist-main">{q}</code>
                                    <span class="net-qlist-detail">{d}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <p class="net-qhelp-note">
                        <code>req-body</code>/<code>res-body</code> search only bodies Wiretrick recorded. Script, tab and activity menus to the right also apply.
                    </p>
                </div>
            )}
        </div>
    );
}
