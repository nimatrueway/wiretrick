import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSnapshot } from "valtio";
import { badgeCount } from "../logBadge";
import { extensionsLink, filterProblems, problemCounts, settingsLink, type Problem, type ProblemGroup } from "../problems";
import { actions } from "../shell/actions";
import { openSettings } from "../state/dialogs";
import { panel } from "../state/panel";

const ERROR_ICON = (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
);
const WARN_ICON = (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8 6.5v3.5M8 11.5v.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
);
const CHEVRON = (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

const pos = (p: Problem): string => (p.line ? `[Ln ${p.line}${p.column ? `, Col ${p.column}` : ""}]` : "");

/** a problem's message; a "Settings → Section" in it is a link that opens that section, a chrome://extensions URL one that opens the page */
function ProblemMessage({ text }: { text: string }) {
    const ext = extensionsLink(text);
    if (ext)
        return (
            <span className="pb-msg">
                {text.slice(0, ext.at)}
                <a
                    className="pb-link"
                    href="#"
                    tabIndex={-1}
                    title={`Open ${ext.text}`}
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // (a page can't link to chrome:// URLs; the extension can open them)
                        chrome.tabs.create({ url: ext.text }, () => void chrome.runtime.lastError);
                    }}
                >
                    {ext.text}
                </a>
                {text.slice(ext.at + ext.text.length)}
            </span>
        );
    const link = settingsLink(text);
    if (!link) return <span className="pb-msg">{text}</span>;
    return (
        <span className="pb-msg">
            {text.slice(0, link.at)}
            <a
                className="pb-link"
                href="#"
                tabIndex={-1}
                title={`Open ${link.text}`}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openSettings(link.section);
                }}
            >
                {link.text}
            </a>
            {text.slice(link.at + link.text.length)}
        </span>
    );
}

function groupTitle(g: ProblemGroup): string {
    const c = problemCounts([g]);
    return `${g.label}: ${[c.errors && `${c.errors} error${c.errors > 1 ? "s" : ""}`, c.warnings && `${c.warnings} warning${c.warnings > 1 ? "s" : ""}`].filter(Boolean).join(", ")}`;
}

/** The Problems view: a tree of files and their problems (VS Code's), keyboard-navigable with one tab stop. */
export function ProblemsView({ hidden }: { hidden: boolean }) {
    const snap = useSnapshot(panel);
    const all = snap.problems as ProblemGroup[];
    const groups = filterProblems(all, snap.problemsFilter);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    /** the row that is the list's tab stop */
    const [stop, setStop] = useState<string | null>(null);
    const list = useRef<HTMLDivElement>(null);
    const focusNext = useRef<string | null>(null);
    // a re-render that drops the focused row puts the focus on the tab stop
    const hadFocus = !!list.current?.contains(document.activeElement);

    const keys: string[] = [];
    for (const g of groups) {
        keys.push(`g:${g.id}`);
        if (!collapsed.has(g.id)) g.problems.forEach((_, i) => keys.push(`p:${g.id}:${i}`));
    }
    const tabStop = stop && keys.includes(stop) ? stop : keys[0];

    useLayoutEffect(() => {
        const want = focusNext.current ?? (hadFocus && !list.current!.contains(document.activeElement) ? tabStop : null);
        focusNext.current = null;
        if (want) list.current!.querySelector<HTMLElement>(`.pb-row[data-key="${CSS.escape(want)}"]`)?.focus();
    });

    const toggle = (id: string, open?: boolean): void => {
        const next = new Set(collapsed);
        if (open ?? collapsed.has(id)) next.delete(id);
        else next.add(id);
        setCollapsed(next);
        focusNext.current = `g:${id}`;
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        const rows = [...list.current!.querySelectorAll<HTMLElement>(".pb-row")];
        const cur = (e.target as HTMLElement).closest<HTMLElement>(".pb-row");
        if (!cur || !rows.length) return;
        const i = rows.indexOf(cur);
        const head = cur.classList.contains("pb-head");
        let next: HTMLElement | undefined;
        if (e.key === "ArrowDown") next = rows[Math.min(rows.length - 1, i + 1)];
        else if (e.key === "ArrowUp") next = rows[Math.max(0, i - 1)];
        else if (e.key === "Home") next = rows[0];
        else if (e.key === "End") next = rows[rows.length - 1];
        else if (head && (e.key === "ArrowLeft" || e.key === "ArrowRight")) toggle(cur.dataset.group!, e.key === "ArrowRight");
        else if (!head && e.key === "ArrowLeft") next = rows.slice(0, i).reverse().find((r) => r.classList.contains("pb-head"));
        else if (e.key === "Enter" || e.key === " ") cur.click();
        else return;
        e.preventDefault();
        next?.focus();
    };

    const rowProps = (key: string, level: number) => ({
        "data-key": key,
        tabIndex: key === tabStop ? 0 : -1,
        role: "treeitem",
        "aria-level": level,
        onFocus: () => setStop(key),
    });

    return (
        <div id="problems-view" hidden={hidden}>
            <div id="problems-list" ref={list} role="tree" aria-label="Problems" onKeyDown={onKeyDown}>
                {!groups.length ? (
                    <span className="problems-empty">{all.length ? "No results found with the provided filter." : "No problems have been detected in the scripts."}</span>
                ) : (
                    groups.flatMap((g) => {
                        const open = !collapsed.has(g.id);
                        const head = (
                            <div key={`g:${g.id}`} {...rowProps(`g:${g.id}`, 1)} className={`pb-row pb-head${open ? " open" : ""}`} data-group={g.id} aria-expanded={open} title={groupTitle(g)} onClick={() => toggle(g.id)}>
                                <span className="pb-chev">{CHEVRON}</span>
                                <span className={`file-icon ${g.file}`}>{g.file === "ts" ? "TS" : g.file === "json" ? "{}" : "⚙"}</span>
                                <span className="pb-file">{g.label}</span>
                                <span className="pb-count">{badgeCount(g.problems.length)}</span>
                            </div>
                        );
                        if (!open) return [head];
                        return [
                            head,
                            ...g.problems.map((p, i) => {
                                const sev = p.severity === "error" ? "error" : "warn";
                                return (
                                    <div
                                        key={`p:${g.id}:${i}`}
                                        {...rowProps(`p:${g.id}:${i}`, 2)}
                                        className={`pb-row pb-item ${sev}`}
                                        data-group={g.id}
                                        data-ctx={p.context}
                                        title={`${p.message}\n\n${g.label}${p.line ? ` ${pos(p)}` : ""} · ${p.kind}`}
                                        onClick={() => actions.openProblem(g.id, p)}
                                        onDoubleClick={() => actions.focusEditor()}
                                    >
                                        <span className={`pb-ico ${sev}`} role="img" aria-label={p.severity}>
                                            {p.severity === "error" ? ERROR_ICON : WARN_ICON}
                                        </span>
                                        <ProblemMessage text={p.message.split("\n")[0]} />
                                        <span className="pb-src">{p.kind}</span>
                                        {p.line ? <span className="pb-pos">{pos(p)}</span> : null}
                                        {p.dismissible ? (
                                            <button
                                                className="pb-dismiss"
                                                title="Dismiss this runtime error (saving the script clears it too)"
                                                aria-label="Dismiss"
                                                tabIndex={-1}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    actions.dismissError(g.id);
                                                }}
                                            >
                                                ✕
                                            </button>
                                        ) : null}
                                    </div>
                                );
                            }),
                        ];
                    })
                )}
            </div>
        </div>
    );
}
