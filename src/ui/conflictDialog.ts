/**
 * Save conflict: the stored script changed (folder sync, another tab) since
 * the editor loaded it. Shows theirs ↔ yours side by side and lets the user
 * overwrite, take the stored copy, or keep editing.
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
            <div class="dialog-foot"><button data-act="cancel">Keep editing</button><button data-act="theirs"></button><button class="primary" data-act="overwrite"></button></div>
        </div>`;
    overlay.querySelector("h2")!.textContent = deleted ? `"${opts.name}" was deleted` : `"${opts.name}" changed since you opened it`;
    overlay.querySelector(".conflict-intro")!.textContent = deleted
        ? "The script was deleted outside this editor (folder sync or another tab). Save recreates it with your text."
        : "Left: the stored version (changed outside this editor). Right: your unsaved text.";
    const theirsBtn = overlay.querySelector<HTMLButtonElement>('[data-act="theirs"]')!;
    const overBtn = overlay.querySelector<HTMLButtonElement>('[data-act="overwrite"]')!;
    theirsBtn.textContent = deleted ? "Discard my text" : "Take theirs";
    overBtn.textContent = deleted ? "Recreate" : "Overwrite with mine";
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

    return new Promise((resolve) => {
        const done = (c: ConflictChoice) => {
            diff?.dispose();
            for (const d of disposables) d.dispose();
            overlay.remove();
            document.removeEventListener("keydown", onKey, true);
            resolve(c);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                done("cancel");
            }
        };
        document.addEventListener("keydown", onKey, true);
        overlay.addEventListener("click", (e) => {
            const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act as ConflictChoice | undefined;
            if (act) done(act);
            else if (e.target === overlay) done("cancel");
        });
    });
}
