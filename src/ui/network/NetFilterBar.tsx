/**
 * Network filter bar: one query, two editors. Basic builds it from a text
 * box and chips ("+ Filter": field → operator → value); Advanced edits the
 * query directly with autocomplete, error underlines and a "?" syntax help.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import {
    FIELDS,
    chipToString,
    complete,
    fieldValues,
    fromBasic,
    parseQuery,
    quoteValue,
    toBasic,
    type BasicFilter,
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
    return { mode, basic: { text: "", chips: [] }, query: "" };
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
        const basic = parsed.error ? null : toBasic(parsed.ast);
        if (!basic) return setWarn(true);
        onChange({ ...state, mode, basic });
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
                    <div class="net-pop net-qwarn" role="alertdialog" aria-label="Query too complex for Basic">
                        <p>{parseQuery(state.query).error ? "This query has an error." : "This query uses OR or groups across fields, which Basic can't show as chips."}</p>
                        <div class="net-pop-actions">
                            <button class="primary" onClick={() => setWarn(false)}>
                                Stay in Advanced
                            </button>
                            <button
                                onClick={() => {
                                    setWarn(false);
                                    onChange({ ...state, mode: "basic", basic: { text: "", chips: [] } });
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
/** fields whose repeated picks OR into one chip (a request has one method / status / type…) */
const MERGE = new Set(["method", "status", "type", "is", "tab", "script"]);

function BasicInput({ value, onInput, error, data }: { value: BasicFilter; onInput: (b: BasicFilter) => void; error: QueryError | null; data: SuggestData }) {
    const set = (chips: Chip[]) => onInput({ ...value, chips });
    const add = (chip: Chip) => {
        const i = MERGE.has(chip.field) ? value.chips.findIndex((c) => c.field === chip.field && c.negate === chip.negate) : -1;
        if (i < 0) return set([...value.chips, chip]);
        const merged = { ...value.chips[i], values: [...new Set([...value.chips[i].values, ...chip.values])] };
        set(value.chips.map((c, j) => (j === i ? merged : c)));
    };
    return (
        <div class={"net-qbox" + (error ? " error" : "")} title={error ? error.message : undefined}>
            {value.chips.map((c, i) => (
                <span key={i} class={"net-qchip" + (c.negate ? " neg" : "")} title={chipToString(c)}>
                    <button class="net-qchip-op" title={c.negate ? "Excluding — click to include" : "Including — click to exclude"} onClick={() => set(value.chips.map((x, j) => (j === i ? { ...x, negate: !x.negate } : x)))}>
                        {c.field}
                        {c.negate ? " ≠" : ":"}
                    </button>
                    <span class="net-qchip-vals">{c.values.map(unquote).join(", ")}</span>
                    <button class="net-qchip-x" aria-label={`Remove ${c.field} filter`} title="Remove" onClick={() => set(value.chips.filter((_, j) => j !== i))}>
                        ×
                    </button>
                </span>
            ))}
            <input class="net-filter" type="text" placeholder="Filter URL (-word excludes)" aria-label="Filter URL" spellcheck={false} value={value.text} onInput={(e) => onInput({ ...value, text: e.currentTarget.value })} />
            <AddFilter data={data} onAdd={add} />
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

function AddFilter({ data, onAdd }: { data: SuggestData; onAdd: (c: Chip) => void }) {
    const [open, setOpen] = useState(false);
    const [field, setField] = useState<FieldDef | null>(null);
    const [op, setOp] = useState<OpId | null>(null);
    const [value, setValue] = useState("");
    const [headerValue, setHeaderValue] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const reset = () => (setField(null), setOp(null), setValue(""), setHeaderValue(""), setErr(null));
    const close = () => (setOpen(false), reset());
    useDismiss(ref, open, close);
    const popRef = useRef<HTMLDivElement>(null);
    useFit(popRef, open, 360);
    const valueInput = useRef<HTMLInputElement>(null);
    useEffect(() => valueInput.current?.focus(), [field, op]);
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
    const suggestions = needsList ? fieldValues(field!.name, data).filter((s) => !/^[<>]/.test(s.value) && s.value.toLowerCase().includes(value.toLowerCase())) : [];
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
                                            onInput={(e) => (setValue(e.currentTarget.value), setErr(null))}
                                            onKeyDown={(e) => e.key === "Enter" && op !== "has-value" && commit()}
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
                                        <ul class="net-qlist" aria-label="Suggestions">
                                            {suggestions.slice(0, 50).map((s) => (
                                                <li key={s.value}>
                                                    <button onClick={() => (op === "has-value" ? setValue(s.value) : commit(s.value))}>
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
