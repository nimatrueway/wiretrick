/**
 * MV3 offscreen document: the bridge between the service worker (which
 * cannot eval) and the sandbox iframe (the only eval-permitted context).
 *
 *   SW ⇄ chrome.runtime ⇄ HERE ⇄ window.postMessage ⇄ sandbox iframe
 *
 * Pure transport — no logic. All payloads are structured-cloneable JSON.
 */
const pending = new Map<string, Pending>();
let seq = 0;
const RPC_TIMEOUT = 20000;
/** the extension id, learned from the SW's first RPC — feeds the sandbox's chrome shim */
let extId: string | null = null;
/** true while the iframe reloads (extId learned → src rewrite → load event) */
let frameReloading = false;

function sandboxFrame(): HTMLIFrameElement | null {
    const frame = document.querySelector<HTMLIFrameElement>("#sb");
    if (frame && extId && frame.src.includes("__EXT_ID__")) {
        // first call after learning the id: reload the iframe so the shim
        // (built at document load) sees the real extension id
        frameReloading = true;
        frame.addEventListener("load", () => (frameReloading = false), { once: true });
        frame.src = `sandbox.html?extId=${encodeURIComponent(extId)}`;
    }
    return frame;
}

function forward(reqId: string, payload: any): void {
    const send = () => {
        const frame = document.querySelector<HTMLIFrameElement>("#sb");
        if (frame?.contentWindow) {
            frame.contentWindow.postMessage({ kind: "sandboxCall", reqId, payload }, "*");
        } else {
            dbg(`frame GONE for ${payload?.op}`);
            pending.get(reqId)?.resolve({ error: "sandbox iframe not ready" });
        }
    };
    if (frameReloading) {
        // the iframe is mid-reload (extId learned on this very call) — hold
        // the message until it's back, then forward
        const frame = document.querySelector<HTMLIFrameElement>("#sb");
        frame?.addEventListener("load", () => setTimeout(send, 50), { once: true });
        setTimeout(() => {
            if (pending.has(reqId)) send(); // load event missed (already loaded)
        }, 1500);
    } else {
        send();
    }
}

interface Pending {
    resolve: (r: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

function dbg(msg: string): void {
    try {
        chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "offscreen", msg } }, () => void chrome.runtime.lastError);
    } catch {}
}

function reqIdOf(msg: any): string {
    return msg?.reqId ?? "?";
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (!msg || msg.type !== "__resSandbox") return false;
    // the SW tags every call with its runtime.id — the first one teaches us
    // the id the sandbox's chrome shim should present (iframe reloads once)
    if (!extId && msg.extId) {
        extId = msg.extId;
        sandboxFrame();
    }
    const reqId = "sb_" + ++seq;
    const timer = setTimeout(() => {
        pending.delete(reqId);
        sendResponse({ error: "sandbox timeout" });
    }, RPC_TIMEOUT);
    pending.set(reqId, {
        resolve: (result) => {
            clearTimeout(timer);
            pending.delete(reqId);
            sendResponse(result);
        },
        timer,
    });
    forward(reqId, msg.payload);
    return true; // async sendResponse
});

window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || (data.kind !== "sandboxResult" && data.kind !== "reverse")) return;
    if (data.kind === "sandboxResult") {
        pending.get(data.reqId)?.resolve(data.result);
        return;
    }
    // reverse call from the sandbox: storage / logging — resolved by the SW
    chrome.runtime.sendMessage({ type: "__resReverse", payload: data }, (resp: any) => {
        if (data.op === "storageGet" || data.op === "storageSet") {
            const frame = document.querySelector<HTMLIFrameElement>("#sb");
            frame?.contentWindow?.postMessage({ kind: "reverseResult", reqId: data.reqId, result: resp || null }, "*");
        }
    });
});
