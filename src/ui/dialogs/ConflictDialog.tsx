import { useLayoutEffect, useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { useSnapshot } from "valtio";
import { dialogs, type ConflictChoice, type ConflictOptions } from "../state/dialogs";

/**
 * Save conflict: the stored script (or data file) changed (folder sync, another tab) since
 * the editor loaded it. Shows theirs ↔ yours side by side and lets the user
 * overwrite, take the stored copy, or keep editing.
 *
 * The dialog takes focus so keystrokes can't reach the editor behind it.
 * Each choice has a one-letter shortcut; Esc keeps editing. Enter is not
 * bound, so a user still typing when it opens can't overwrite by accident.
 */
export function ConflictDialog() {
    const { conflict } = useSnapshot(dialogs, { sync: true });
    if (!conflict) return null;
    const done = (c: ConflictChoice): void => {
        const req = dialogs.conflict;
        if (!req) return;
        flushSync(() => void (dialogs.conflict = null));
        req.resolve(c);
    };
    return createPortal(<Conflict key={conflict.n} opts={conflict.opts as ConflictOptions} done={done} />, document.body);
}

/** "Take theirs", "t" → Take <u>t</u>heirs */
function Label({ text, k }: { text: string; k: string }) {
    const i = text.toLowerCase().indexOf(k);
    return (
        <>
            {text.slice(0, i)}
            <u>{text[i]}</u>
            {text.slice(i + 1)}
        </>
    );
}

function Conflict({ opts, done }: { opts: ConflictOptions; done: (c: ConflictChoice) => void }) {
    const deleted = opts.theirs === null;
    const buttons: [ConflictChoice, string, string][] = [
        ["cancel", "Keep editing", "k"],
        deleted ? ["theirs", "Discard my text", "d"] : ["theirs", "Take theirs", "t"],
        deleted ? ["overwrite", "Recreate", "r"] : ["overwrite", "Overwrite with mine", "o"],
    ];
    const overlay = useRef<HTMLDivElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const host = useRef<HTMLDivElement>(null);
    const latest = useRef(done);
    latest.current = done;
    const monaco = (window as any).monaco;
    const withDiff = !deleted && !!monaco;

    useLayoutEffect(() => {
        const returnFocus = document.activeElement as HTMLElement | null;
        const disposables: { dispose(): void }[] = [];
        if (withDiff) {
            const a = monaco.editor.createModel(opts.theirs, opts.language ?? "typescript");
            const b = monaco.editor.createModel(opts.mine, opts.language ?? "typescript");
            const diff = monaco.editor.createDiffEditor(host.current, { readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false });
            diff.setModel({ original: a, modified: b });
            disposables.push(diff, a, b);
        }
        const ov = overlay.current!;
        const dlg = dialog.current!;
        dlg.focus();
        // Keys pressed in the first moments were meant for the editor, not for us.
        const armedAt = performance.now() + 250;
        const keys: Record<string, ConflictChoice> = { escape: "cancel" };
        for (const [act, , k] of buttons) keys[k] = act;
        const onKey = (e: KeyboardEvent) => {
            if (!ov.contains(e.target as Node)) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (e.key === "Tab") {
                e.preventDefault();
                const btns = [...ov.querySelectorAll<HTMLButtonElement>(".dialog-foot button")];
                const i = btns.indexOf(document.activeElement as HTMLButtonElement);
                btns[e.shiftKey ? (i <= 0 ? btns.length - 1 : i - 1) : (i + 1) % btns.length].focus();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const act = keys[e.key.toLowerCase()];
            if (act && (e.key === "Escape" || performance.now() >= armedAt)) {
                e.preventDefault();
                e.stopPropagation();
                latest.current(act);
            }
        };
        // App shortcuts (panel toggles, ⌘P, …) listen on document; keep them out while open.
        const stop = (e: KeyboardEvent) => e.stopPropagation();
        const onFocus = (e: FocusEvent) => {
            if (!ov.contains(e.target as Node)) dlg.focus();
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("focusin", onFocus, true);
        ov.addEventListener("keydown", stop);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("focusin", onFocus, true);
            ov.removeEventListener("keydown", stop);
            for (const d of disposables) d.dispose();
            returnFocus?.focus();
        };
    }, []);

    return (
        <div
            id="conflict-dialog"
            className="overlay"
            ref={overlay}
            onClick={(e) => {
                const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act as ConflictChoice | undefined;
                if (act) done(act);
                else if (e.target === e.currentTarget) done("cancel");
            }}
        >
            <div className="dialog wide conflict" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true">
                <div className="dialog-head">
                    <h2>{deleted ? `"${opts.name}" was deleted` : `"${opts.name}" changed since you opened it`}</h2>
                    <button className="btn-close" data-act="cancel">✕</button>
                </div>
                <div className="dialog-body">
                    <p className="muted conflict-intro">{deleted ? `The ${opts.kind ?? "script"} was deleted outside this editor (folder sync or another tab). Save recreates it with your text.` : "Left: the stored version (changed outside this editor). Right: your unsaved text."}</p>
                    {withDiff && <div className="conflict-diff" ref={host} />}
                </div>
                <div className="dialog-foot">
                    {buttons.map(([act, text, k]) => (
                        <button key={act} className={act === "overwrite" ? "primary" : undefined} data-act={act} title={`${text} (${k.toUpperCase()})`} aria-keyshortcuts={k.toUpperCase()}>
                            <Label text={text} k={k} />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
