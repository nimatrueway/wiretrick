import { useLayoutEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { actions } from "../shell/actions";
import { dialogs } from "../state/dialogs";
import { filterQuickOpen } from "../quickOpen";

/** ⌘P: go to a script, data file or settings.json. Typing filters, ↑/↓/PageUp/PageDown move, Enter opens, Esc closes. */
export function QuickOpen() {
    const { quickOpen } = useSnapshot(dialogs);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);
    const scrollMoves = useRef(0);
    const lastMouse = useRef({ x: -1, y: -1 });
    useLayoutEffect(() => {
        if (!quickOpen) return;
        setQuery("");
        setActive(0);
        if (list.current) list.current.scrollTop = 0;
        input.current!.focus();
    }, [quickOpen]);
    useLayoutEffect(() => {
        if (!quickOpen || !scrollMoves.current) return;
        list.current?.querySelectorAll<HTMLElement>(".qo-item")[active]?.scrollIntoView?.({ block: "nearest" });
    }, [active, quickOpen]);
    const shown = quickOpen ? filterQuickOpen(actions.quickOpenItems(), query) : [];
    const pageRows = (): number => {
        const el = list.current;
        const row = el?.querySelector<HTMLElement>(".qo-item");
        if (!el || !row || !row.offsetHeight) return 10;
        return Math.max(1, Math.floor(el.clientHeight / row.offsetHeight) - 1);
    };
    const move = (next: number): void => {
        if (!shown.length) return;
        scrollMoves.current++;
        setActive(Math.max(0, Math.min(shown.length - 1, next)));
    };
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
                    placeholder="Go to a script, settings.json or stores.json…"
                    autoComplete="off"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                        if (list.current) list.current.scrollTop = 0;
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            move(active + 1);
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            move(active - 1);
                        } else if (e.key === "PageDown") {
                            e.preventDefault();
                            move(active + pageRows());
                        } else if (e.key === "PageUp") {
                            e.preventDefault();
                            move(active - pageRows());
                        } else if (e.key === "Enter") {
                            e.preventDefault();
                            pick(active);
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            dialogs.quickOpen = false;
                        }
                    }}
                />
                <ul id="qo-list" ref={list}>
                    {shown.map((item, i) => (
                        <li
                            key={item.id}
                            className={i === active ? "qo-item active" : "qo-item"}
                            data-id={item.id}
                            onClick={() => pick(i)}
                            onMouseMove={(e) => {
                                if (e.clientX === lastMouse.current.x && e.clientY === lastMouse.current.y) return;
                                lastMouse.current = { x: e.clientX, y: e.clientY };
                                setActive(i);
                            }}
                        >
                            {item.name}
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
