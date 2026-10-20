/**
 * Docking for the manager's Log/Network panel. Drag the panel header and
 * drop it on a highlighted target:
 *   bottom — under the editor
 *   right  — full height beside the editor
 *   left   — under the script list
 * Each dock keeps its own size; the splitter resizes the panel in place.
 */

export type Dock = "bottom" | "right" | "left";

interface DockLayout {
    dock?: Dock;
    /** panel size per dock: height for bottom/left, width for right */
    size?: Partial<Record<Dock, number>>;
}

const KEY = "resPanelDock";
const MIN = 80;

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function load(): DockLayout {
    try {
        const l = JSON.parse(localStorage.getItem(KEY) || "{}");
        if (l && typeof l === "object") return l;
    } catch {}
    return {};
}

function save(l: DockLayout): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(l));
    } catch {}
}

export function currentDock(): Dock {
    return (el("app").dataset.dock as Dock) || "bottom";
}

function applySize(dock: Dock, size: number | undefined): void {
    const panel = el("log-panel");
    panel.style.width = "";
    panel.style.height = "";
    if (size) {
        if (dock === "right") panel.style.width = `${size}px`;
        else panel.style.height = `${size}px`;
    }
}

/** Move the panel (and its splitter) into the container for `dock`. */
export function dockPanel(dock: Dock, persist = true): void {
    const panel = el("log-panel");
    const split = el("split-h");
    if (dock === "right") el("app").append(split, panel);
    else if (dock === "left") el("sidebar").append(split, panel);
    else el("editor-area").append(split, panel);
    el("app").dataset.dock = dock;
    const l = load();
    applySize(dock, l.size?.[dock]);
    if (persist) save({ ...l, dock });
    window.dispatchEvent(new Event("resize")); // nudge layout-dependent widgets
}

function clampSize(dock: Dock, size: number): number {
    if (dock === "right") return Math.min(window.innerWidth - 420, Math.max(240, size));
    if (dock === "left") return Math.min(el("sidebar").clientHeight - 120, Math.max(MIN, size));
    return Math.min(el("editor-area").clientHeight - 100, Math.max(MIN, size));
}

function makeSplitter(): void {
    const handle = el("split-h");
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const dock = currentDock();
        const panel = el("log-panel");
        const rect = panel.getBoundingClientRect();
        handle.classList.add("dragging");
        document.body.classList.add(dock === "right" ? "resizing-x" : "resizing-y");
        const move = (ev: MouseEvent) => {
            const raw = dock === "right" ? rect.right - ev.clientX : rect.bottom - ev.clientY;
            applySize(dock, clampSize(dock, raw));
        };
        const up = () => {
            handle.classList.remove("dragging");
            document.body.classList.remove("resizing-x", "resizing-y");
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            const l = load();
            const size = dock === "right" ? panel.offsetWidth : panel.offsetHeight;
            save({ ...l, size: { ...l.size, [dock]: size } });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
}

interface Target {
    dock: Dock;
    preview: { left: number; top: number; width: number; height: number };
}

/** Which dock the pointer is over, with the area the panel would occupy. */
export function dockTargetAt(x: number, y: number): Target | null {
    const side = el("sidebar").getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (x < side.right) {
        // lower part of the sidebar → under the script list
        if (y < side.top + side.height * 0.35) return null;
        const h = side.height * 0.5;
        return { dock: "left", preview: { left: side.left, top: side.bottom - h, width: side.width, height: h } };
    }
    const mainLeft = side.right;
    const mainW = W - mainLeft;
    if (x > mainLeft + mainW * 0.62) {
        const w = Math.max(320, mainW * 0.4);
        return { dock: "right", preview: { left: W - w, top: 0, width: w, height: H } };
    }
    if (y > H * 0.45) {
        const h = H * 0.4;
        return { dock: "bottom", preview: { left: mainLeft, top: H - h, width: mainW, height: h } };
    }
    return null;
}

function makeDraggable(): void {
    const header = el("log-header");
    header.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        // controls in the header (filters, buttons) keep their own behavior
        if ((e.target as HTMLElement).closest("button, input, select, option, textarea")) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        let dragging = false;
        let target: Target | null = null;
        const preview = document.createElement("div");
        preview.id = "dock-preview";
        const label = document.createElement("span");
        preview.appendChild(label);

        const move = (ev: MouseEvent) => {
            if (!dragging) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
                dragging = true;
                document.body.classList.add("dock-dragging");
                document.body.appendChild(preview);
            }
            target = dockTargetAt(ev.clientX, ev.clientY);
            preview.hidden = !target;
            if (target) {
                const p = target.preview;
                Object.assign(preview.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
                label.textContent = { bottom: "Dock below the editor", right: "Dock to the right", left: "Dock under the script list" }[target.dock];
            }
        };
        const end = (apply: boolean) => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            document.removeEventListener("keydown", key, true);
            document.body.classList.remove("dock-dragging");
            preview.remove();
            // a drag that started on a tab title must not also switch tabs
            if (dragging) document.addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true });
            if (apply && dragging && target && target.dock !== currentDock()) dockPanel(target.dock);
        };
        const up = () => end(true);
        const key = (ev: KeyboardEvent) => {
            if (ev.key === "Escape") {
                ev.stopPropagation();
                end(false);
            }
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        document.addEventListener("keydown", key, true);
    });
}

export function setupPanelDock(): void {
    let l = load();
    // migrate the old layout key's dock/height
    if (!l.dock) {
        try {
            const old = JSON.parse(localStorage.getItem("resPanelLayout") || "{}");
            l = { dock: old.logDock === "right" ? "right" : "bottom", size: old.logH ? { bottom: old.logH } : {} };
            save(l);
        } catch {}
    }
    dockPanel(l.dock || "bottom", false);
    makeSplitter();
    makeDraggable();
}
