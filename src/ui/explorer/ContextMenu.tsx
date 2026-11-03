import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ref, useSnapshot } from "valtio";
import { explorer, type MenuItem } from "../state/explorer";

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
    explorer.menu = { x, y, items: ref(items) };
}

const close = (): void => void (explorer.menu = null);

/** The explorer's right-click menu (on the page, outside the tree, so its events don't reach the tree's handlers). */
export function ContextMenu() {
    const snap = useSnapshot(explorer, { sync: true });
    const menu = useRef<HTMLUListElement>(null);
    const open = snap.menu;
    useLayoutEffect(() => {
        const el = menu.current;
        if (!el || !open) return;
        el.style.left = `${Math.min(open.x, window.innerWidth - el.offsetWidth - 4)}px`;
        el.style.top = `${Math.min(open.y, window.innerHeight - el.offsetHeight - 4)}px`;
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const outside = (e: MouseEvent): void => {
            if (!menu.current?.contains(e.target as Node)) close();
        };
        const key = (e: KeyboardEvent): void => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close();
            document.querySelector<HTMLElement>("#script-list")?.focus();
        };
        document.addEventListener("mousedown", outside, true);
        document.addEventListener("keydown", key, true);
        window.addEventListener("blur", close);
        return () => {
            document.removeEventListener("mousedown", outside, true);
            document.removeEventListener("keydown", key, true);
            window.removeEventListener("blur", close);
        };
    }, [open]);
    if (!open) return null;
    return createPortal(
        <ul ref={menu} className="ctx-menu" role="menu">
            {open.items.map((item, i) =>
                item ? (
                    <li
                        key={i}
                        role="menuitem"
                        onClick={() => {
                            close();
                            item.run();
                        }}
                    >
                        <span>{item.label}</span>
                        {item.key && <span className="key">{item.key}</span>}
                    </li>
                ) : (
                    <li key={i} className="sep" />
                )
            )}
        </ul>,
        document.body
    );
}
