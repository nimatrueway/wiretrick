/**
 * Network tab of the manager's bottom panel — a devtools-style request
 * table (query filter, sortable columns, waterfall) with a details
 * pane showing headers and what Wiretrick scripts did to the request.
 */
import { createPortal } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { NetBody, NetEntry, NetOutcome } from "../../shared/netTypes";
import type { NetStore } from "./netStore";
import {
    compare,
    displayName,
    duration,
    formatBytes,
    formatMs,
    statusText,
    touchCounts,
    touchState,
    typeLabel,
    type SortKey,
} from "./netFormat";
import { compileQuery, parseQuery, suggestData, type QNode } from "./netQuery";
import { FilterBar, effectiveQuery, initialFilterState, type FilterState } from "./NetFilterBar";
import { formatKey } from "../shortcuts";

export interface TabInfo {
    id: number;
    title: string;
}

const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
    { key: "name", label: "Name", cls: "c-name" },
    { key: "status", label: "Status", cls: "c-status" },
    { key: "method", label: "Method", cls: "c-method" },
    { key: "type", label: "Type", cls: "c-type" },
    { key: "script", label: "Wiretrick", cls: "c-script" },
    { key: "size", label: "Size", cls: "c-size" },
    { key: "time", label: "Time", cls: "c-time" },
    { key: "start", label: "Waterfall", cls: "c-wf" },
];

/** Column visibility / widths and the details pane width, kept across sessions */
interface Layout {
    hidden: SortKey[];
    widths: Partial<Record<SortKey, number>>;
    detailsWidth: number | null;
}
const LAYOUT_KEY = "wt.network.layout";
const DEFAULT_LAYOUT: Layout = { hidden: [], widths: {}, detailsWidth: null };
const MIN_COL = 36;

function loadLayout(): Layout {
    try {
        const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
        if (v && Array.isArray(v.hidden) && v.widths && typeof v.widths === "object") return { ...DEFAULT_LAYOUT, ...v };
    } catch {}
    return DEFAULT_LAYOUT;
}

/** Track a pointer drag from `down`, reporting the x delta; cleans itself up. */
function dragX(down: MouseEvent, onMove: (dx: number) => void, cursor: string): void {
    down.preventDefault();
    down.stopPropagation();
    const x0 = down.clientX;
    const prev = document.body.style.cursor;
    document.body.style.cursor = cursor;
    document.body.classList.add("net-dragging");
    const move = (ev: MouseEvent) => onMove(ev.clientX - x0);
    const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.cursor = prev;
        document.body.classList.remove("net-dragging");
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
}

