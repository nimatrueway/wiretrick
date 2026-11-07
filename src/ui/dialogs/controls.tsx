import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

/**
 * A dialog's backdrop (`.overlay`, `.hidden` while closed): a press on the
 * backdrop itself closes it, as do its `[data-close]` buttons.
 */
export function Overlay(props: { id: string; open: boolean; onClose: () => void; children: ReactNode; extra?: HTMLAttributes<HTMLDivElement> }) {
    return (
        <div
            {...props.extra}
            id={props.id}
            className={props.open ? "overlay" : "overlay hidden"}
            onMouseDown={(e) => void (e.target === e.currentTarget && props.onClose())}
            onClick={(e) => void ((e.target as HTMLElement).closest("[data-close]") && props.onClose())}
        >
            {props.children}
        </div>
    );
}

type Control = HTMLInputElement | HTMLSelectElement;

/**
 * A form control showing a stored `value`. It stays uncontrolled and listens
 * natively, so a script setting `.value` and dispatching a (non-bubbling)
 * `change` commits like the user did — React's onChange misses those.
 * `event`: "input" commits every keystroke.
 */
export function useControl<T extends Control>(value: string | boolean, commit: (el: T) => void, event: "change" | "input" = "change") {
    const el = useRef<T>(null);
    const latest = useRef(commit);
    latest.current = commit;
    useLayoutEffect(() => {
        const c = el.current!;
        if (typeof value === "boolean") (c as HTMLInputElement).checked = value;
        else if (c.value !== value) c.value = value;
    }, [value]);
    useEffect(() => {
        const c = el.current!;
        const on = () => latest.current(c);
        c.addEventListener(event, on);
        return () => c.removeEventListener(event, on);
    }, [event]);
    return el;
}

/** A label that shows e.g. "Copied ✓" for 1.5 s: `[label or null, flash]`. */
export function useFlash(): [string | null, (text: string) => void] {
    const [text, setText] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    return [
        text,
        (t) => {
            setText(t);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setText(null), 1500);
        },
    ];
}

/** Every whitespace-separated word of `filter` is in `text` (case-insensitive). */
export function matchesFilter(text: string, filter: string): boolean {
    const t = text.toLowerCase();
    return filter
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => t.includes(w));
}
