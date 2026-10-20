/**
 * Network tab of the manager's bottom panel — a devtools-style request
 * table (filter, type chips, sortable columns, waterfall) with a details
 * pane showing headers and what Wiretrick scripts did to the request.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { NetBody, NetEntry } from "../../shared/netTypes";
import type { NetStore } from "./netStore";
import {
    TYPE_FILTERS,
    compare,
    displayName,
    duration,
    formatBytes,
    formatMs,
    matches,
    statusText,
    typeLabel,
    type NetFilter,
    type SortKey,
    type TypeFilter,
} from "./netFormat";

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

export function NetworkPanel({ store, listTabs }: { store: NetStore; listTabs?: () => Promise<TabInfo[]> }) {
    const [filter, setFilter] = useState<NetFilter>({ text: "", type: "all", interceptedOnly: false, tabId: null });
    const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "start", dir: 1 });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [tabs, setTabs] = useState<TabInfo[]>([]);
    const all = store.entries.value;

    const rows = useMemo(() => {
        const out = all.filter((e) => matches(e, filter));
        const cmp = compare(sort.key);
        out.sort((a, b) => cmp(a, b) * sort.dir || a.startedAt - b.startedAt);
        return out;
    }, [all, filter, sort]);

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

    const selected = selectedId ? all.find((e) => e.id === selectedId) || null : null;
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
        void listTabs?.().then((next) => setTabs((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)));
    useEffect(refreshTabs, []);
    const tabOptions =
        filter.tabId !== null && !tabs.some((t) => t.id === filter.tabId) ? [...tabs, { id: filter.tabId, title: `Tab ${filter.tabId} (closed)` }] : tabs;

    const intercepted = rows.filter((e) => e.interventions.length).length;
    const bytes = rows.reduce((n, e) => n + (e.size ?? 0), 0);

    return (
        <div class="net">
            <div class="net-toolbar">
                <button class="net-clear" title="Clear network log" aria-label="Clear network log" onClick={() => (store.clear(), setSelectedId(null))}>
                    ⊘
                </button>
                <input
                    class="net-filter"
                    type="text"
                    placeholder="Filter (prefix - to exclude)"
                    value={filter.text}
                    onInput={(e) => setFilter({ ...filter, text: e.currentTarget.value })}
                />
                <label class="net-check" title="Only requests a Wiretrick script acted on">
                    <input
                        type="checkbox"
                        checked={filter.interceptedOnly}
                        onChange={(e) => setFilter({ ...filter, interceptedOnly: e.currentTarget.checked })}
                    />
                    Intercepted only
                </label>
                {listTabs && (
                    <select
                        class="net-tab"
                        title="Show requests from one tab"
                        value={filter.tabId === null ? "" : String(filter.tabId)}
                        onFocus={refreshTabs}
                        onChange={(e) => setFilter({ ...filter, tabId: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })}
                    >
                        <option value="">All tabs</option>
                        {tabOptions.map((t) => (
                            <option key={t.id} value={String(t.id)}>
                                {t.title.length > 40 ? t.title.slice(0, 40) + "…" : t.title}
                            </option>
                        ))}
                    </select>
                )}
                <div class="net-chips" role="tablist">
                    {TYPE_FILTERS.map((t) => (
                        <button
                            key={t.id}
                            role="tab"
                            aria-selected={filter.type === t.id}
                            class={filter.type === t.id ? "net-chip active" : "net-chip"}
                            onClick={() => setFilter({ ...filter, type: t.id as TypeFilter })}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>
            <div class={selected ? "net-body with-details" : "net-body"}>
                <div
                    class="net-table-wrap"
                    ref={scroller}
                    onScroll={(e) => {
                        const el = e.currentTarget;
                        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                    }}
                >
                    <table class="net-table">
                        <thead>
                            <tr>
                                {COLUMNS.map((c) => (
                                    <th
                                        key={c.key}
                                        class={c.cls}
                                        aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                                        onClick={() => setSort(sort.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}
                                    >
                                        {c.label}
                                        {sort.key === c.key && <span class="net-sort">{sort.dir === 1 ? "▲" : "▼"}</span>}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((e) => (
                                <Row key={e.id} e={e} span={span} selected={e.id === selectedId} onSelect={() => setSelectedId(e.id === selectedId ? null : e.id)} />
                            ))}
                        </tbody>
                    </table>
                    {rows.length === 0 && (
                        <div class="net-empty">
                            {all.length === 0 ? "Recording network activity… reload a page to see its requests." : "No requests match the filter."}
                        </div>
                    )}
                </div>
                {selected && <Details e={selected} onClose={() => setSelectedId(null)} />}
            </div>
            <div class="net-status">
                {rows.length === all.length ? `${all.length} requests` : `${rows.length} / ${all.length} requests`}
                {" · "}
                {formatBytes(bytes)} transferred
                {" · "}
                <span class={intercepted ? "net-hl" : ""}>{intercepted} intercepted</span>
            </div>
        </div>
    );
}

function rowClass(e: NetEntry, selected: boolean): string {
    const c = ["net-row"];
    if (selected) c.push("selected");
    if (e.state === "failed" || (e.status !== null && e.status >= 400)) c.push("err");
    if (e.state === "pending") c.push("pending");
    if (e.interventions.length) c.push("intercepted");
    return c.join(" ");
}

function scriptNames(e: NetEntry): string[] {
    return [...new Set(e.interventions.map((i) => i.scriptName))];
}

function Row({ e, span, selected, onSelect }: { e: NetEntry; span: { t0: number; total: number }; selected: boolean; onSelect: () => void }) {
    const { name, host } = displayName(e.url);
    const ms = duration(e);
    const left = ((e.startedAt - span.t0) / span.total) * 100;
    const width = Math.max(0.5, (((e.endedAt ?? span.t0 + span.total) - e.startedAt) / span.total) * 100);
    return (
        <tr class={rowClass(e, selected)} onClick={onSelect} title={e.url}>
            <td class="c-name">
                <span class="net-name">{name}</span>
                <span class="net-host">{host}</span>
            </td>
            <td class="c-status">{statusText(e)}</td>
            <td class="c-method">{e.method}</td>
            <td class="c-type">{typeLabel(e)}</td>
            <td class="c-script">
                {scriptNames(e).map((n) => (
                    <span key={n} class="net-badge" title={e.interventions.filter((i) => i.scriptName === n).map((i) => i.action).join("\n")}>
                        {n}
                    </span>
                ))}
            </td>
            <td class="c-size">{e.fromCache ? "(cache)" : formatBytes(e.size)}</td>
            <td class="c-time">{e.synthetic ? "—" : formatMs(ms)}</td>
            <td class="c-wf">
                <div class="net-wf">
                    <div class={e.state === "pending" ? "net-wf-bar pending" : "net-wf-bar"} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
                </div>
            </td>
        </tr>
    );
}

type DetailTab = "headers" | "payload" | "response" | "wiretrick";

function Details({ e, onClose }: { e: NetEntry; onClose: () => void }) {
    const [tab, setTab] = useState<DetailTab>(e.interventions.length ? "wiretrick" : "headers");
    const general: [string, string | undefined][] = [
        ["Request URL", e.url],
        ["Request Method", e.method],
        ["Status Code", e.state === "failed" ? e.error : e.status === null ? (e.synthetic ? "served by a script" : "pending") : `${e.status} ${e.statusText}`.trim()],
        ["Redirected To", e.redirectTo],
        ["Remote Address", e.ip],
        ["Type", typeLabel(e)],
        ["Content Type", e.mime || undefined],
        ["Initiator", e.initiator],
        ["Served From", e.fromCache ? "cache" : undefined],
        ["Duration", e.synthetic ? undefined : formatMs(duration(e))],
    ];
    return (
        <div class="net-details">
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
                    Wiretrick{e.interventions.length ? ` (${e.interventions.length})` : ""}
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
                ) : e.interventions.length ? (
                    <ul class="net-actions">
                        {e.interventions.map((i, n) => (
                            <li key={n} class={`net-action ${i.level}`}>
                                <time>{new Date(i.at).toLocaleTimeString()}</time>
                                <span class="net-badge">{i.scriptName}</span>
                                <span>{i.action}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div class="net-empty">No Wiretrick script touched this request.</div>
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
            {body.truncated && <div class="net-note">Showing the first {formatBytes(body.text.length)} of {formatBytes(body.size)}.</div>}
            <pre class="net-payload">{prettyBody(body.text, mime)}</pre>
        </>
    );
}

function ResponseView({ e }: { e: NetEntry }) {
    const [which, setWhich] = useState<"modified" | "original">("modified");
    if (!e.responseBody)
        return (
            <div class="net-empty">
                Response body not available — browsers don't expose response bodies to extensions, so it is captured only for responses a Wiretrick
                script handled.
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
