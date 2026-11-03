import { useLayoutEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { actions } from "../shell/actions";
import { dialogs } from "../state/dialogs";
import { filterQuickOpen } from "../quickOpen";

/** ⌘P: go to a script, data file or settings.yaml. Typing filters, ↑/↓ move, Enter opens, Esc closes. */
export function QuickOpen() {
    const { quickOpen } = useSnapshot(dialogs);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        if (!quickOpen) return;
        setQuery("");
        setActive(0);
        input.current!.focus();
    }, [quickOpen]);
    const shown = quickOpen ? filterQuickOpen(actions.quickOpenItems(), query) : [];
    const pick = (i: number): void => {
        const item = shown[i];
        dialogs.quickOpen = false;
        if (item) actions.openQuick(item.id);
    };
    return (
        <div id="quick-open" className={quickOpen ? "overlay" : "overlay hidden"} onMouseDown={(e) => void (e.target === e.currentTarget && (dialogs.quickOpen = false))}>
            <div className="dialog qo-dialog">
                <input
                    id="qo-input"
                    ref={input}
                    type="text"
                    placeholder="Go to a script or settings.yaml…"
                    autoComplete="off"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                    }}
                    onKeyDown={(e) => {
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
                            dialogs.quickOpen = false;
                        }
                    }}
                />
                <ul id="qo-list">
                    {shown.map((item, i) => (
                        <li key={item.id} className={i === active ? "qo-item active" : "qo-item"} data-id={item.id} onClick={() => pick(i)} onMouseMove={() => setActive(i)}>
                            {item.name}
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
