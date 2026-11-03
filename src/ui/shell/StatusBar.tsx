import { useLayoutEffect, type ReactNode } from "react";
import { useSnapshot } from "valtio";
import { badgeCount, type TabBadge } from "../logBadge";
import { keyHint } from "../shortcuts";
import { layout, panelTabOf, type PanelTab } from "../state/layout";
import { badges, panel } from "../state/panel";
import { actions } from "./actions";

const ICONS: Record<string, ReactNode> = {
    error: (
        <svg className="sb-ico error" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.3" /></svg>
    ),
    warn: (
        <svg className="sb-ico warn" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 6.5v3.5M8 11.5v.6" stroke="currentColor" strokeWidth="1.3" /></svg>
    ),
    modified: (
        <svg className="sb-ico modified" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor" /></svg>
    ),
    observed: (
        <svg className="sb-ico observed" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.6" /></svg>
    ),
};

const ITEMS: { view: PanelTab; id: string; label: string; aria: string; key: string; kind?: ReactNode }[] = [
    { view: "problems", id: "sb-problems", label: "Problems", aria: "Show the Problems view", key: "Alt+Shift+P" },
    {
        view: "log",
        id: "sb-log",
        label: "Log",
        aria: "Show the Log",
        key: "Alt+Shift+L",
        kind: <svg className="sb-kind" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>,
    },
    {
        view: "network",
        id: "sb-net",
        label: "Network",
        aria: "Show the Network view",
        key: "Alt+Shift+N",
        kind: <svg className="sb-kind" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    },
];

/** One item per panel view, with its counts; clicking opens that view (or closes the panel if it is open). */
export function StatusBar() {
    const p = useSnapshot(panel);
    const l = useSnapshot(layout, { sync: true });
    const open = !l.panelHidden && panelTabOf(l);
    void p.badgeVersion;
    useLayoutEffect(() => void document.body.classList.toggle("no-status", !p.statusBar), [p.statusBar]);
    return (
        <footer id="status-bar" aria-label="Status bar">
            {ITEMS.map((it, i) => {
                const badge: TabBadge = badges[it.view];
                const label = `${it.label} (${keyHint(it.key)})`;
                const on = open === it.view;
                return [
                    i ? " " : null,
                    <button
                        key={it.id}
                        id={it.id}
                        className={on ? "sb-item active" : "sb-item"}
                        data-panel={it.view}
                        title={badge.empty ? label : `${label} — ${badge.title}`}
                        aria-label={it.aria}
                        aria-pressed={on}
                        onClick={() => {
                            if (on) return actions.setPanelHidden(true);
                            if (l.panelHidden) actions.setPanelHidden(false);
                            actions.showPanelTab(it.view);
                        }}
                    >
                        {it.kind}
                        {it.kind ? <span className="sb-label">{it.label}</span> : null}
                        {badge.counts.map(([k, n]) => (
                            <span key={k} className={n > 0 ? "sb-pair on" : "sb-pair"}>
                                {ICONS[k]}
                                <span className="sb-n" data-k={k}>{badgeCount(n)}</span>
                            </span>
                        ))}
                    </button>,
                ];
            })}
        </footer>
    );
}
