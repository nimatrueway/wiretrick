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
    addExpr,
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
    return { mode, basic: emptyBasic(), query: "" };
}
export function effectiveQuery(s: FilterState): string {
    return s.mode === "basic" ? fromBasic(s.basic) : s.query;
}

/** Close a popup on outside mousedown or Escape. */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
    useEffect(() => {
        if (!open) return;
        const onDown = (ev: MouseEvent) => {
            if (!ref.current?.contains(ev.target as Node)) close();
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === "Escape") {
                ev.stopPropagation();
                close();
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

/** typing within this long after the last keystroke joins the same undo step */
const TYPING_JOIN_MS = 1000;
const UNDO_DEPTH = 100;

/**
 * Undo/redo over the Basic filter: chips aren't text, so the input's native
 * undo can't bring them back. Every change is a step, wherever it came from
 * (Clear included); consecutive typing joins one step.
 */
function useBasicUndo(value: BasicFilter, onInput: (b: BasicFilter) => void) {
    const h = useRef({ past: [] as BasicFilter[], future: [] as BasicFilter[], cur: value, key: JSON.stringify(value), typedAt: 0, typing: false, nav: false }).current;
    const key = JSON.stringify(value);
    if (key !== h.key) {
        const now = Date.now();
        if (!h.nav) {
            if (!(h.typing && now - h.typedAt < TYPING_JOIN_MS)) h.past = [...h.past, h.cur].slice(-UNDO_DEPTH);
            h.future = [];
        }
        h.typedAt = h.typing && !h.nav ? now : 0;
        h.nav = false;
        h.cur = value;
        h.key = key;
    }
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
    const pendingCaret = useRef<number | null>(null);
    const [sel, setSel] = useState<Sel | null>(null);
    const [ac, setAc] = useState<{ from: number; to: number; items: BasicSuggestion[]; active: number } | null>(null);
    const [request, setRequest] = useState<AddRequest | null>(null);
    useFit(listRef, !!ac, 260);
    const history = useBasicUndo(value, onInput);
    useLayoutEffect(() => {
        if (pendingCaret.current === null || !input.current) return;
        input.current.focus();
        input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
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
    const lo = sel ? Math.min(sel.anchor, sel.focus) : -1;
    const hi = sel ? Math.max(sel.anchor, sel.focus) : -2;
    const setExpr = (expr: BasicExpr) => onInput({ ...value, expr });
    const toInput = (caret: number) => {
        setSel(null);
        pendingCaret.current = caret;
        input.current?.focus();
        input.current?.setSelectionRange(caret, caret);
    };
    const selectChips = (anchor: number, focus: number) => {
        setAc(null);
        setSel({ anchor, focus });
        box.current?.focus();
    };
    const selectAll = () => {
        setAc(null);
        setSel({ anchor: 0, focus: leaves.length - 1, withText: true });
        input.current?.focus();
        input.current?.select();
    };
    /** the selection removed; `typed` (a printed key) replaces it, as in a text box */
    const replaceSel = (typed = "") => {
        const drop = new Set(leaves.slice(lo, hi + 1));
        const text = typed + (sel?.withText ? "" : value.text);
        onInput({ text, expr: removeChips(value.expr, drop) });
        toInput(typed.length);
        if (typed) suggest(text, typed.length);
    };
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
        const text = (value.text.slice(0, ac.from) + value.text.slice(ac.to)).replace(/\s+/g, " ").trim();
        setAc(null);
        if (item.kind === "chip") return (onInput(addChip({ ...value, text }, item.chip)), toInput(text.length));
        onInput({ ...value, text });
        setRequest({ field: item.field, negate: item.negate, value: item.value });
    };
    /** Enter with nothing picked: what the text box holds besides plain words becomes chips */
    const chipify = () => {
        const parsed = parseQuery(value.text);
        if (parsed.error) return;
        const b = toBasic(parsed.ast);
        if (leafChips(b.expr).length) onInput(addExpr({ ...value, text: b.text }, b.expr));
    };

    const onChipKey = (ev: KeyboardEvent) => {
        const n = leaves.length;
        const mod = ev.ctrlKey || ev.metaKey;
        const key = ev.key;
        if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
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
        const mod = ev.ctrlKey || ev.metaKey;
        if (n && atStart && ev.key === "Backspace") {
            ev.preventDefault();
            return setExpr(removeChips(value.expr, new Set([leaves[n - 1]])));
        }
        if (n && atStart && (ev.key === "ArrowLeft" || ev.key === "Home")) {
            ev.preventDefault();
            return selectChips(ev.key === "Home" ? 0 : n - 1, ev.key === "Home" && ev.shiftKey ? n - 1 : ev.key === "Home" ? 0 : n - 1);
        }
        if (n && mod && ev.key.toLowerCase() === "a" && (!value.text || (el.selectionStart === 0 && el.selectionEnd === value.text.length))) {
            ev.preventDefault();
            return selectAll();
        }
        if (ev.key === "Enter" && (!ac || ac.active < 0)) return (setAc(null), chipify());
        if (!ac) return;
        const k = ac.items.length;
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            setAc({ ...ac, active: ev.key === "ArrowDown" ? (ac.active + 1) % k : (ac.active + k - 1) % k });
        } else if (ev.key === "Enter" || ev.key === "Tab") {
            ev.preventDefault();
            accept(Math.max(0, ac.active));
        } else if (ev.key === "Escape") {
            ev.stopPropagation();
            setAc(null);
        }
    };

    let leaf = 0;
    const renderExpr = (e: BasicExpr, path: number[]): JSX.Element[] =>
        e.items.map((it, i) => {
            const p = [...path, i];
            const c = e.conns[i - 1];
            const conn = i > 0 && (
                <button class={"net-qconn" + (c === "OR" ? " or" : "")} title={`${c} — click for ${c === "OR" ? "AND" : "OR"}`} aria-label={`${c}, click to switch`} onClick={() => setExpr(toggleConn(value.expr, path, i - 1))}>
                    {c}
                </button>
            );
            if (it.k === "group")
                return (
                    <Fragment key={p.join(".")}>
                        {conn}
                        <span class={"net-qgroup" + (it.negate ? " neg" : "")}>
                            <button class="net-qgroup-op" title={it.negate ? "Excluding the group — click to include" : "Group — click to exclude"} onClick={() => setExpr(editItem(value.expr, p, (g) => (g.k === "group" ? { ...g, negate: !g.negate } : g)))}>
                                {it.negate ? "NOT (" : "("}
                            </button>
                            {renderExpr(it.expr, p)}
                            <span class="net-qgroup-op">)</span>
                            <button class="net-qchip-x" aria-label="Remove group" title="Remove group" onClick={() => (setExpr(editItem(value.expr, p, () => null)), toInput(value.text.length))}>
                                ×
                            </button>
                        </span>
                    </Fragment>
                );
            const ch = it.chip;
            const idx = leaf++;
            const name = ch.field || "url";
            return (
                <Fragment key={p.join(".")}>
                    {conn}
                    <span
                        class={"net-qchip" + (ch.negate ? " neg" : "") + (idx >= lo && idx <= hi ? " sel" : "")}
                        title={chipToString(ch)}
                        aria-selected={idx >= lo && idx <= hi}
                        onMouseDown={(ev) => {
                            if ((ev.target as HTMLElement).closest("button")) return;
                            ev.preventDefault();
                            dragging.current = true;
                            if (ev.shiftKey && sel) selectChips(sel.withText ? lo : sel.anchor, idx);
                            else selectChips(idx, idx);
                        }}
                        onMouseEnter={(ev) => dragging.current && ev.buttons & 1 && sel && setSel({ anchor: sel.anchor, focus: idx })}
                    >
                        <button class="net-qchip-op" title={ch.negate ? "Excluding — click to include" : "Including — click to exclude"} onClick={() => setExpr(editItem(value.expr, p, (x) => (x.k === "chip" ? { k: "chip", chip: { ...x.chip, negate: !x.chip.negate } } : x)))}>
                            {name}
                            {ch.negate ? " ≠" : ":"}
                        </button>
                        <span class="net-qchip-vals">{ch.values.map(unquote).join(", ")}</span>
                        <button class="net-qchip-x" aria-label={`Remove ${name} filter`} title="Remove" onClick={() => (setExpr(editItem(value.expr, p, () => null)), toInput(value.text.length))}>
                            ×
                        </button>
                    </span>
                </Fragment>
            );
        });

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
                    if (v) (setAc(null), toInput(v.text.length));
                    return;
                }
                if (ev.target !== box.current && ev.target !== input.current) return;
                if (sel && leaves.length) onChipKey(ev);
                else if (ev.target === input.current) onInputKey(ev);
            }}
            onMouseDown={(ev) => ev.target === box.current && (ev.preventDefault(), toInput(value.text.length))}
            onBlur={(ev) => !box.current?.contains(ev.relatedTarget as Node) && setSel(null)}
        >
            {renderExpr(value.expr, [])}
            <div class="net-qtext">
                <input
                    ref={input}
                    class="net-filter"
                    type="text"
                    placeholder="Filter URL, or type a field or value (-word excludes)"
                    aria-label="Filter URL"
                    spellcheck={false}
                    autocomplete="off"
                    aria-autocomplete="list"
                    aria-expanded={!!ac}
                    aria-controls="net-bsuggest"
                    aria-activedescendant={ac && ac.active >= 0 ? `net-bopt-${ac.active}` : undefined}
                    value={value.text}
                    onMouseDown={() => setSel(null)}
                    onInput={(e) => {
                        const el = e.currentTarget;
                        setSel(null);
                        history.typed();
                        onInput({ ...value, text: el.value });
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
                            <li key={s.label} id={`net-bopt-${i}`} role="option" aria-selected={i === ac.active} class={i === ac.active ? "active" : ""} onMouseDown={(e) => (e.preventDefault(), accept(i))} onMouseEnter={() => setAc({ ...ac, active: i })}>
                                <span class="net-qlist-main">{s.label}</span>
                                {s.detail && <span class="net-qlist-detail">{s.detail}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <AddFilter data={data} onAdd={(chip) => (onInput(addChip(value, chip)), toInput(value.text.length))} request={request} onRequestDone={() => setRequest(null)} />
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
    /** the highlighted value suggestion (-1: none), moved with Up/Down from the text box */
    const [active, setActive] = useState(-1);
    const ref = useRef<HTMLDivElement>(null);
    const reset = () => (setField(null), setOp(null), setValue(""), setHeaderValue(""), setErr(null), setActive(-1));
    const close = () => (setOpen(false), reset());
    useDismiss(ref, open, close);
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
    const pick = (v: string) => (op === "has-value" ? (setValue(v), setActive(-1)) : commit(v));
    useEffect(() => setActive(-1), [field, op, value]);
    useEffect(() => {
        document.getElementById(`net-qadd-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
    }, [active]);
    const onValueKey = (e: KeyboardEvent) => {
        const k = suggestions.length;
        if (k && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive(e.key === "ArrowDown" ? (active + 1) % k : (active < 0 ? k - 1 : (active + k - 1) % k));
        } else if (e.key === "Enter") {
            if (active >= 0 && active < k) pick(suggestions[active].value);
            else if (op !== "has-value") commit();
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
                                            value={value}
                                            aria-controls="net-qadd-list"
                                            aria-activedescendant={active >= 0 ? `net-qadd-opt-${active}` : undefined}
                                            onInput={(e) => (setValue(e.currentTarget.value), setErr(null))}
                                            onKeyDown={onValueKey}
                                        />
                                        {op === "has-value" && (
                                            <input type="text" spellcheck={false} aria-label="Header value" placeholder="value" value={headerValue} onInput={(e) => (setHeaderValue(e.currentTarget.value), setErr(null))} onKeyDown={(e) => e.key === "Enter" && commit()} />
                                        )}
                                        <button class="primary" onClick={() => commit()}>
                                            Add
                                        </button>
                                    </div>
                                    {err && <div class="net-qadd-err">{err}</div>}
                                    {suggestions.length > 0 && (
                                        <ul class="net-qlist" id="net-qadd-list" role="listbox" aria-label="Suggestions">
                                            {suggestions.map((s, i) => (
                                                <li key={s.value} id={`net-qadd-opt-${i}`} role="option" aria-selected={i === active} class={i === active ? "active" : ""} onMouseEnter={() => setActive(i)}>
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
