/** Toolbar icon while scripts are being compiled / hot-reloaded: faded, with a spinning arc in the corner. */

export interface BusyView {
    show(frame: number): void;
    hide(): void;
}

/**
 * Busy on/off → view. Work shorter than `showAfter` shows nothing; once shown
 * it stays at least `minShown` (back-to-back save → reload don't flicker).
 */
export function createBusyIndicator(view: BusyView, t = { showAfter: 150, minShown: 600, frameMs: 100 }) {
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let anim: ReturnType<typeof setInterval> | undefined;
    let shownAt = 0;
    const start = () => {
        showTimer = undefined;
        shownAt = Date.now();
        let frame = 0;
        view.show(frame);
        anim = setInterval(() => view.show(++frame), t.frameMs);
    };
    const stop = () => {
        hideTimer = undefined;
        clearInterval(anim);
        anim = undefined;
        view.hide();
    };
    return (busy: boolean): void => {
        if (busy) {
            clearTimeout(hideTimer);
            hideTimer = undefined;
            if (!anim && !showTimer) showTimer = setTimeout(start, t.showAfter);
        } else {
            clearTimeout(showTimer);
            showTimer = undefined;
            if (anim && !hideTimer) hideTimer = setTimeout(stop, Math.max(100, shownAt + t.minShown - Date.now()));
        }
    };
}

const IDLE_TITLE = "Wiretrick";
const BUSY_TITLE = "Wiretrick — applying script changes…";

/** Draws on the browser action (Chrome MV3 `action`, MV2/Firefox `browserAction`). */
export function actionIconView(): BusyView {
    const action = (chrome as any).browserAction ?? chrome.action;
    const manifest = chrome.runtime.getManifest() as any;
    const paths: Record<string, string> = (manifest.action ?? manifest.browser_action)?.default_icon ?? {};
    const sizes = Object.keys(paths).map(Number);
    let bitmaps: Promise<ImageBitmap[]> | undefined;
    const load = () => (bitmaps ??= Promise.all(sizes.map(async (s) => createImageBitmap(await (await fetch(chrome.runtime.getURL(paths[s]))).blob()))));
    let shown = false;
    const quiet = () => void (chrome.runtime as any).lastError;
    return {
        show(frame) {
            if (!shown) action.setTitle({ title: BUSY_TITLE }, quiet);
            shown = true;
            if (typeof OffscreenCanvas === "undefined" || !sizes.length) return;
            void load().then((bms) => {
                if (!shown) return; // hidden while loading
                const imageData: Record<number, ImageData> = {};
                sizes.forEach((s, i) => (imageData[s] = drawBusy(bms[i], s, frame)));
                action.setIcon({ imageData }, quiet);
            }, () => {});
        },
        hide() {
            if (!shown) return;
            shown = false;
            action.setIcon({ path: paths }, quiet);
            action.setTitle({ title: IDLE_TITLE }, quiet);
        },
    };
}

function drawBusy(icon: ImageBitmap, s: number, frame: number): ImageData {
    const g = new OffscreenCanvas(s, s).getContext("2d")!;
    g.globalAlpha = 0.5;
    g.drawImage(icon, 0, 0, s, s);
    g.globalAlpha = 1;
    // top-right: the badge count sits bottom-right
    const [cx, cy, r] = [s * 0.72, s * 0.28, s * 0.22];
    g.fillStyle = "#1e1e1e";
    g.beginPath();
    g.arc(cx, cy, r + s * 0.09, 0, 2 * Math.PI);
    g.fill();
    const a = (frame * Math.PI) / 4;
    g.strokeStyle = "#3794ff";
    g.lineWidth = Math.max(1.5, s * 0.1);
    g.lineCap = "round";
    g.beginPath();
    g.arc(cx, cy, r, a, a + 1.4 * Math.PI);
    g.stroke();
    return g.getImageData(0, 0, s, s);
}
