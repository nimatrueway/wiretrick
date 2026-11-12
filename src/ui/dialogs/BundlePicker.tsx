import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useSnapshot } from "valtio";
import { dialogs, type PickOptions } from "../state/dialogs";
import { FileIcon, indent, type Icon } from "../explorer/icons";
import { buildPickTree, checkState, pickTreeRows, setChecked, toggleNode, visibleLeaves, type PickItem, type PickNode } from "../pickTree";

/**
 * Tree of checkboxes for partial import/export: the files under their
 * folders (as in the Explorer), all checked by default; a folder's box
 * checks everything in it. The filter narrows the tree by path, and select
 * all/none act on what it shows. An optional live warning (e.g. a picked
 * script imports a library that isn't picked) has a fix button that checks
 * the missing items.
 */
export function BundlePicker() {
    const { picker } = useSnapshot(dialogs, { sync: true });
    if (!picker) return null;
    const finish = (v: number[] | null): void => {
        const req = dialogs.picker;
        if (!req) return;
        flushSync(() => void (dialogs.picker = null));
        if (v) req.opts.onConfirm?.(v);
        req.resolve(v);
    };
    return createPortal(<Picker key={picker.n} opts={picker.opts as PickOptions} finish={finish} />, document.body);
}

const iconOf = (it: PickItem | undefined, open: boolean | undefined): Icon => {
    if (!it || it.kind === "folder") return open ? "folder-open" : "folder";
    if (it.kind === "settings") return "yaml";
    if (it.kind === "section") return "section";
    if (it.kind === "data") return /\.svg$/i.test(it.path) ? "svg" : /\.(png|jpe?g|gif|webp|ico|avif)$/i.test(it.path) ? "img" : "json";
    return /\.tsx$/i.test(it.path) ? "tsx" : "ts";
};

function Picker({ opts, finish }: { opts: PickOptions; finish: (v: number[] | null) => void }) {
    const roots = useMemo(() => buildPickTree(opts.items), [opts]);
    const [checked, setCheckedState] = useState(() => opts.items.map((it) => it.checked !== false));
    const [query, setQuery] = useState("");
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
    // checks show at once: callers read the dialog right after a click
    const set = (next: boolean[]) => flushSync(() => setCheckedState(next));
    const sel = checked.flatMap((c, i) => (c ? [i] : []));
    const warn = opts.warn?.(sel) ?? null;
    const fix = warn?.fix ?? [];
    const rows = pickTreeRows(roots, query, collapsed);
    const filter = useRef<HTMLInputElement>(null);
    const latest = useRef({ sel, finish, query });
    latest.current = { sel, finish, query };
    useEffect(() => {
        filter.current!.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                if (latest.current.query && e.target === filter.current) {
                    e.preventDefault();
                    flushSync(() => setQuery(""));
                } else latest.current.finish(null);
            } else if (e.key === "Enter" && latest.current.sel.length) {
                e.preventDefault();
                latest.current.finish(latest.current.sel);
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);
    const shown = visibleLeaves(roots, query);
    const link = (act: "all" | "none", text: string) => (
        <a
            href="#"
            data-act={act}
            onClick={(e) => {
                e.preventDefault();
                set(setChecked(checked, shown, act === "all"));
            }}
        >
            {text}
        </a>
    );
    const toggleOpen = (n: PickNode) => {
        const next = new Set(collapsed);
        if (!next.delete(n.path)) next.add(n.path);
        setCollapsed(next);
    };
    return (
        <div id="bundle-picker" className="overlay" onMouseDown={(e) => void (e.target === e.currentTarget && finish(null))}>
            <div className="dialog">
                <div className="dialog-head">
                    <h2>{opts.title}</h2>
                    <button className="btn-close" data-act="cancel" onClick={() => finish(null)}>✕</button>
                </div>
                <div className="dialog-body">
                    {opts.intro && <p className="muted picker-intro">{opts.intro}</p>}
                    <input
                        ref={filter}
                        className="picker-filter"
                        type="search"
                        placeholder="Filter by path"
                        autoComplete="off"
                        spellCheck={false}
                        value={query}
                        onChange={(e) => flushSync(() => setQuery(e.target.value))}
                    />
                    <div className="picker-all">
                        {link("all", query.trim() ? "Select shown" : "Select all")} · {link("none", "None")}
                    </div>
                    <div className="picker-tree" role="tree">
                        {rows.map(({ node, depth, open }) => {
                            const it = node.item !== undefined && !node.children?.length ? opts.items[node.item] : undefined;
                            const state = checkState(node, checked, query);
                            const parent = open !== undefined;
                            return (
                                <div
                                    key={(it ? "f:" : "d:") + node.path}
                                    className={"picker-row" + (it ? "" : " folder") + (it?.removed ? " removed" : "")}
                                    data-path={node.path}
                                    role="treeitem"
                                    aria-expanded={parent ? open : undefined}
                                    title={it?.detail ? `${node.path}\n${it.detail}` : node.path}
                                    style={{ "--depth": String(depth) } as any}
                                >
                                    <span className="picker-twistie" onClick={() => parent && toggleOpen(node)}>
                                        {indent(depth, open)}
                                    </span>
                                    <label className="picker-hit">
                                        <input
                                            type="checkbox"
                                            checked={state === "on"}
                                            ref={(el) => void (el && (el.indeterminate = state === "mixed"))}
                                            onChange={() => set(toggleNode(node, checked, query))}
                                        />
                                        <FileIcon kind={iconOf(it, open)} />
                                        <span className="picker-label">{node.name}</span>
                                        {it?.badge && <span className="picker-badge">{it.badge}</span>}
                                        {it?.detail && <span className="picker-detail muted">{it.detail}</span>}
                                    </label>
                                </div>
                            );
                        })}
                        {!rows.length && <div className="picker-none muted">{opts.items.length ? "Nothing matches the filter" : "Nothing to pick"}</div>}
                    </div>
                    <div className="picker-warn" hidden={!warn}>
                        <span>{warn ? "⚠ " + warn.text : ""}</span>{" "}
                        <button data-act="fix" hidden={!fix.length} onClick={() => set(setChecked(checked, fix, true))}>Add them</button>
                    </div>
                </div>
                <div className="dialog-foot">
                    <span className="picker-count muted">{`${sel.length} of ${opts.items.length} selected`}</span>
                    <button data-act="cancel" onClick={() => finish(null)}>Cancel</button>
                    <button className="primary" data-act="ok" disabled={!sel.length} onClick={() => finish(sel)}>{opts.confirm}</button>
                </div>
            </div>
        </div>
    );
}
