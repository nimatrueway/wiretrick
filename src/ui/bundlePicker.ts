/**
 * Checklist dialog for partial import/export: one row per item, all
 * checked by default, with select all/none and an optional live warning
 * (e.g. a picked script imports a library that isn't picked) whose fix
 * button checks the missing rows.
 */

export interface PickRow {
    label: string;
    detail?: string;
    /** short tag after the label, e.g. "library", "replaces existing" */
    badge?: string;
    checked?: boolean;
    disabled?: boolean;
}

export interface PickOptions {
    title: string;
    intro?: string;
    rows: PickRow[];
    confirm: string;
    warn?: (checked: number[]) => { text: string; fix?: number[] } | null;
}

/** Resolves with the checked row indices, or null when cancelled. */
export function pickRows(opts: PickOptions): Promise<number[] | null> {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "bundle-picker";
    overlay.innerHTML = `
        <div class="dialog">
            <div class="dialog-head"><h2></h2><button class="btn-close" data-act="cancel">✕</button></div>
            <div class="dialog-body">
                <p class="muted picker-intro"></p>
                <div class="picker-all"><a href="#" data-act="all">Select all</a> · <a href="#" data-act="none">None</a></div>
                <div class="picker-rows"></div>
                <div class="picker-warn" hidden><span></span> <button data-act="fix">Add them</button></div>
            </div>
            <div class="dialog-foot"><span class="picker-count muted"></span><button data-act="cancel">Cancel</button><button class="primary" data-act="ok"></button></div>
        </div>`;
    overlay.querySelector("h2")!.textContent = opts.title;
    const intro = overlay.querySelector<HTMLElement>(".picker-intro")!;
    if (opts.intro) intro.textContent = opts.intro;
    else intro.remove();
    const ok = overlay.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
    ok.textContent = opts.confirm;

    const boxes = opts.rows.map((r) => {
        const row = document.createElement("label");
        row.className = "picker-row" + (r.disabled ? " disabled" : "");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !r.disabled && r.checked !== false;
        box.disabled = !!r.disabled;
        const text = document.createElement("span");
        const name = document.createElement("span");
        name.className = "picker-label";
        name.textContent = r.label;
        text.append(name);
        if (r.badge) {
            const b = document.createElement("span");
            b.className = "picker-badge";
            b.textContent = r.badge;
            text.append(b);
        }
        if (r.detail) {
            const d = document.createElement("div");
            d.className = "picker-detail muted";
            d.textContent = r.detail;
            text.append(d);
        }
        row.append(box, text);
        overlay.querySelector(".picker-rows")!.append(row);
        return box;
    });

    const checked = () => boxes.flatMap((b, i) => (b.checked ? [i] : []));
    const warnEl = overlay.querySelector<HTMLElement>(".picker-warn")!;
    let fix: number[] = [];
    const update = () => {
        const sel = checked();
        ok.disabled = sel.length === 0;
        overlay.querySelector(".picker-count")!.textContent = `${sel.length} of ${boxes.filter((b) => !b.disabled).length} selected`;
        const w = opts.warn?.(sel) ?? null;
        warnEl.hidden = !w;
        fix = w?.fix ?? [];
        if (w) warnEl.querySelector("span")!.textContent = "⚠ " + w.text;
        warnEl.querySelector("button")!.hidden = !fix.length;
    };
    overlay.addEventListener("change", update);
    update();

    return new Promise((resolve) => {
        let done = false;
        const finish = (v: number[] | null) => {
            if (done) return;
            done = true;
            observer.disconnect();
            document.removeEventListener("keydown", onKey, true);
            overlay.remove();
            resolve(v);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                finish(null);
            } else if (e.key === "Enter" && !ok.disabled) {
                e.preventDefault();
                finish(checked());
            }
        };
        document.addEventListener("keydown", onKey, true);
        // the manager's global Escape handler hides overlays by class
        const observer = new MutationObserver(() => overlay.classList.contains("hidden") && finish(null));
        observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
        overlay.addEventListener("mousedown", (e) => e.target === overlay && finish(null));
        overlay.addEventListener("click", (e) => {
            const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
            if (!act) return;
            e.preventDefault();
            if (act === "cancel") finish(null);
            else if (act === "ok") finish(checked());
            else {
                boxes.forEach((b, i) => {
                    if (b.disabled) return;
                    if (act === "all") b.checked = true;
                    else if (act === "none") b.checked = false;
                    else if (act === "fix" && fix.includes(i)) b.checked = true;
                });
                update();
            }
        });
        document.body.append(overlay);
        ok.focus();
    });
}
