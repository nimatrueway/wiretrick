/**
 * Docking for the manager's Log/Network panel. Drag the panel header and
 * drop it on a highlighted target:
 *   bottom — under the editor
 *   right  — full height beside the editor
 *   left   — under the script list
 * Each dock keeps its own size; the splitter resizes the panel in place.
 *
 * The script list (sidebar) itself docks to the left or right edge: drag
 * its header. A panel docked "left" lives inside the sidebar, so it follows.
 */

export type Dock = "bottom" | "right" | "left";
export type Side = "left" | "right";

interface DockLayout {
    dock?: Dock;
    /** which window edge the script list sits on */
    side?: Side;
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

export function currentSide(): Side {
    return (el("app").dataset.side as Side) || "left";
}

/** Put the script list on the `side` edge (CSS order on #app's children). */
export function dockSidebar(side: Side, persist = true): void {
    el("app").dataset.side = side;
    if (persist) save({ ...load(), side });
    window.dispatchEvent(new Event("resize"));
}

/** Track a press-drag-release with a 6px threshold and an Esc cancel. */
function trackDrag(e: MouseEvent, onMove: (ev: MouseEvent) => void, onEnd: (applied: boolean) => void): void {
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev: MouseEvent) => {
        if (!dragging) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
            dragging = true;
            document.body.classList.add("dock-dragging");
        }
        onMove(ev);
    };
    const end = (apply: boolean) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.removeEventListener("keydown", key, true);
        document.body.classList.remove("dock-dragging");
        // a drag that started on a tab title must not also switch tabs
        if (dragging) document.addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true });
        if (dragging) onEnd(apply);
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
}

function makePreview(): { show: (box: Target["preview"] | null, text?: string) => void; remove: () => void } {
    const preview = document.createElement("div");
    preview.id = "dock-preview";
    const label = document.createElement("span");
    preview.appendChild(label);
    return {
        show(box, text = "") {
            if (!preview.isConnected) document.body.appendChild(preview);
            preview.hidden = !box;
            if (!box) return;
            Object.assign(preview.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
            label.textContent = text;
        },
        remove: () => preview.remove(),
    };
}

/** Which edge a dragged script list would dock to. */
export function sidebarTargetAt(x: number): { side: Side; preview: Target["preview"] } {
    const w = el("sidebar").offsetWidth;
    const side: Side = x < window.innerWidth / 2 ? "left" : "right";
    return { side, preview: { left: side === "left" ? 0 : window.innerWidth - w, top: 0, width: w, height: window.innerHeight } };
}

function makeSidebarDraggable(): void {
    const header = el("brand");
    header.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button, input, select, option, textarea")) return;
        e.preventDefault();
        const preview = makePreview();
        let target: Side | null = null;
        trackDrag(
            e,
            (ev) => {
                const t = sidebarTargetAt(ev.clientX);
                target = t.side;
                preview.show(t.preview, t.side === "left" ? "Dock script list left" : "Dock script list right");
            },
            (apply) => {
                preview.remove();
                if (apply && target && target !== currentSide()) dockSidebar(target);
            }
        );
    });
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
    if (x >= side.left && x < side.right) {
        // lower part of the sidebar → under the script list
        if (y < side.top + side.height * 0.35) return null;
        const h = side.height * 0.5;
        return { dock: "left", preview: { left: side.left, top: side.bottom - h, width: side.width, height: h } };
    }
    // the editor area: whatever the script list doesn't cover
    const mainLeft = currentSide() === "left" ? side.right : 0;
    const mainRight = currentSide() === "left" ? W : side.left;
    const mainW = mainRight - mainLeft;
    if (x > mainLeft + mainW * 0.62) {
        const w = Math.max(320, mainW * 0.4);
        return { dock: "right", preview: { left: mainRight - w, top: 0, width: w, height: H } };
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
        const preview = makePreview();
        let target: Target | null = null;
        trackDrag(
            e,
            (ev) => {
                target = dockTargetAt(ev.clientX, ev.clientY);
                preview.show(target?.preview ?? null, target ? { bottom: "Dock below the editor", right: "Dock beside the editor", left: "Dock under the script list" }[target.dock] : "");
            },
            (apply) => {
                preview.remove();
                if (apply && target && target.dock !== currentDock()) dockPanel(target.dock);
            }
        );
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
    dockSidebar(l.side === "right" ? "right" : "left", false);
    dockPanel(l.dock || "bottom", false);
    makeSplitter();
    makeDraggable();
    makeSidebarDraggable();
}
