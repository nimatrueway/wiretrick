import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useSnapshot } from "valtio";
import { dialogs, type PickOptions } from "../state/dialogs";

/**
 * Checklist dialog for partial import/export: one row per item, all
 * checked by default, with select all/none and an optional live warning
 * (e.g. a picked script imports a library that isn't picked) whose fix
 * button checks the missing rows.
 */
export function BundlePicker() {
    const { picker } = useSnapshot(dialogs, { sync: true });
    if (!picker) return null;
    const finish = (v: number[] | null): void => {
        const req = dialogs.picker;
        if (!req) return;
        flushSync(() => void (dialogs.picker = null));
        req.resolve(v);
    };
    return createPortal(<Picker key={picker.n} opts={picker.opts as PickOptions} finish={finish} />, document.body);
}

function Picker({ opts, finish }: { opts: PickOptions; finish: (v: number[] | null) => void }) {
    const [checked, setChecked] = useState(() => opts.rows.map((r) => !r.disabled && r.checked !== false));
    // checks show at once: callers read the dialog right after a click
    const set = (next: boolean[]) => flushSync(() => setChecked(next));
    const sel = checked.flatMap((c, i) => (c ? [i] : []));
    const enabled = opts.rows.filter((r) => !r.disabled).length;
    const warn = opts.warn?.(sel) ?? null;
    const fix = warn?.fix ?? [];
    const ok = useRef<HTMLButtonElement>(null);
    const latest = useRef({ sel, finish });
    latest.current = { sel, finish };
    useEffect(() => {
        ok.current!.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                latest.current.finish(null);
            } else if (e.key === "Enter" && latest.current.sel.length) {
                e.preventDefault();
                latest.current.finish(latest.current.sel);
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);
    const bulk = (act: "all" | "none" | "fix") =>
        set(opts.rows.map((r, i) => (r.disabled ? checked[i] : act === "all" ? true : act === "none" ? false : checked[i] || fix.includes(i))));
    const link = (act: "all" | "none", text: string) => (
        <a
            href="#"
            data-act={act}
            onClick={(e) => {
                e.preventDefault();
                bulk(act);
            }}
        >
            {text}
        </a>
    );
    return (
        <div id="bundle-picker" className="overlay" onMouseDown={(e) => void (e.target === e.currentTarget && finish(null))}>
            <div className="dialog">
                <div className="dialog-head">
                    <h2>{opts.title}</h2>
                    <button className="btn-close" data-act="cancel" onClick={() => finish(null)}>✕</button>
                </div>
                <div className="dialog-body">
                    {opts.intro && <p className="muted picker-intro">{opts.intro}</p>}
                    <div className="picker-all">
                        {link("all", "Select all")} · {link("none", "None")}
                    </div>
                    <div className="picker-rows">
                        {opts.rows.map((r, i) => (
                            <label key={i} className={r.disabled ? "picker-row disabled" : "picker-row"}>
                                <input type="checkbox" checked={checked[i]} disabled={!!r.disabled} onChange={(e) => {
                                    const on = e.target.checked;
                                    flushSync(() => setChecked((prev) => prev.map((c, j) => (j === i ? on : c))));
                                }} />
                                <span>
                                    <span className="picker-label">{r.label}</span>
                                    {r.badge && <span className="picker-badge">{r.badge}</span>}
                                    {r.detail && <div className="picker-detail muted">{r.detail}</div>}
                                </span>
                            </label>
                        ))}
                    </div>
                    <div className="picker-warn" hidden={!warn}>
                        <span>{warn ? "⚠ " + warn.text : ""}</span>{" "}
                        <button data-act="fix" hidden={!fix.length} onClick={() => bulk("fix")}>Add them</button>
                    </div>
                </div>
                <div className="dialog-foot">
                    <span className="picker-count muted">{`${sel.length} of ${enabled} selected`}</span>
                    <button data-act="cancel" onClick={() => finish(null)}>Cancel</button>
                    <button className="primary" data-act="ok" ref={ok} disabled={!sel.length} onClick={() => finish(sel)}>{opts.confirm}</button>
                </div>
            </div>
        </div>
    );
}