/** `toolsHost`: where the filter and clear button go (the panel header, beside the Log's); without one they sit above the table */
export function NetworkPanel({ store, listTabs, toolsHost }: { store: NetStore; listTabs?: () => Promise<TabInfo[]>; toolsHost?: HTMLElement | null }) {
    const [tabs, setTabs] = useState<TabInfo[]>([]);
    const [fq, setFq] = useState<FilterState>(initialFilterState);
    const parsed = useMemo(() => parseQuery(effectiveQuery(fq)), [fq]);
    // while the query has an error, keep filtering by the last valid one
    const lastGood = useRef<QNode | null>(null);
    if (!parsed.error) lastGood.current = parsed.ast;
    const ast = lastGood.current;
    // titles of every tab seen live, so a closed tab keeps its name
    const tabTitles = useRef(new Map<number, string>());
    const tabTitle = (id: number) => tabs.find((t) => t.id === id)?.title ?? tabTitles.current.get(id);
    const pred = useMemo(() => compileQuery(ast, { tabTitle }), [ast, tabs]);
    const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "start", dir: 1 });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [layout, setLayoutState] = useState<Layout>(loadLayout);
    const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);
    const colMenuRef = useRef<HTMLUListElement>(null);
    // keep the context menu on-screen (flip up/left near the edges)
    useLayoutEffect(() => {
        const el = colMenuRef.current;
        if (!el || !colMenu) return;
        const r = el.getBoundingClientRect();
        const x = r.right > innerWidth ? Math.max(0, colMenu.x - r.width) : colMenu.x;
        const y = r.bottom > innerHeight ? Math.max(0, colMenu.y - r.height) : colMenu.y;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    }, [colMenu]);
    const bodyRef = useRef<HTMLDivElement>(null);
    const setLayout = (next: Layout) => {
        setLayoutState(next);
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
        } catch {}
    };
    const all = store.entries.value;
    const selected = selectedId ? all.find((e) => e.id === selectedId) || null : null;
    // Name is always shown; with the details pane open only Name is (like
    // devtools) so the narrow table never squeezes it out
    const visible = selected ? COLUMNS.slice(0, 1) : COLUMNS.filter((c) => c.key === "name" || !layout.hidden.includes(c.key));
    // the last visible column absorbs leftover width
    const flexKey = visible[visible.length - 1].key;
    const colWidth = (k: SortKey) => (k === flexKey ? undefined : layout.widths[k]);
    const minTable = visible.reduce((n, c) => n + (colWidth(c.key) ?? 60), 0);

    useEffect(() => {
        if (!colMenu) return;
        const close = (ev: Event) => {
            if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
            if (ev.type === "mousedown" && (ev.target as Element)?.closest?.(".net-colmenu")) return;
            setColMenu(null);
        };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", close);
        window.addEventListener("blur", close);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", close);
            window.removeEventListener("blur", close);
        };
    }, [colMenu]);

    const startColResize = (ev: MouseEvent, key: SortKey) => {
        const th = (ev.currentTarget as HTMLElement).parentElement!;
        const w0 = th.getBoundingClientRect().width;
        let cur = layout;
        dragX(
            ev,
            (dx) => {
                cur = { ...cur, widths: { ...cur.widths, [key]: Math.max(MIN_COL, Math.round(w0 + dx)) } };
                setLayoutState(cur);
            },
            "col-resize",
        );
        document.addEventListener("mouseup", () => setLayout(cur), { once: true });
    };
    const startDetailsResize = (ev: MouseEvent) => {
        const body = bodyRef.current!;
        const details = body.querySelector(".net-details") as HTMLElement;
        const w0 = details.getBoundingClientRect().width;
        const max = body.getBoundingClientRect().width - 120;
        let cur = layout;
        dragX(
            ev,
            (dx) => {
                cur = { ...cur, detailsWidth: Math.round(Math.min(max, Math.max(200, w0 - dx))) };
                setLayoutState(cur);
            },
            "col-resize",
        );
        document.addEventListener("mouseup", () => setLayout(cur), { once: true });
    };

    const rows = useMemo(() => {
        const out = all.filter(pred);
        const cmp = compare(sort.key);
        out.sort((a, b) => cmp(a, b) * sort.dir || a.startedAt - b.startedAt);
        return out;
    }, [all, sort, pred]);

    const span = useMemo(() => {
        if (!rows.length) return { t0: 0, total: 1 };
        const t0 = Math.min(...rows.map((e) => e.startedAt));
        const t1 = Math.max(...rows.map((e) => e.endedAt ?? Date.now()));
        return { t0, total: Math.max(1, t1 - t0) };
    }, [rows]);

    // stick to the bottom while new requests stream in (like devtools)
    const scroller = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && atBottom.current && sort.key === "start" && sort.dir === 1) el.scrollTop = el.scrollHeight;
    }, [rows]);

    useEffect(() => {
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === "Escape" && selectedId) setSelectedId(null);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [selectedId]);

    // refresh on focus only: replacing <option>s while the native dropdown
    // is open (mousedown) closes it / drops the pick in Chromium
    const refreshTabs = () =>
        void listTabs?.().then((next) => {
            for (const t of next) tabTitles.current.set(t.id, t.title);
            setTabs((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        });
    useEffect(() => {
        refreshTabs();
        const api = (globalThis as any).chrome?.tabs;
        if (!api?.onRemoved) return;
        const onRemoved = () => refreshTabs();
        const onUpdated = (_id: number, info: { title?: string; url?: string }) => {
            if (info.title || info.url) refreshTabs();
        };
        api.onRemoved.addListener(onRemoved);
        api.onCreated?.addListener(onRemoved);
        api.onUpdated?.addListener(onUpdated);
        return () => {
            api.onRemoved.removeListener(onRemoved);
            api.onCreated?.removeListener(onRemoved);
            api.onUpdated?.removeListener(onUpdated);
        };
    }, []);
    const suggestions = useMemo(() => suggestData(all, tabTitle), [all, tabs]);

    const touched = touchCounts(rows);
    const bytes = rows.reduce((n, e) => n + (e.size ?? 0), 0);

    const toolbar = (
        <div class="net-toolbar">
            <FilterBar state={fq} onChange={setFq} error={parsed.error} data={suggestions} />
            <button class="net-clear icon-btn" title={`Clear the network log (${formatKey("Alt+Shift+K", /Mac|iPhone|iPad/.test(navigator.platform))})`} aria-label="Clear network log" onClick={() => (store.clear(), setSelectedId(null))}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M2.5 4h9M2.5 7.5h9M2.5 11h4.5M9.5 10l3.5 3.5M13 10l-3.5 3.5" />
            </svg>
            </button>
        </div>
    );

    return (
        <div class="net">
            {toolsHost ? createPortal(toolbar, toolsHost) : toolbar}
            <div class={selected ? "net-body with-details" : "net-body"} ref={bodyRef}>
                <div
                    class="net-table-wrap"
                    ref={scroller}
                    onScroll={(e) => {
                        const el = e.currentTarget;
                        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                    }}
                >
                    <table class="net-table" style={{ minWidth: `${minTable}px` }}>
                        <thead
                            onContextMenu={(ev) => {
                                ev.preventDefault();
                                setColMenu({ x: ev.clientX, y: ev.clientY });
                            }}
                        >
                            <tr>
                                {visible.map((c) => {
                                    const w = colWidth(c.key);
                                    return (
                                        <th
                                            key={c.key}
                                            class={c.cls}
                                            style={w !== undefined ? { width: `${w}px` } : c.key === flexKey ? { width: "auto" } : undefined}
                                            aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                                            title="Click to sort · right-click to choose columns"
                                            onClick={() => setSort(sort.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}
                                        >
                                            {c.label}
                                            {sort.key === c.key && <span class="net-sort">{sort.dir === 1 ? "▲" : "▼"}</span>}
                                            {c.key !== flexKey && (
                                                <span
                                                    class="net-col-resize"
                                                    aria-hidden="true"
                                                    onMouseDown={(ev) => startColResize(ev, c.key)}
                                                    onClick={(ev) => ev.stopPropagation()}
                                                    onDblClick={(ev) => {
                                                        ev.stopPropagation();
                                                        const widths = { ...layout.widths };
                                                        delete widths[c.key];
                                                        setLayout({ ...layout, widths });
                                                    }}
                                                />
                                            )}
                                        </th>
                                    );
                                })}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((e) => (
                                <Row
                                    key={e.id}
                                    e={e}
                                    span={span}
                                    cols={visible.map((c) => c.key)}
                                    selected={e.id === selectedId}
                                    onSelect={() => setSelectedId(e.id === selectedId ? null : e.id)}
                                />
                            ))}
                        </tbody>
                    </table>
                    {rows.length === 0 && (
                        <div class="net-empty">
                            {all.length === 0
                                ? "Recording network activity… reload a page to see its requests."
                                : "No requests match the filter."}
                        </div>
                    )}
                </div>
                {selected && <div class="net-splitter" role="separator" aria-orientation="vertical" title="Drag to resize" onMouseDown={startDetailsResize} />}
                {selected && <Details e={selected} width={layout.detailsWidth} onClose={() => setSelectedId(null)} />}
            </div>
            {colMenu && (
                <ul class="net-colmenu" role="menu" ref={colMenuRef} style={{ left: `${colMenu.x}px`, top: `${colMenu.y}px` }}>
                    {COLUMNS.filter((c) => c.key !== "name").map((c) => {
                        const on = !layout.hidden.includes(c.key);
                        return (
                            <li
                                key={c.key}
                                role="menuitemcheckbox"
                                aria-checked={on}
                                onClick={() => setLayout({ ...layout, hidden: on ? [...layout.hidden, c.key] : layout.hidden.filter((k) => k !== c.key) })}
                            >
                                <span class="net-colmenu-check">{on ? "✓" : ""}</span>
                                {c.label}
                            </li>
                        );
                    })}
                    <li class="sep" role="separator" />
                    <li
                        role="menuitem"
                        onClick={() => {
                            setLayout(DEFAULT_LAYOUT);
                            setColMenu(null);
                        }}
                    >
                        <span class="net-colmenu-check" />
                        Reset columns
                    </li>
                </ul>
            )}
            <div class="net-status">
                {rows.length === all.length ? `${all.length} requests` : `${rows.length} / ${all.length} requests`}
                {" · "}
                {formatBytes(bytes)} transferred
                {" · "}
                <span class="net-touch-count" title="Observed: a script handler ran on the request without changing it · Modified: a handler changed it">
                    {touched.observed} observed · <span class={touched.modified ? "net-hl" : ""}>{touched.modified} modified</span>
                </span>
            </div>
        </div>
    );
}

const KIND_TITLE: Record<NetOutcome["kind"], string> = {
    modified: "Modified: the handler changed the request",
    observed: "Observed: the handler ran without changing it",
    missed: "Missed: a body handler should have run here but no strategy ran it",
};

function rowClass(e: NetEntry, selected: boolean): string {
    const c = ["net-row"];
    if (selected) c.push("selected");
    if (e.state === "failed" || (e.status !== null && e.status >= 400)) c.push("err");
    if (e.state === "pending") c.push("pending");
    const t = touchState(e);
    if (t !== "none") c.push(t);
    return c.join(" ");
}

function scriptNames(e: NetEntry): string[] {
    return [...new Set(e.outcomes.map((i) => i.scriptName))];
}

function Row({
    e,
    span,
    cols,
    selected,
    onSelect,
}: {
    e: NetEntry;
    span: { t0: number; total: number };
    cols: SortKey[];
    selected: boolean;
    onSelect: () => void;
}) {
    const { name, host } = displayName(e.url);
    const ms = duration(e);
    const left = ((e.startedAt - span.t0) / span.total) * 100;
    const width = Math.max(0.5, (((e.endedAt ?? span.t0 + span.total) - e.startedAt) / span.total) * 100);
    return (
        <tr class={rowClass(e, selected)} onClick={onSelect} title={e.url}>
            {cols.map((k) => cell(k))}
        </tr>
    );
    function cell(k: SortKey) {
        switch (k) {
            case "name":
                return (
                    <td key={k} class="c-name">
                        <span class="net-name">{name}</span>
                        <span class="net-host">{host}</span>
                    </td>
                );
            case "status":
                return (
                    <td key={k} class="c-status">
                        {statusText(e)}
                    </td>
                );
            case "method":
                return (
                    <td key={k} class="c-method">
                        {e.method}
                    </td>
                );
            case "type":
                return (
                    <td key={k} class="c-type">
                        {typeLabel(e)}
                    </td>
                );
            case "script":
                return (
                    <td key={k} class="c-script">
                        {scriptNames(e).map((n) => {
                            const mine = e.outcomes.filter((i) => i.scriptName === n);
                            return (
                                <span
                                    key={n}
                                    class={`net-badge ${mine.some((i) => i.kind === "modified") ? "modified" : mine.some((i) => i.kind === "observed") ? "observed" : "missed"}`}
                                    title={mine.map((i) => i.action).join("\n")}
                                >
                                    {n}
                                </span>
                            );
                        })}
                    </td>
                );
            case "size":
                return (
                    <td key={k} class="c-size">
                        {e.fromCache ? "(cache)" : formatBytes(e.size)}
                    </td>
                );
            case "time":
                return (
                    <td key={k} class="c-time">
                        {e.synthetic ? "—" : formatMs(ms)}
                    </td>
                );
            default:
                return (
                    <td key={k} class="c-wf">
                        <div class="net-wf">
                            <div
                                class={e.state === "pending" ? "net-wf-bar pending" : "net-wf-bar"}
                                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                            />
                        </div>
                    </td>
                );
        }
    }
}

type DetailTab = "headers" | "payload" | "response" | "wiretrick";

function Details({ e, width, onClose }: { e: NetEntry; width: number | null; onClose: () => void }) {
    const [tab, setTab] = useState<DetailTab>(e.outcomes.length ? "wiretrick" : "headers");
    const general: [string, string | undefined][] = [
        ["Request URL", e.url],
        ["Request Method", e.method],
        [
            "Status Code",
            e.state === "failed" ? e.error : e.status === null ? (e.synthetic ? "served by a script" : "pending") : `${e.status} ${e.statusText}`.trim(),
        ],
        ["Redirected To", e.redirectTo],
        ["Remote Address", e.ip],
        ["Type", typeLabel(e)],
        ["Content Type", e.mime || undefined],
        ["Initiator", e.initiator],
        ["Served From", e.fromCache ? "cache" : undefined],
        ["Duration", e.synthetic ? undefined : formatMs(duration(e))],
    ];
    return (
        <div class="net-details" style={width ? { flex: `0 0 ${width}px` } : undefined}>
            <div class="net-details-tabs">
                <button class="net-details-close" title="Close (Esc)" aria-label="Close details" onClick={onClose}>
                    ✕
                </button>
                <button class={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>
                    Headers
                </button>
                {e.requestBody && (
                    <button class={tab === "payload" ? "active" : ""} onClick={() => setTab("payload")}>
                        Payload
                    </button>
                )}
                <button class={tab === "response" ? "active" : ""} onClick={() => setTab("response")}>
                    Response
                </button>
                <button class={tab === "wiretrick" ? "active" : ""} onClick={() => setTab("wiretrick")}>
                    Wiretrick
                    {e.outcomes.length ? ` (${e.outcomes.length})` : ""}
                </button>
            </div>
            <div class="net-details-body">
                {tab === "headers" ? (
                    <>
                        <HeaderSection title="General" rows={general.filter((r): r is [string, string] => !!r[1])} />
                        <HeaderSection title="Response Headers" rows={e.responseHeaders} />
                        <HeaderSection title="Request Headers" rows={e.requestHeaders} />
                    </>
                ) : tab === "payload" ? (
                    <BodyView body={e.requestBody} mime={headerOf(e.requestHeaders, "content-type")} />
                ) : tab === "response" ? (
                    <ResponseView e={e} />
                ) : e.outcomes.length ? (
                    <ul class="net-actions">
                        {e.outcomes.map((i, n) => (
                            <li key={n} class={`net-action ${i.level} ${i.kind}`} title={KIND_TITLE[i.kind]}>
                                <time>{new Date(i.at).toLocaleTimeString()}</time>
                                <span class={`net-badge ${i.kind}`}>{i.scriptName}</span>
                                <span>{i.action}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div class="net-empty">No Wiretrick script handler ran on this request.</div>
                )}
            </div>
        </div>
    );
}

function headerOf(rows: [string, string][] | undefined, name: string): string {
    return rows?.find(([k]) => k.toLowerCase() === name)?.[1] || "";
}

/** JSON → pretty-printed; anything else verbatim */
export function prettyBody(text: string, mime: string): string {
    const t = text.trim();
    if (/json/i.test(mime) || /^[[{]/.test(t)) {
        try {
            return JSON.stringify(JSON.parse(t), null, 2);
        } catch {}
    }
    return text;
}

function BodyView({ body, mime }: { body?: NetBody; mime: string }) {
    if (!body) return <div class="net-empty">No body captured.</div>;
    if (body.binary) return <div class="net-empty">{body.text || `(binary, ${formatBytes(body.size)})`}</div>;
    return (
        <>
            {body.truncated && (
                <div class="net-note">
                    Showing the first {formatBytes(body.text.length)} of {formatBytes(body.size)}.
                </div>
            )}
            <pre class="net-payload">{prettyBody(body.text, mime)}</pre>
        </>
    );
}

function ResponseView({ e }: { e: NetEntry }) {
    const [which, setWhich] = useState<"modified" | "original">("modified");
    if (!e.responseBody)
        return (
            <div class="net-empty">
                Response body not available — browsers don't expose response bodies to extensions, so it is captured only for responses a Wiretrick script
                handled.
            </div>
        );
    const mime = e.mime || headerOf(e.responseHeaders, "content-type");
    if (!e.originalResponseBody) return <BodyView body={e.responseBody} mime={mime} />;
    return (
        <>
            <div class="net-body-switch" role="tablist">
                <button class={which === "modified" ? "net-chip active" : "net-chip"} onClick={() => setWhich("modified")}>
                    Modified (served)
                </button>
                <button class={which === "original" ? "net-chip active" : "net-chip"} onClick={() => setWhich("original")}>
                    Original
                </button>
            </div>
            <BodyView body={which === "modified" ? e.responseBody : e.originalResponseBody} mime={mime} />
        </>
    );
}

function HeaderSection({ title, rows }: { title: string; rows?: [string, string][] }) {
    const [open, setOpen] = useState(true);
    return (
        <section class="net-hsec">
            <h4 onClick={() => setOpen(!open)}>
                {open ? "▾" : "▸"} {title}
                {rows && title !== "General" ? <span class="net-count"> ({rows.length})</span> : null}
            </h4>
            {open &&
                (rows && rows.length ? (
                    <dl>
                        {rows.map(([k, v], n) => (
                            <div key={n} class="net-hrow">
                                <dt>{k}</dt>
                                <dd>{v}</dd>
                            </div>
                        ))}
                    </dl>
                ) : (
                    <div class="net-empty small">Not captured.</div>
                ))}
        </section>
    );
}
