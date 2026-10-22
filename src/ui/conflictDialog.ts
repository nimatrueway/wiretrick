/**
 * Save conflict: the stored script changed (folder sync, another tab) since
 * the editor loaded it. Shows theirs ↔ yours side by side and lets the user
 * overwrite, take the stored copy, or keep editing.
 *
 * The dialog takes focus so keystrokes can't reach the editor behind it.
 * Each choice has a one-letter shortcut; Esc keeps editing. Enter is not
 * bound, so a user still typing when it opens can't overwrite by accident.
 */

export type ConflictChoice = "overwrite" | "theirs" | "cancel";

export function resolveConflict(opts: { name: string; theirs: string | null; mine: string }): Promise<ConflictChoice> {
    const monaco = (window as any).monaco;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "conflict-dialog";
    const deleted = opts.theirs === null;
    overlay.innerHTML = `
        <div class="dialog wide conflict">
            <div class="dialog-head"><h2></h2><button class="btn-close" data-act="cancel">✕</button></div>
            <div class="dialog-body">
                <p class="muted conflict-intro"></p>
                <div class="conflict-diff"></div>
            </div>
            <div class="dialog-foot"><button data-act="cancel"></button><button data-act="theirs"></button><button class="primary" data-act="overwrite"></button></div>
        </div>`;
    overlay.querySelector("h2")!.textContent = deleted ? `"${opts.name}" was deleted` : `"${opts.name}" changed since you opened it`;
    overlay.querySelector(".conflict-intro")!.textContent = deleted
        ? "The script was deleted outside this editor (folder sync or another tab). Save recreates it with your text."
        : "Left: the stored version (changed outside this editor). Right: your unsaved text.";
    const keys: Record<string, ConflictChoice> = { escape: "cancel" };
    const label = (act: ConflictChoice, text: string, key: string) => {
        const btn = overlay.querySelector<HTMLButtonElement>(`.dialog-foot [data-act="${act}"]`)!;
        const i = text.toLowerCase().indexOf(key);
        const u = document.createElement("u");
        u.textContent = text[i];
        btn.append(text.slice(0, i), u, text.slice(i + 1));
        btn.title = `${text} (${key.toUpperCase()})`;
        btn.setAttribute("aria-keyshortcuts", key.toUpperCase());
        keys[key] = act;
    };
    label("cancel", "Keep editing", "k");
    if (deleted) {
        label("theirs", "Discard my text", "d");
        label("overwrite", "Recreate", "r");
    } else {
        label("theirs", "Take theirs", "t");
        label("overwrite", "Overwrite with mine", "o");
    }
    const dialog = overlay.querySelector<HTMLElement>(".dialog")!;
    dialog.tabIndex = -1;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const returnFocus = document.activeElement as HTMLElement | null;
    document.body.append(overlay);

    let diff: any = null;
    const disposables: any[] = [];
    const host = overlay.querySelector<HTMLElement>(".conflict-diff")!;
    if (deleted || !monaco) {
        host.remove();
    } else {
        const a = monaco.editor.createModel(opts.theirs, "typescript");
        const b = monaco.editor.createModel(opts.mine, "typescript");
        disposables.push(a, b);
        diff = monaco.editor.createDiffEditor(host, { readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false });
        diff.setModel({ original: a, modified: b });
    }

    dialog.focus();
    // Keys pressed in the first moments were meant for the editor, not for us.
    const armedAt = performance.now() + 250;

    return new Promise((resolve) => {
        const done = (c: ConflictChoice) => {
            diff?.dispose();
            for (const d of disposables) d.dispose();
            overlay.remove();
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("focusin", onFocus, true);
            returnFocus?.focus();
            resolve(c);
        };
        const onKey = (e: KeyboardEvent) => {
            if (!overlay.contains(e.target as Node)) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (e.key === "Tab") {
                e.preventDefault();
                const btns = [...overlay.querySelectorAll<HTMLButtonElement>(".dialog-foot button")];
                const i = btns.indexOf(document.activeElement as HTMLButtonElement);
                btns[e.shiftKey ? (i <= 0 ? btns.length - 1 : i - 1) : (i + 1) % btns.length].focus();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const act = keys[e.key.toLowerCase()];
            if (act && (e.key === "Escape" || performance.now() >= armedAt)) {
                e.preventDefault();
                e.stopPropagation();
                done(act);
            }
        };
        // App shortcuts (panel toggles, ⌘P, …) listen on document; keep them out while open.
        overlay.addEventListener("keydown", (e) => e.stopPropagation());
        const onFocus = (e: FocusEvent) => {
            if (!overlay.contains(e.target as Node)) dialog.focus();
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("focusin", onFocus, true);
        overlay.addEventListener("click", (e) => {
            const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act as ConflictChoice | undefined;
            if (act) done(act);
            else if (e.target === overlay) done("cancel");
        });
    });
}
